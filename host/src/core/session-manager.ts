// The SessionManager: owns agent sessions on the host and turns what adapters report into Journal events
// (protocol-v1.md sections 5 to 7). It mints session, turn and user-message ids, keeps one adapter per
// live session, enforces one running turn per session (`session_busy`, `turn_mismatch`), lets the first
// resolution of a pending request win, and withdraws pending requests when a turn ends.
//
// Everything that changes a session goes through `append`, synchronously: node:sqlite commits before
// `append` returns and nothing awaits between a check and the append that depends on it, so two streams
// racing on one session cannot both pass a check (two turns, two resolutions).
//
// Background tasks (spec 5.1): for an agent with `capabilities.backgroundTasks` the adapter's
// `background/changed` list is held in memory and published as Session.backgroundTasks through
// `session/changed` (and in every summary the host hands out). It is live state, not history: after a
// host restart no engine runs, so no session reports any, and the start journals the tasks the last
// list still showed running as `cancelled` (clients replaying the Journal would show them running
// forever otherwise). A host shutdown kills the adapters while still listening, so the end they report
// is journaled too. A user message journaled while tasks run is marked `queued` until the adapter
// reports `input/taken` (or its turn ends).
//
// Settings changes (spec 6 `session/settings/update`): the new settings are journaled at once (they are
// the session record a restart or a resumed engine session starts from) and handed to the live adapter,
// which gives them to its engine before the next turn it starts; a running turn is never touched. After
// every turn start the adapter's effective settings are reported again, so a level the new model lacks
// shows as the engine fitted it.
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';

import { BLOB_PATH, type AttachmentStore } from '../attachments/store.js';
import type { BackgroundTask, Decision, InputPart, Settings, TurnError } from '../generated/common.js';
import type { TurnDiffResult } from '../generated/methods.js';
import type { Journal } from '../journal/journal.js';
import { CursorExpired } from '../journal/errors.js';
import { MAX_LIST_LIMIT, MAX_SINCE_LIMIT } from '../journal/journal.js';
import type {
  ApprovalRequest,
  EventInput,
  InputRequest,
  Item,
  JournalEvent,
  ListResult,
  Session,
  SessionStatus,
  SessionSummary,
  Turn,
} from '../journal/types.js';
import { RpcError } from '../errors.js';
import type { Adapter, AdapterEvent, AdapterInputPart, AgentProvider, FinalTurnStatus, SettingsUpdateKey } from './adapter.js';
import { newId } from './ids.js';
import { SessionStore } from './store.js';
import { TurnChanges } from './turn-changes.js';

/** Longest generated title (spec 6: the host may generate a title from the first input). */
export const TITLE_MAX = 60;
export const DEFAULT_TITLE = 'New session';
const DEFAULT_LIST = 50;

/** v1 title: the first input's text, whitespace collapsed, cut at TITLE_MAX characters. */
export function titleFrom(input: readonly InputPart[]): string {
  const text = input
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return DEFAULT_TITLE;
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
}

export interface SessionManagerOptions {
  journal: Journal;
  agents: readonly AgentProvider[];
  /** Core facts beside the Journal. Defaults to an in-memory store. */
  store?: SessionStore;
  /** Unix seconds. */
  now?: () => number;
  /** Called after every Journal append, in seq order (the host broadcasts `session/updated` from it). */
  onEvent?: (event: JournalEvent) => void;
  log?: (message: string, error?: unknown) => void;
  /** Longest a turn start waits for its git snapshot (turn/diff, spec 7). Default START_SNAPSHOT_WAIT_MS. */
  startSnapshotWaitMs?: number;
  /** Uploaded attachments (spec 8.1). Without a store every `/v1/blob` URL in input is `invalid_params`. */
  attachments?: AttachmentStore;
}

export interface StartParams {
  agentId: string;
  cwd: string;
  title?: string;
  settings?: Settings;
  input?: InputPart[];
}

/** What `session/settings/update` may change (spec 6). */
export type SettingsPatch = Partial<Record<SettingsUpdateKey, string>>;

interface RunningTurn {
  readonly turnId: string;
  readonly startedAt: number;
  readonly items: string[];
  /** Resolves once the engine accepted the turn's input; steer waits for it so it never overtakes the input. */
  delivered?: Promise<Adapter>;
  /** The engine started it by itself (adapter `turn/started`); a user `turn/start` joins it. */
  readonly engine: boolean;
  /** Its userMessage items journaled `queued`, by clientMessageId, until the engine takes them. */
  readonly queued: Map<string, Item>;
}

