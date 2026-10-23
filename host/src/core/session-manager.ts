// The SessionManager: owns agent sessions on the host and turns what adapters report into Journal events
// (protocol-v1.md sections 5 to 7). It mints session, turn and user-message ids, keeps one adapter per
// live session, enforces one running turn per session (`session_busy`, `turn_mismatch`), lets the first
// resolution of a pending request win, and withdraws pending requests when a turn ends.
//
// Everything that changes a session goes through `append`, synchronously: node:sqlite commits before
// `append` returns and nothing awaits between a check and the append that depends on it, so two streams
// racing on one session cannot both pass a check (two turns, two resolutions).
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';

import type { Decision, InputPart, Settings, TurnError } from '../generated/common.js';
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
import type { Adapter, AdapterEvent, AgentProvider, FinalTurnStatus } from './adapter.js';
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
}

export interface StartParams {
  agentId: string;
  cwd: string;
  title?: string;
  settings?: Settings;
  input?: InputPart[];
}

interface RunningTurn {
  readonly turnId: string;
  readonly startedAt: number;
  readonly items: string[];
  /** Resolves once the engine accepted the turn's input; steer waits for it so it never overtakes the input. */
  delivered?: Promise<Adapter>;
  /** The engine started it by itself (adapter `turn/started`); a user `turn/start` joins it. */
  readonly engine: boolean;
}

/** In-memory state of a session the host has touched since it started. */
interface Live {
  readonly sessionId: string;
  adapter?: Adapter;
  ready?: Promise<Adapter>;
  off?: () => void;
  turn?: RunningTurn;
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

  constructor(options: SessionManagerOptions) {
    this.journal = options.journal;
    this.store = options.store ?? new SessionStore();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.onEvent = options.onEvent ?? (() => {});
    this.log = options.log ?? (() => {});
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
    return session;
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
    const sessions = first.sessions.filter((s) => this.visible(s));
    let next = first.nextCursor;
    while (sessions.length < limit && next !== undefined) {
      const page = this.journal.list({ ...options, cursor: next, limit: limit - sessions.length });
      sessions.push(...page.sessions.filter((s) => this.visible(s)));
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
  }

  /** Host shutdown: stops every engine without journaling; the next start recovers running turns. */
  async close(): Promise<void> {
    const adapters: Adapter[] = [];
    for (const live of this.live.values()) {
      if (live.adapter) adapters.push(live.adapter);
      this.detach(live);
    }
    await Promise.all(adapters.map((adapter) => this.kill(adapter)));
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
      await adapter.turnStart(input, clientMessageId);
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
      await adapter.turnStart(input, clientMessageId);
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
      await adapter.steer(input, clientMessageId);
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
    if (!live) this.live.set(sessionId, (live = { sessionId }));
    return live;
  }

  private earlierTurn(sessionId: string, clientMessageId: string): Turn | undefined {
    const turnId = this.store.turnFor(sessionId, clientMessageId);
    return turnId === undefined ? undefined : this.turn(sessionId, turnId);
  }

  /** Merges the adapter's effective settings into Session.settings; journals session/changed only on a change. */
  private reportSettings(sessionId: string, effective: Settings | undefined): void {
    const session = this.journal.session(sessionId);
    if (effective === undefined || session === undefined) return;
    const current = session.settings ?? {};
    const provider = this.providers.get(session.agentId);
    if (provider) effective = honoured(provider, effective);
    const settings = { ...current, ...effective };
    if (Object.entries(effective).every(([key, value]) => current[key] === value)) return;
    this.changeSession(sessionId, { settings });
  }

  /** Journals `session/changed` with the session as it is now plus `patch`. */
  private changeSession(sessionId: string, patch: Partial<Session>): void {
    const session: Session = {
      ...this.journal.session(sessionId)!,
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
    const running: RunningTurn = { turnId: newId('trn'), startedAt: this.now(), items: [], engine };
    live.turn = running;
    this.append(live.sessionId, {
      method: 'turn/started',
      params: {
        turn: { turnId: running.turnId, status: 'inProgress', startedAt: running.startedAt, completedAt: null, error: null, items: [] },
      },
    });
    return running;
  }

  private appendUserMessage(live: Live, input: InputPart[], clientMessageId: string): void {
    const turnId = live.turn!.turnId;
    const item: Item = { itemId: newId('itm'), type: 'userMessage', turnId, status: 'completed', content: input, clientMessageId };
    live.turn!.items.push(item.itemId);
    this.append(live.sessionId, { method: 'item/started', params: { item, turnId } });
    this.append(live.sessionId, { method: 'item/completed', params: { item, turnId } });
  }

  /** Ends the running turn: withdraws what is still pending, journals `turn/completed`, session idle. */
  private finishTurn(live: Live, status: FinalTurnStatus, error: TurnError | null): void {
    const running = live.turn;
    if (!running) return;
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