/** In-memory state of a session the host has touched since it started. */
interface Live {
  readonly sessionId: string;
  adapter?: Adapter;
  ready?: Promise<Adapter>;
  off?: () => void;
  turn?: RunningTurn;
  /** The adapter's background tasks (`background/changed`), published as Session.backgroundTasks. */
  tasks: BackgroundTask[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionManager {
  readonly journal: Journal;
  readonly store: SessionStore;
  readonly changes: TurnChanges;
  private readonly providers = new Map<string, AgentProvider>();
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;
  private readonly onEvent: (event: JournalEvent) => void;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly attachments: AttachmentStore | undefined;

  constructor(options: SessionManagerOptions) {
    this.journal = options.journal;
    this.store = options.store ?? new SessionStore();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.onEvent = options.onEvent ?? (() => {});
    this.log = options.log ?? (() => {});
    this.attachments = options.attachments;
    this.changes = new TurnChanges({
      store: this.store,
      log: this.log,
      ...(options.startSnapshotWaitMs !== undefined ? { startWaitMs: options.startSnapshotWaitMs } : {}),
    });
    for (const provider of options.agents) this.providers.set(provider.id, provider);
    this.recover();
  }

  // ---- agents ----------------------------------------------------------------------------------

  agents(): AgentProvider[] {
    return [...this.providers.values()];
  }

  /** The provider of `agentId`; `invalid_params` (at `path`) when the host has no such agent. */
  agent(agentId: string, at = 'params.agentId'): AgentProvider {
    const provider = this.providers.get(agentId);
    if (!provider) throw RpcError.invalidParams(at, `unknown agent ${JSON.stringify(agentId)}`);
    return provider;
  }

  /**
   * `not_supported` when the session's agent lacks `capability`, decided from the agent's static
   * capabilities, so no engine starts. An agent the host no longer has falls through: the operation
   * then answers `agent_unavailable` as before.
   */
  private requireCapability(agentId: string, capability: 'steer' | 'diff', what: string): void {
    const provider = this.providers.get(agentId);
    if (provider && !provider.capabilities[capability]) {
      throw new RpcError('not_supported', `agent ${agentId} ${what}`, { agentId });
    }
  }

  /**
   * The input as the session's adapter gets it (spec 8.1): every `/v1/blob` URL must name an attachment of
   * this session (`invalid_params` at the part's url otherwise), image blobs must be images, file parts
   * must be blobs. Blob parts gain the attachment's path and media type; an agent without image input
   * gets its image blobs as file parts. Data-URL images pass through unchanged.
   */
  private resolveInput(sessionId: string, agentId: string, input: readonly InputPart[]): AdapterInputPart[] {
    const accepts = this.providers.get(agentId)?.capabilities.attachments ?? { images: true, files: true };
    return input.map((part, n): AdapterInputPart => {
      if (part.type !== 'image' && part.type !== 'file') return part;
      const at = `params.input.${n}.url`;
      const isBlob = part.url.startsWith(`${BLOB_PATH}/`);
      if (part.type === 'image' && !isBlob) return part;
      const attachment = isBlob ? this.attachments?.resolve(sessionId, part.url) : undefined;
      if (attachment === undefined) {
        throw RpcError.invalidParams(at, `${part.url} is not an attachment of this session (upload it with POST ${BLOB_PATH})`);
      }
      if (part.type === 'image' && !attachment.mediaType.startsWith('image/')) {
        throw RpcError.invalidParams(at, `${part.url} is ${attachment.mediaType}, not an image; send it as a file part`);
      }
      const asFile = part.type === 'file' || !accepts.images;
      if (asFile && !accepts.files) throw new RpcError('not_supported', `agent ${agentId} takes no file attachments`, { agentId });
      if (asFile) return { type: 'file', url: part.url, name: attachment.name, mediaType: attachment.mediaType, path: attachment.path };
      return { ...part, path: attachment.path, mediaType: attachment.mediaType };
    });
  }

  private requireReady(provider: AgentProvider): void {
    const state = provider.state();
    if (state.status !== 'ready') {
      throw new RpcError('agent_unavailable', `agent ${provider.id} is ${state.status}`, {
        agentId: provider.id,
        reason: state.reason ?? state.status,
      });
    }
  }

  // ---- queries ---------------------------------------------------------------------------------

  /** The session (spec 5.1); `not_found` when unknown or deleted. */
  session(sessionId: string): Session {
    const session = this.journal.session(sessionId);
    if (!session || this.store.get(sessionId).deleted) {
      throw new RpcError('not_found', `no session ${sessionId}`, { sessionId });
    }
    return this.withTasks(session);
  }

  /** The session's list row as the host hands it out (with its background tasks), or undefined. */
  summary(sessionId: string): SessionSummary | undefined {
    const summary = this.journal.summary(sessionId);
    return summary === undefined ? undefined : this.withTasks(summary);
  }

  /** A summary or session with the live background tasks; without any, the field is left out. */
  private withTasks<T extends SessionSummary>(summary: T): T {
    const { backgroundTasks: _stored, ...rest } = summary;
    const tasks = this.live.get(summary.sessionId)?.tasks ?? [];
    return (tasks.length > 0 ? { ...rest, backgroundTasks: tasks.map((t) => ({ ...t })) } : rest) as T;
  }

  /** True when the session exists and is not deleted (the attachment endpoint, spec 8.1). */
  exists(sessionId: string): boolean {
    return this.journal.session(sessionId) !== undefined && !this.store.get(sessionId).deleted;
  }

  /** The running turn's id, if any. */
  runningTurnId(sessionId: string): string | undefined {
    return this.live.get(sessionId)?.turn?.turnId;
  }

  /** Sessions with a turn running right now (`host/status.sessionsActive`). */
  activeCount(): number {
    let count = 0;
    for (const live of this.live.values()) if (live.turn) count += 1;
    return count;
  }

  /** `session/list`: newest first, without archived or deleted sessions. */
  list(options: { agentId?: string; cursor?: string; limit?: number } = {}): ListResult {
    const first = this.journal.list({ ...options, limit: options.limit ?? DEFAULT_LIST });
    const limit = Math.min(options.limit ?? DEFAULT_LIST, MAX_LIST_LIMIT);
    const sessions = first.sessions.filter((s) => this.visible(s)).map((s) => this.withTasks(s));
    let next = first.nextCursor;
    while (sessions.length < limit && next !== undefined) {
      const page = this.journal.list({ ...options, cursor: next, limit: limit - sessions.length });
      sessions.push(...page.sessions.filter((s) => this.visible(s)).map((s) => this.withTasks(s)));
      next = page.nextCursor;
    }
    return next === undefined ? { sessions } : { sessions, nextCursor: next };
  }

  /** Every visible session, newest first (for `project/list`). */
  allSessions(): SessionSummary[] {
    return this.everySession().filter((s) => this.visible(s));
  }

  private everySession(): SessionSummary[] {
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = this.journal.list(cursor === undefined ? { limit: MAX_LIST_LIMIT } : { cursor, limit: MAX_LIST_LIMIT });
      out.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  private visible(summary: SessionSummary): boolean {
    const record = this.store.get(summary.sessionId);
    return !record.archived && !record.deleted;
  }

  /** A turn as the protocol returns it; the running turn lists the items seen so far. */
  turn(sessionId: string, turnId: string): Turn | undefined {
    const turn = this.journal.turn(sessionId, turnId);
    const running = this.live.get(sessionId)?.turn;
    if (turn && running?.turnId === turnId) return { ...turn, items: [...running.items] };
    return turn;
  }

  // ---- session lifecycle -----------------------------------------------------------------------

  /** `session/start`: creates the session and, with `input`, starts its first turn (one round trip). */
  async start(params: StartParams): Promise<{ session: Session; turn?: Turn }> {
    const provider = this.agent(params.agentId);
    this.requireReady(provider);
    if (!path.isAbsolute(params.cwd) || !isDirectory(params.cwd)) {
      throw RpcError.invalidParams('params.cwd', `cwd must be an absolute path to a directory: ${params.cwd}`);
    }
    // A new session has no attachments yet: an attachment URL in its first input can only be refused.
    if (params.input) this.resolveInput('', provider.id, params.input);
    const sessionId = newId('ses');
    const now = this.now();
    const title = params.title ?? (params.input ? titleFrom(params.input) : '');
    const session: Session = {
      sessionId,
      agentId: provider.id,
      title,
      cwd: params.cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastSeq: 1,
      pending: { approvals: 0, inputs: 0 },
      settings: honoured(provider, params.settings ?? {}),
    };
    this.append(sessionId, { method: 'session/changed', params: { session } });
    const live = this.liveOf(sessionId);
    if (!params.input) {
      try {
        await this.ensureAdapter(live);
      } catch (error) {
        this.setStatus(sessionId, 'error');
        throw error;
      }
      return { session: this.session(sessionId) };
    }
    const turn = await this.turnStart(sessionId, params.input, randomUUID());
    return { session: this.session(sessionId), turn };
  }

  /** `session/rename`: journals `session/changed` with the new title. */
  rename(sessionId: string, title: string): void {
    this.session(sessionId);
    this.changeSession(sessionId, { title });
  }

  /**
   * `session/settings/update` (spec 6): `not_supported` for a key the agent cannot change in an open
   * session, `invalid_params` for a model its model list does not offer. Journals the new settings and
   * hands them to the live adapter; they apply from the next turn (a running turn keeps its own).
   */
  async updateSettings(sessionId: string, patch: SettingsPatch): Promise<Session> {
    const summary = this.session(sessionId);
    const provider = this.providers.get(summary.agentId);
    const allowed: readonly string[] = provider?.capabilities.settingsUpdate ?? [];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) {
        const name = provider?.name ?? summary.agentId;
        throw new RpcError('not_supported', `${name} cannot change the ${key} of an open session`, { agentId: summary.agentId, setting: key });
      }
    }
    if (patch.model !== undefined && provider) await this.requireModel(provider, patch.model);
    const current = this.session(sessionId).settings ?? {};
    const settings: Settings = { ...current, ...patch };
    if (Object.entries(patch).every(([key, value]) => current[key] === value)) return this.session(sessionId);
    this.changeSession(sessionId, { settings });
    const adapter = this.live.get(sessionId)?.adapter;
    adapter?.changeSettings?.({ ...settings });
    return this.session(sessionId);
  }

  /** `invalid_params` when the agent lists its models and `model` is not one of them. */
  private async requireModel(provider: AgentProvider, model: string): Promise<void> {
    let models;
    try {
      models = await provider.models();
    } catch (error) {
      // Without a list the engine decides when the change reaches it.
      this.log(`agent ${provider.id}: cannot list models to check ${model}`, error);
      return;
    }
    if (models.length > 0 && !models.some((m) => m.id === model)) {
      throw RpcError.invalidParams('params.settings.model', `${provider.name} offers no model ${model}`);
    }
  }

  /** `session/archive`: ends any running turn, stops the engine, journals `session/closed {reason: "archived"}`. */
  async archive(sessionId: string): Promise<void> {
    this.session(sessionId);
    if (this.store.get(sessionId).archived) return;
    this.store.setArchived(sessionId, true);
    await this.shutdown(sessionId);
    this.append(sessionId, { method: 'session/closed', params: { reason: 'archived' } });
  }

  /** `session/delete`: like archive with `reason: "deleted"`; afterwards the session is `not_found`. */
  async delete(sessionId: string): Promise<void> {
    this.session(sessionId);
    this.store.markDeleted(sessionId);
    await this.shutdown(sessionId);
    this.append(sessionId, { method: 'session/closed', params: { reason: 'deleted' } });
    this.live.delete(sessionId);
    await this.attachments?.deleteSession(sessionId);
  }

  /**
   * Host shutdown: stops every engine; the next start recovers running turns. The adapters stay attached
   * while they are killed, so the background tasks they end (spec 5.1) are journaled.
   */
  async close(): Promise<void> {
    const lives = [...this.live.values()];
    await Promise.all(
      lives.map(async (live) => {
        const adapter = live.adapter;
        if (adapter) await this.kill(adapter);
      }),
    );
    for (const live of lives) this.detach(live);
  }

  // ---- turns -----------------------------------------------------------------------------------

  /**
   * `turn/start` (spec 7). A repeated `clientMessageId` returns the turn it started the first time. While
   * an engine-initiated turn runs, the message joins that turn (the engine takes it mid-turn).
   */
  async turnStart(sessionId: string, input: InputPart[], clientMessageId: string): Promise<Turn> {
    const summary = this.session(sessionId);
    const earlier = this.earlierTurn(sessionId, clientMessageId);
    if (earlier) return earlier;
    const live = this.liveOf(sessionId);
    if (live.turn?.engine) return this.joinEngineTurn(live, summary.agentId, input, clientMessageId);
    if (live.turn) {
      throw new RpcError('session_busy', `a turn is running in ${sessionId}`, { turnId: live.turn.turnId });
    }
    const resolved = this.resolveInput(sessionId, summary.agentId, input);
    if (this.store.get(sessionId).archived) this.store.setArchived(sessionId, false);
    if (summary.title === '') this.changeSession(sessionId, { title: titleFrom(input) });

    const running = this.openTurn(live, false);
    const turnId = running.turnId;
    this.store.rememberClientMessage(sessionId, clientMessageId, turnId);
    this.appendUserMessage(live, input, clientMessageId);
    this.setStatus(sessionId, 'running');
    // The start snapshot (turn/diff) runs alongside the engine start and is sealed before the input goes out.
    const snapshot = this.changes.begin(sessionId, turnId, summary.cwd);
    running.delivered = (async () => {
      const adapter = await this.ensureAdapter(live);
      await snapshot.seal();
      await adapter.turnStart(resolved, clientMessageId);
      // A settings change reaches the engine at a turn start: report what is in effect now.
      this.reportSettings(sessionId, adapter.effectiveSettings?.());
      return adapter;
    })();
    try {
      await running.delivered;
    } catch (error) {
      const failure = this.unavailable(summary.agentId, error);
      if (live.turn === running) this.finishTurn(live, 'failed', { code: 'agent_unavailable', message: failure.message });
      throw failure;
    }
    return this.turn(sessionId, turnId)!;
  }

  /** A user message for the engine-initiated turn that is running: journaled in it, handed to the engine. */
  private async joinEngineTurn(live: Live, agentId: string, input: InputPart[], clientMessageId: string): Promise<Turn> {
    const running = live.turn!;
    const sessionId = live.sessionId;
    const resolved = this.resolveInput(sessionId, agentId, input);
    const ready = running.delivered ?? Promise.reject(new Error('the engine is not attached'));
    const adapter = await ready.catch((error: unknown) => {
      throw this.unavailable(agentId, error);
    });
    if (live.turn !== running) {
      // The engine turn ended while the adapter was looked up: start a turn of its own.
      return this.turnStart(sessionId, input, clientMessageId);
    }
    this.store.rememberClientMessage(sessionId, clientMessageId, running.turnId);
    this.appendUserMessage(live, input, clientMessageId);
    try {
      await adapter.turnStart(resolved, clientMessageId);
    } catch (error) {
      throw this.unavailable(agentId, error);
    }
    return this.turn(sessionId, running.turnId)!;
  }

  /** `turn/steer` (spec 7): adds input to the running turn. */
  async steer(sessionId: string, turnId: string, input: InputPart[], clientMessageId: string): Promise<Turn> {
    const summary = this.session(sessionId);
    const earlier = this.earlierTurn(sessionId, clientMessageId);
    if (earlier) return earlier;
    const live = this.liveOf(sessionId);
    const running = live.turn;
    if (!running || running.turnId !== turnId) {
      throw new RpcError('turn_mismatch', `turn ${turnId} is not the running turn of ${sessionId}`, {
        turnId: running?.turnId ?? null,
      });
    }
    this.requireCapability(summary.agentId, 'steer', 'cannot steer a running turn');
    const resolved = this.resolveInput(sessionId, summary.agentId, input);
    // A running turn has its input on the way to the engine (turnStart), unless the boot just failed and
    // the turn is about to be failed. Steer waits for that delivery, so it never reaches the engine first.
    const ready = running.delivered ?? Promise.reject(new Error('the engine is not attached'));
    const adapter = await ready.catch((error: unknown) => {
      throw this.unavailable(summary.agentId, error);
    });
    if (live.turn !== running) {
      throw new RpcError('turn_mismatch', `turn ${turnId} ended`, { turnId: live.turn?.turnId ?? null });
    }
    this.store.rememberClientMessage(sessionId, clientMessageId, turnId);
    this.appendUserMessage(live, input, clientMessageId);
    try {
      await adapter.steer(resolved, clientMessageId);
    } catch (error) {
      throw this.unavailable(summary.agentId, error);
    }
    return this.turn(sessionId, turnId)!;
  }

  /**
   * `turn/interrupt` (spec 7): withdraws the turn's pending requests and asks the engine to stop; the
   * adapter's `turn/completed {status: "interrupted"}` ends the turn. Interrupting a finished turn is ok.
   */
  async interrupt(sessionId: string, turnId: string): Promise<void> {
    this.session(sessionId);
    const live = this.liveOf(sessionId);
    const running = live.turn;
    if (!running || running.turnId !== turnId) {
      if (this.journal.turn(sessionId, turnId)) return;
      throw new RpcError('not_found', `no turn ${turnId} in ${sessionId}`, { sessionId, turnId });
    }
    this.withdrawPending(sessionId);
    this.refreshStatus(live);
    try {
      const adapter = await live.ready!;
      await adapter.interrupt();
    } catch (error) {
      // The engine cannot confirm: end the turn here so the session does not stay busy forever.
      this.log(`session ${sessionId}: interrupt failed; ending the turn locally`, error);
      if (live.turn === running) this.finishTurn(live, 'interrupted', null);
    }
  }

  /**
   * `turn/diff` (spec 7): the host's git snapshots of the session folder, the same for every agent. No
   * engine is involved, so a dormant session stays dormant.
   */
  async diff(sessionId: string, turnId: string): Promise<TurnDiffResult> {
    const summary = this.session(sessionId);
    if (!this.journal.turn(sessionId, turnId)) {
      throw new RpcError('not_found', `no turn ${turnId} in ${sessionId}`, { sessionId, turnId });
    }
    this.requireCapability(summary.agentId, 'diff', 'cannot compute a turn diff');
    return this.changes.diff(sessionId, turnId, summary.cwd, this.runningTurnId(sessionId) === turnId);
  }

  // ---- pending requests ------------------------------------------------------------------------

  /** `approval/resolve` (spec 5.3): first resolution wins, everyone else gets `already_resolved`. */
  async resolveApproval(sessionId: string, requestId: string, decision: Decision, resolvedBy: string): Promise<void> {
    this.session(sessionId);
    const request = this.journal.pending(sessionId).approvals.find((r) => r.requestId === requestId);
    if (!request) throw this.notPending(sessionId, requestId, 'approval');
    if (!request.availableDecisions.includes(decision)) {
      throw RpcError.invalidParams(
        'params.decision',
        `decision ${decision} is not offered; available: ${request.availableDecisions.join(', ')}`,
      );
    }
    this.append(sessionId, {
      method: 'request/resolved',
      params: { requestId, kind: request.kind, resolvedBy, decision },
    });
    const live = this.liveOf(sessionId);
    this.refreshStatus(live);
    await this.forward(live, 'resolveApproval', (adapter) => adapter.resolveApproval(requestId, decision));
  }

  /** `input/answer` (spec 5.3): same rules as `approval/resolve`. */
  async answerInput(
    sessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
    resolvedBy: string,
  ): Promise<void> {
    this.session(sessionId);
    const request = this.journal.pending(sessionId).inputs.find((r) => r.requestId === requestId);
    if (!request) throw this.notPending(sessionId, requestId, 'input');
    this.append(sessionId, {
      method: 'request/resolved',
      params: { requestId, kind: 'input', resolvedBy, answers },
    });
    const live = this.liveOf(sessionId);
    this.refreshStatus(live);
    await this.forward(live, 'answerInput', (adapter) => adapter.answerInput(requestId, answers));
  }

  /** Hands a resolution to the engine. The Journal already holds it, so a failure is logged, not thrown. */
  private async forward(live: Live, what: string, call: (adapter: Adapter) => Promise<void>): Promise<void> {
    const adapter = live.adapter;
    if (!adapter) return;
    try {
      await call(adapter);
    } catch (error) {
      this.log(`session ${live.sessionId}: ${what} failed in the adapter`, error);
    }
  }

  /** `already_resolved {resolvedBy}` when the request was resolved earlier, else `not_found`. */
  private notPending(sessionId: string, requestId: string, family: 'approval' | 'input'): RpcError {
    const resolved = this.findResolution(sessionId, requestId);
    if (resolved && (resolved.kind === 'input') === (family === 'input')) {
      return new RpcError('already_resolved', `request ${requestId} was already resolved`, {
        resolvedBy: resolved.resolvedBy,
      });
    }
    return new RpcError('not_found', `no pending ${family} request ${requestId} in ${sessionId}`, { requestId });
  }

  private findResolution(sessionId: string, requestId: string): { kind: string; resolvedBy: string } | undefined {
    let cursor = 0;
    try {
      for (;;) {
        const page = this.journal.since(sessionId, cursor, MAX_SINCE_LIMIT);
        for (const event of page.events) {
          if (event.method === 'request/resolved' && event.params.requestId === requestId) {
            return { kind: event.params.kind, resolvedBy: event.params.resolvedBy };
          }
        }
        if (page.complete) return undefined;
        cursor = page.cursor;
      }
    } catch (error) {
      if (error instanceof CursorExpired) return undefined;
      throw error;
    }
  }

  /** Every pending request of the session is journaled as resolved by "agent" with decision "cancel". */
  private withdrawPending(sessionId: string): void {
    const pending = this.journal.pending(sessionId);
    for (const request of [...pending.approvals, ...pending.inputs]) this.withdraw(sessionId, request);
  }

  private withdraw(sessionId: string, request: ApprovalRequest | InputRequest): void {
    this.append(sessionId, {
      method: 'request/resolved',
      params: { requestId: request.requestId, kind: request.kind, resolvedBy: 'agent', decision: 'cancel' },
    });
  }

  // ---- adapter events --------------------------------------------------------------------------

  private onAdapterEvent(live: Live, adapter: Adapter, event: AdapterEvent): void {
    if (live.adapter !== adapter) return; // a killed or replaced adapter
    const sessionId = live.sessionId;
    switch (event.method) {
      case 'status/changed':
        this.setStatus(sessionId, event.params.status);
        return;
      case 'engine/session':
        this.store.setEngineSessionId(sessionId, event.params.engineSessionId);
        return;
      case 'background/changed':
        if (this.providers.get(this.journal.session(sessionId)?.agentId ?? '')?.capabilities.backgroundTasks !== true) return;
        this.setTasks(live, event.params.tasks);
        return;
      case 'input/taken':
        if (live.turn) this.unqueue(live, live.turn, event.params.clientMessageId);
        return;
      case 'usage/updated':
        this.append(sessionId, { method: 'usage/updated', params: { usage: event.params.usage } });
        return;
      case 'turn/started':
        // The engine started a turn by itself (a background task reported in).
        if (live.turn) return;
        {
          const running = this.openTurn(live, true);
          // The engine already runs, so steer and a joining message wait on the adapter itself.
          running.delivered = live.ready;
          // Best-effort start snapshot for turn/diff: no input to hold back, so it is not sealed.
          this.changes.begin(sessionId, running.turnId, this.session(sessionId).cwd);
        }
        this.setStatus(sessionId, 'running');
        return;
      case 'agent/exited': {
        this.detach(live);
        if (live.turn) this.finishTurn(live, 'failed', { code: 'agent_exited', message: event.params.reason });
        this.setStatus(sessionId, 'error');
        return;
      }
      default:
        break;
    }
    const running = live.turn;
    if (!running) {
      this.log(`session ${sessionId}: dropped ${event.method} from the adapter: no turn is running`);
      return;
    }
    const turnId = running.turnId;
    switch (event.method) {
      case 'item/started':
      case 'item/completed': {
        const item = { ...event.params.item, turnId } as Item;
        if (!running.items.includes(item.itemId)) running.items.push(item.itemId);
        this.append(sessionId, { method: event.method, params: { item, turnId } });
        return;
      }
      case 'item/delta':
        this.append(sessionId, { method: 'item/delta', params: { ...event.params, turnId } });
        return;
      case 'approval/request': {
        const request = {
          ...event.params.request,
          sessionId,
          turnId,
          createdAt: this.now(),
          expiresAt: event.params.request.expiresAt ?? null,
        } as ApprovalRequest;
        this.append(sessionId, { method: 'approval/request', params: { request } });
        this.refreshStatus(live);
        return;
      }
      case 'input/request': {
        const request = { ...event.params.request, sessionId, turnId } as InputRequest;
        this.append(sessionId, { method: 'input/request', params: { request } });
        this.refreshStatus(live);
        return;
      }
      case 'request/withdrawn': {
        const pending = this.journal.pending(sessionId);
        const request = [...pending.approvals, ...pending.inputs].find((r) => r.requestId === event.params.requestId);
        if (request) this.withdraw(sessionId, request);
        this.refreshStatus(live);
        return;
      }
      case 'turn/completed':
        this.finishTurn(live, event.params.status, event.params.error ?? null);
        return;
    }
  }

  // ---- internals -------------------------------------------------------------------------------

  private append(sessionId: string, input: EventInput): JournalEvent {
    const event = this.journal.append(sessionId, input);
    try {
      this.onEvent(event);
    } catch (error) {
      this.log(`session ${sessionId}: event observer failed on ${event.method}`, error);
    }
    return event;
  }

  private liveOf(sessionId: string): Live {
    let live = this.live.get(sessionId);
    if (!live) this.live.set(sessionId, (live = { sessionId, tasks: [] }));
    return live;
  }

  private earlierTurn(sessionId: string, clientMessageId: string): Turn | undefined {
    const turnId = this.store.turnFor(sessionId, clientMessageId);
    return turnId === undefined ? undefined : this.turn(sessionId, turnId);
  }

  /**
   * Merges the adapter's effective settings into Session.settings; journals session/changed only on a
   * change. The adapter's report is authoritative for `effort` (spec 5.1): a report without one means no
   * level is in effect, so a requested level the model ignores is dropped.
   */
  private reportSettings(sessionId: string, effective: Settings | undefined): void {
    const session = this.journal.session(sessionId);
    if (effective === undefined || session === undefined) return;
    const current = session.settings ?? {};
    const provider = this.providers.get(session.agentId);
    if (provider) effective = honoured(provider, effective);
    const { effort: _requested, ...rest } = current;
    const settings: Settings = { ...rest, ...effective };
    const same = (a: Settings, b: Settings): boolean =>
      Object.keys({ ...a, ...b }).every((key) => a[key] === b[key]);
    if (same(settings, current)) return;
    this.changeSession(sessionId, { settings });
  }

  /** Journals `session/changed` with the session as it is now plus `patch`. */
  private changeSession(sessionId: string, patch: Partial<Session>): void {
    const session: Session = {
      ...this.withTasks(this.journal.session(sessionId)!),
      ...patch,
      updatedAt: this.now(),
      lastSeq: this.journal.head(sessionId) + 1,
    };
    this.append(sessionId, { method: 'session/changed', params: { session } });
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    if (this.journal.summary(sessionId)?.status === status) return;
    this.append(sessionId, { method: 'status/changed', params: { status } });
  }

  /** While a turn runs, status follows the pending requests: waiting for an approval, an answer, or running. */
  private refreshStatus(live: Live): void {
    if (!live.turn) return;
    const pending = this.journal.summary(live.sessionId)!.pending;
    this.setStatus(
      live.sessionId,
      pending.approvals > 0 ? 'waiting_approval' : pending.inputs > 0 ? 'waiting_input' : 'running',
    );
  }

  /** Mints the turn id, makes it the running turn, journals `turn/started`. */
  private openTurn(live: Live, engine: boolean): RunningTurn {
    const running: RunningTurn = { turnId: newId('trn'), startedAt: this.now(), items: [], engine, queued: new Map() };
    live.turn = running;
    this.append(live.sessionId, {
      method: 'turn/started',
      params: {
        turn: { turnId: running.turnId, status: 'inProgress', startedAt: running.startedAt, completedAt: null, error: null, items: [] },
      },
    });
    return running;
  }

  /** Journals the user's message; while background tasks run it is `queued` until the engine takes it. */
  private appendUserMessage(live: Live, input: InputPart[], clientMessageId: string): void {
    const running = live.turn!;
    const turnId = running.turnId;
    const item: Item = { itemId: newId('itm'), type: 'userMessage', turnId, status: 'completed', content: input, clientMessageId };
    if (live.tasks.some((t) => t.status === 'running')) {
      item.queued = true;
      running.queued.set(clientMessageId, item);
    }
    running.items.push(item.itemId);
    this.append(live.sessionId, { method: 'item/started', params: { item, turnId } });
    this.append(live.sessionId, { method: 'item/completed', params: { item, turnId } });
  }

  /** A queued message the engine took (or whose turn ended): journaled again without `queued`. */
  private unqueue(live: Live, running: RunningTurn, clientMessageId: string): void {
    const queued = running.queued.get(clientMessageId);
    if (queued === undefined) return;
    running.queued.delete(clientMessageId);
    const { queued: _flag, ...item } = queued as Item & { queued?: boolean };
    this.append(live.sessionId, { method: 'item/completed', params: { item: item as Item, turnId: running.turnId } });
  }

  /** Publishes the adapter's background tasks: journals session/changed when the list changed. */
  private setTasks(live: Live, tasks: BackgroundTask[]): void {
    if (JSON.stringify(tasks) === JSON.stringify(live.tasks)) return;
    live.tasks = tasks.map((t) => ({ ...t }));
    if (this.journal.session(live.sessionId) === undefined) return;
    this.changeSession(live.sessionId, {});
  }

  /** Ends the running turn: withdraws what is still pending, journals `turn/completed`, session idle. */
  private finishTurn(live: Live, status: FinalTurnStatus, error: TurnError | null): void {
    const running = live.turn;
    if (!running) return;
    for (const clientMessageId of [...running.queued.keys()]) this.unqueue(live, running, clientMessageId);
    live.turn = undefined;
    const cwd = this.journal.session(live.sessionId)?.cwd;
    if (cwd !== undefined) this.changes.end(live.sessionId, running.turnId, cwd);
    this.withdrawPending(live.sessionId);
    this.append(live.sessionId, {
      method: 'turn/completed',
      params: {
        turn: {
          turnId: running.turnId,
          status,
          startedAt: running.startedAt,
          completedAt: this.now(),
          error,
          items: [...running.items],
        },
      },
    });
    this.setStatus(live.sessionId, 'idle');
  }

  /**
   * The session's adapter, created and started (new engine session) or resumed (known engine session id)
   * on first use. Concurrent callers share one boot. A failed boot leaves no adapter behind.
   */
  private ensureAdapter(live: Live): Promise<Adapter> {
    if (live.ready) return live.ready;
    const session = this.journal.session(live.sessionId)!;
    const provider = this.providers.get(session.agentId);
    if (!provider) {
      return Promise.reject(
        new RpcError('agent_unavailable', `agent ${session.agentId} is not available on this host`, {
          agentId: session.agentId,
          reason: 'not installed',
        }),
      );
    }
    try {
      this.requireReady(provider);
    } catch (error) {
      return Promise.reject(error);
    }
    const adapter = provider.createAdapter();
    live.adapter = adapter;
    live.off = adapter.onEvent((event) => this.onAdapterEvent(live, adapter, event));
    const engineSessionId = this.store.get(live.sessionId).engineSessionId;
    const boot = async (): Promise<Adapter> => {
      if (engineSessionId !== '') {
        await adapter.resume(engineSessionId, session.cwd, session.settings);
      } else {
        const id = await adapter.start(session.cwd, session.settings);
        if (id !== '') this.store.setEngineSessionId(live.sessionId, id);
      }
      this.reportSettings(live.sessionId, adapter.effectiveSettings?.());
      return adapter;
    };
    live.ready = boot().catch((error: unknown) => {
      if (live.adapter === adapter) this.detach(live);
      void this.kill(adapter);
      throw this.unavailable(session.agentId, error);
    });
    return live.ready;
  }

  private detach(live: Live): void {
    live.off?.();
    live.off = undefined;
    live.adapter = undefined;
    live.ready = undefined;
  }

  private async kill(adapter: Adapter): Promise<void> {
    try {
      await adapter.kill();
    } catch (error) {
      this.log('adapter kill failed', error);
    }
  }

  /** Archive and delete: interrupt the running turn in the Journal and stop the engine. */
  private async shutdown(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    if (live.turn) this.finishTurn(live, 'interrupted', null);
    // Stopping the engine stops its helpers too; the killed adapter reports nothing more.
    if (live.tasks.some((t) => t.status === 'running')) {
      const now = this.now();
      this.setTasks(live, live.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'cancelled', endedAt: now } : t)));
    }
    const adapter = live.adapter;
    this.detach(live);
    if (adapter) await this.kill(adapter);
  }

  private unavailable(agentId: string, error: unknown): RpcError {
    if (error instanceof RpcError) return error;
    return new RpcError('agent_unavailable', `agent ${agentId} failed: ${errorMessage(error)}`, {
      agentId,
      reason: errorMessage(error),
    });
  }

  /**
   * After a host restart no engine is attached: turns that were running are journaled as failed, their
   * pending requests withdrawn, and the sessions set idle, so clients never wait on a dead prompt.
   */
  private recover(): void {
    for (const summary of this.everySession()) {
      this.recoverTasks(summary.sessionId);
      const busy = summary.status === 'running' || summary.status === 'waiting_approval' || summary.status === 'waiting_input';
      if (!busy && summary.pending.approvals + summary.pending.inputs === 0) continue;
      const sessionId = summary.sessionId;
      const newest = this.journal.snapshot(sessionId, 1).turns[0];
      this.withdrawPending(sessionId);
      if (newest && newest.status === 'inProgress') {
        this.append(sessionId, {
          method: 'turn/completed',
          params: {
            turn: {
              turnId: newest.turnId,
              status: 'failed',
              startedAt: newest.startedAt,
              completedAt: this.now(),
              error: { code: 'host_restarted', message: 'the host restarted while this turn was running' },
              items: newest.items.map((item) => item.itemId),
            },
          },
        });
      }
      if (busy) this.setStatus(sessionId, 'idle');
    }
  }

  /**
   * After a restart the engines and their helpers are gone: when the session's last journaled list still
   * shows running tasks, a session/changed lists them `cancelled` (spec 5.1). Summaries list none.
   */
  private recoverTasks(sessionId: string): void {
    if (this.store.get(sessionId).deleted) return;
    const last = this.journal.lastEvent(sessionId, 'session/changed');
    const tasks = last?.method === 'session/changed' ? (last.params.session.backgroundTasks ?? []) : [];
    if (!tasks.some((task) => task.status === 'running')) return;
    const now = this.now();
    const ended = tasks.map((task) => (task.status === 'running' ? { ...task, status: 'cancelled' as const, endedAt: Math.max(task.startedAt, now) } : { ...task }));
    const session: Session = {
      ...this.journal.session(sessionId)!,
      backgroundTasks: ended,
      updatedAt: now,
      lastSeq: this.journal.head(sessionId) + 1,
    };
    this.append(sessionId, { method: 'session/changed', params: { session } });
  }
}


/**
 * `settings` without an `approvalMode` the agent does not honour (spec 5.1): the session then neither
 * stores nor reports a mode its agent ignores (Pi honours none, so a Pi session never shows "Bypass").
 */
function honoured(provider: AgentProvider, settings: Settings): Settings {
  const mode = settings.approvalMode;
  if (mode === undefined || provider.capabilities.approvalModes.includes(mode)) return settings;
  const { approvalMode: _dropped, ...rest } = settings;
  return rest;
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
