// The Replica (CONTEXT.md; ADR 0002; spec 5 to 7): the phone's local copy of the session list and of
// each opened session's Journal. It renders from local storage at once, then on every new stream
// (connect and every reconnect) calls session/open for the open session with its cursor and applies
// the answer: events mode applies the missing events, snapshot mode replaces the state. Live events are
// applied strictly in seq order; anything at or below the cursor is ignored, a gap is buffered and
// filled with events/since, and cursor_expired falls back to a snapshot.
//
// Views are plain objects mutated in place; `version` increases and subscribers are called after every
// change, so a UI can re-read what it shows.
import type {
  EventsSinceResult,
  HostStatus,
  ModelInfo,
  ModelListResult,
  SessionSettingsUpdateParams,
  SessionSettingsUpdateResult,
  SessionListResult,
  SessionHistoryResult,
  SessionOpenResult,
  SessionStartParams,
  SessionStartResult,
  TurnDiffResult,
  TurnStartResult,
  TurnSteerResult,
} from '../generated/methods';
import type { ClientState, RequestOptions } from '../stream/client';
import { RequestError } from '../stream/client';
import { applyEvent, optimisticId, reconcile, replacePending, replaceWithSnapshot } from './apply';
import { DEFAULT_STORAGE_KEY, defaultStorage, load, save, type StorageLike } from './storage';
import {
  emptyView,
  type Decision,
  type InputPart,
  type JournalEvent,
  type Session,
  type SessionSummary,
  type SessionView,
  type TurnView,
} from './types';

/** What the Replica needs from the stream client; StreamClient fits. */
export interface ReplicaTransport {
  readonly state: ClientState;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  on(event: 'ready', listener: () => void): () => void;
  on(event: 'suspend', listener: () => void): () => void;
  onNotification(method: string, handler: (params: Record<string, unknown>, method: string) => void): () => void;
}

export interface ReplicaOptions {
  client: ReplicaTransport;
  /** Defaults to localStorage when present; null disables persistence. */
  storage?: StorageLike | null;
  storageKey?: string;
  /** Writes are coalesced for this long (deltas arrive fast); suspend and flush() write at once. */
  persistDelayMs?: number;
  /** `turns` for session/open snapshots; the host default (5) when absent. */
  snapshotTurns?: number;
  /** events/since page size. */
  catchUpLimit?: number;
  newClientMessageId?: () => string;
  /** Seconds since the epoch, for optimistic turns' startedAt. */
  now?: () => number;
}

/** How approval/resolve or input/answer ended, when the prompt is gone (spec 5.3, spec 10). */
export type ResolveOutcome = { status: 'ok' } | { status: 'already_resolved'; resolvedBy?: string } | { status: 'not_found' };

/** Who resolved a request: a clientId, or "agent" when the agent withdrew it. */
export interface Resolution {
  resolvedBy: string;
  decision?: Decision;
  /** A question's answers, when request/resolved carried them. */
  answers?: Record<string, string[]>;
}

const RESOLUTIONS_KEPT = 200;

/** Errors that leave an optimistic send in `sending`: the next stream retries it (same clientMessageId). */
const RETRY_LATER: ReadonlySet<string> = new Set(['connection_lost', 'timeout']);

type Sequenced = JournalEvent;

function isSequenced(params: Record<string, unknown>): boolean {
  return typeof params.sessionId === 'string' && typeof params.seq === 'number';
}

function summaryOf(session: Session): SessionSummary {
  const { settings: _settings, ...summary } = session;
  return summary;
}

/** The row with `archived: true`, or without the field. */
function withArchived(summary: SessionSummary, archived: boolean): SessionSummary {
  const { archived: _was, ...rest } = summary;
  return archived ? { ...rest, archived: true } : rest;
}

export class Replica {
  private readonly client: ReplicaTransport;
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly persistDelayMs: number;
  private readonly options: ReplicaOptions;
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly views = new Map<string, SessionView>();
  private openId: string | undefined;
  private hostStatusValue: HostStatus | undefined;
  private nextCursor: string | undefined;
  private versionValue = 0;
  private lastErrorValue: RequestError | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  /**
   * Sessions this Replica deleted or archived; `settled` once the host answered. Stopping a turn and its
   * helpers makes the host journal changes, so a session/updated can still be in flight: until a
   * session/list asked after the answer lists the session again, an update for a deleted one is dropped
   * and one for an archived one stays out of the main list. Not persisted.
   */
  private readonly removed = new Map<string, { kind: 'deleted' | 'archived'; settled: boolean }>();
  /** Live events held back while an open or catch-up is in flight, or after a gap. Not persisted. */
  private readonly buffers = new Map<string, Map<number, Sequenced>>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly catchingUp = new Map<string, Promise<void>>();
  private readonly sends = new Set<string>();
  /** requestId -> who resolved it, newest last. Not persisted. */
  private readonly resolutions = new Map<string, Resolution>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(options: ReplicaOptions) {
    this.options = options;
    this.client = options.client;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.persistDelayMs = options.persistDelayMs ?? 250;
    const persisted = load(this.storage, this.storageKey);
    if (persisted !== null) {
      for (const summary of persisted.sessions) this.summaries.set(summary.sessionId, summary);
      for (const view of persisted.views) this.views.set(view.sessionId, view);
      this.openId = persisted.openSessionId;
    }
    this.unsubscribe.push(
      this.client.on('ready', () => this.onReady()),
      this.client.on('suspend', () => this.flush()),
      this.client.onNotification('*', (params, method) => this.onNotification(method, params)),
    );
    if (this.client.state === 'ready') this.onReady();
  }

  // ---- reading ----------------------------------------------------------------------------------

  /** Bumped after every change. */
  get version(): number {
    return this.versionValue;
  }

  /** Session list, newest activity first (spec 6); archived sessions are not in it. */
  get sessions(): SessionSummary[] {
    return [...this.summaries.values()].filter((s) => s.archived !== true).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The archived sessions (session/list `archived: true`), newest activity first. */
  get archivedSessions(): SessionSummary[] {
    return [...this.summaries.values()].filter((s) => s.archived === true).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** `nextCursor` from the last session/list page, for paging the list. */
  get sessionsNextCursor(): string | undefined {
    return this.nextCursor;
  }

  get openSessionId(): string | undefined {
    return this.openId;
  }

  get hostStatus(): HostStatus | undefined {
    return this.hostStatusValue;
  }

  /** The last failure of background work (open, list, catch-up) the caller did not await. */
  get lastError(): RequestError | undefined {
    return this.lastErrorValue;
  }

  session(sessionId: string): SessionView | undefined {
    return this.views.get(sessionId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops listening to the client and writes pending state. */
  dispose(): void {
    for (const fn of this.unsubscribe.splice(0)) fn();
    this.flush();
  }

  // ---- session list -----------------------------------------------------------------------------

  /** session/list; replaces the list with the host's (walkthrough: render from Replica, then reconcile). */
  async refreshSessions(params: { agentId?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const settled = this.settledRemovals();
    const result = await this.client.request<SessionListResult>('session/list', params);
    for (const summary of [...this.summaries.values()]) if (summary.archived !== true) this.summaries.delete(summary.sessionId);
    for (const listed of result.sessions) {
      const summary = this.listed(listed, settled);
      if (summary !== undefined) this.summaries.set(summary.sessionId, summary);
    }
    for (const view of this.views.values()) this.updateSummary(view);
    this.nextCursor = result.nextCursor;
    this.changed();
    return this.sessions;
  }

  /**
   * The next session/list page after `sessionsNextCursor` (infinite scroll); adds its rows. Resolves
   * false when there is no further page.
   */
  async loadMoreSessions(params: { agentId?: string; limit?: number } = {}): Promise<boolean> {
    const cursor = this.nextCursor;
    if (cursor === undefined) return false;
    const settled = this.settledRemovals();
    const result = await this.client.request<SessionListResult>('session/list', { ...params, cursor });
    if (this.nextCursor !== cursor) return true; // a refresh replaced the list meanwhile
    for (const listed of result.sessions) {
      const summary = this.listed(listed, settled);
      if (summary !== undefined && !this.summaries.has(summary.sessionId)) this.summaries.set(summary.sessionId, summary);
    }
    for (const view of this.views.values()) this.updateSummary(view);
    this.nextCursor = result.nextCursor;
    this.changed();
    return true;
  }

  /**
   * Replaces the archived sessions with the host's (session/list `archived: true`, every page). A row
   * without the flag is skipped, and its page ends the listing: a host that does not know the parameter
   * answers with the other list.
   */
  async refreshArchived(): Promise<SessionSummary[]> {
    const settled = this.settledRemovals();
    const archived: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const result: SessionListResult = await this.client.request<SessionListResult>('session/list', {
        archived: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const page = result.sessions.filter((s) => s.archived === true);
      archived.push(...page);
      // A page without archived rows is a host that ignored the parameter; a repeated cursor would loop.
      cursor = page.length > 0 && result.nextCursor !== cursor ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    // A row archived here and not yet answered may be missing from an older listing: it stays.
    for (const summary of this.archivedSessions) if (!(this.removed.has(summary.sessionId) && !settled.has(summary.sessionId))) this.summaries.delete(summary.sessionId);
    for (const listed of archived) {
      const summary = this.listed(listed, settled);
      if (summary !== undefined) this.summaries.set(summary.sessionId, summary);
    }
    this.changed();
    return this.archivedSessions;
  }

  /** session/archive; the row moves to the archived ones at once and back if the host refuses. */
  async archiveSession(sessionId: string): Promise<void> {
    await this.flag(sessionId, true, 'session/archive');
  }

  /** session/unarchive (the Undo of an archive); the row moves back at once, and again if the host refuses. */
  async unarchiveSession(sessionId: string): Promise<void> {
    await this.flag(sessionId, false, 'session/unarchive');
  }

  /**
   * session/delete: the row and any local copy of the session go at once; a refusal puts the row back.
   * The host removes the history and attachments and stops a running turn and its helpers (spec 5.1, 6).
   */
  async deleteSession(sessionId: string): Promise<void> {
    const row = this.summaries.get(sessionId);
    const view = this.views.get(sessionId);
    this.summaries.delete(sessionId);
    this.views.delete(sessionId);
    this.buffers.delete(sessionId);
    const wasOpen = this.openId === sessionId;
    if (wasOpen) this.openId = undefined;
    const mark = { kind: 'deleted' as const, settled: false };
    this.removed.set(sessionId, mark);
    this.changed();
    try {
      await this.client.request('session/delete', { sessionId });
      mark.settled = true;
    } catch (error) {
      mark.settled = true;
      if (!(error instanceof RequestError && error.code === 'not_found')) {
        if (this.removed.get(sessionId) === mark) this.removed.delete(sessionId);
        if (row !== undefined) this.summaries.set(sessionId, row);
        if (view !== undefined) this.views.set(sessionId, view);
        if (wasOpen) this.openId = sessionId;
        this.changed();
        throw error;
      }
    }
  }

  private async flag(sessionId: string, archived: boolean, method: string): Promise<void> {
    const before = this.summaries.get(sessionId);
    if (before !== undefined) this.summaries.set(sessionId, withArchived(before, archived));
    const mark = { kind: 'archived' as const, settled: !archived };
    if (archived) this.removed.set(sessionId, mark);
    else this.removed.delete(sessionId);
    this.changed();
    try {
      await this.client.request(method, { sessionId });
      mark.settled = true;
    } catch (error) {
      // A refused archive leaves the row in the list; a refused unarchive keeps it archived.
      if (archived) {
        if (this.removed.get(sessionId) === mark) this.removed.delete(sessionId);
      } else this.removed.set(sessionId, mark);
      const now = this.summaries.get(sessionId);
      if (now !== undefined) this.summaries.set(sessionId, withArchived(now, !archived));
      this.changed();
      throw error;
    }
  }

  /** Ids whose delete or archive the host has answered; a session/list asked now speaks after it. */
  private settledRemovals(): Set<string> {
    return new Set([...this.removed].filter(([, mark]) => mark.settled).map(([sessionId]) => sessionId));
  }

  /**
   * A row from a session/list asked when `settled` were answered. A session deleted or archived here is
   * the host's again once such a list names it; before that a deleted one is skipped and an archived
   * one stays archived (the list may predate the request).
   */
  private listed(summary: SessionSummary, settled: Set<string>): SessionSummary | undefined {
    const mark = this.removed.get(summary.sessionId);
    if (mark === undefined) return summary;
    if (settled.has(summary.sessionId)) {
      this.removed.delete(summary.sessionId);
      return summary;
    }
    return mark.kind === 'deleted' ? undefined : withArchived(summary, true);
  }

  /** session/start, then opens the new session (snapshot mode, which also subscribes the stream). */
  async startSession(params: SessionStartParams): Promise<SessionStartResult> {
    const result = await this.client.request<SessionStartResult>('session/start', params);
    this.summaries.set(result.session.sessionId, summaryOf(result.session));
    await this.open(result.session.sessionId);
    return result;
  }

  // ---- opening and catching up ------------------------------------------------------------------

  /**
   * Makes `sessionId` the open session and brings it current with session/open. Every new stream does
   * the same again for whichever session is open.
   */
  open(sessionId: string): Promise<void> {
    this.openId = sessionId;
    this.ensureView(sessionId);
    this.changed();
    return this.sync(sessionId);
  }

  /** Forgets which session is open and unsubscribes the stream from it (session/close). */
  async close(): Promise<void> {
    const sessionId = this.openId;
    if (sessionId === undefined) return;
    this.openId = undefined;
    this.changed();
    await this.client.request('session/close', { sessionId });
  }

  /**
   * events/since from the cursor until the host says complete, applying as it goes; cursor_expired
   * reopens in snapshot mode. Runs once at a time per session. A view that was never loaded opens instead.
   */
  catchUp(sessionId: string): Promise<void> {
    const running = this.catchingUp.get(sessionId) ?? this.syncing.get(sessionId);
    if (running !== undefined) return running;
    const view = this.views.get(sessionId);
    if (view === undefined || !view.loaded) return this.sync(sessionId);
    const settle = (succeeded: boolean) => {
      this.catchingUp.delete(sessionId);
      // After a failure the held events stay; the next live event or the next stream tries again,
      // so a host that keeps failing does not get a tight retry loop.
      this.drain(view, succeeded);
      this.changed();
    };
    const work = this.runCatchUp(view).then(
      () => settle(true),
      (error: unknown) => {
        settle(false);
        throw error;
      },
    );
    this.catchingUp.set(sessionId, work);
    return work;
  }

  private async runCatchUp(view: SessionView): Promise<void> {
    try {
      for (;;) {
        const before = view.cursor;
        const result = await this.client.request<EventsSinceResult>('events/since', {
          sessionId: view.sessionId,
          cursor: view.cursor,
          ...(this.options.catchUpLimit !== undefined ? { limit: this.options.catchUpLimit } : {}),
        });
        for (const event of result.events) this.applySequenced(view, event as Sequenced);
        this.changed();
        if (result.complete || view.cursor === before) return;
      }
    } catch (error) {
      if (error instanceof RequestError && error.code === 'cursor_expired') {
        this.catchingUp.delete(view.sessionId);
        await this.sync(view.sessionId, true);
        return;
      }
      throw error;
    }
  }

  private sync(sessionId: string, forceSnapshot = false): Promise<void> {
    const running = this.syncing.get(sessionId);
    if (running !== undefined && !forceSnapshot) return running;
    const work: Promise<void> = this.runSync(sessionId, forceSnapshot).then(
      (head) => {
        if (this.syncing.get(sessionId) === work) this.syncing.delete(sessionId);
        this.afterSync(sessionId, head);
      },
      (error: unknown) => {
        if (this.syncing.get(sessionId) === work) this.syncing.delete(sessionId);
        throw error;
      },
    );
    this.syncing.set(sessionId, work);
    return work;
  }

  /** session/open and apply its answer; returns the Journal head the host reported. */
  private async runSync(sessionId: string, forceSnapshot: boolean): Promise<number> {
    const view = this.ensureView(sessionId);
    const cursor = !forceSnapshot && view.loaded ? view.cursor : undefined;
    let result: SessionOpenResult;
    try {
      result = await this.client.request<SessionOpenResult>('session/open', {
        sessionId,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(this.options.snapshotTurns !== undefined ? { turns: this.options.snapshotTurns } : {}),
      });
    } catch (error) {
      if (error instanceof RequestError && error.code === 'cursor_expired' && cursor !== undefined) {
        // A host that reports an old cursor as an error rather than a mode switch: same outcome.
        return this.runSync(sessionId, true);
      }
      throw error;
    }
    if (result.mode === 'snapshot') {
      replaceWithSnapshot(view, result);
    } else {
      for (const event of result.events) this.applySequenced(view, event as Sequenced);
      view.session = result.session;
      view.status = result.session.status;
      replacePending(view, result.pending);
      view.loaded = true;
      reconcile(view);
    }
    this.updateSummary(view);
    return result.cursor;
  }

  /** Live events held during the open go in now; a shortfall to the head starts a catch-up. */
  private afterSync(sessionId: string, head: number): void {
    const view = this.views.get(sessionId)!;
    this.drain(view);
    if (view.cursor < head) void this.catchUp(sessionId).catch((error) => this.fail(error));
    this.resendPending(view);
    this.changed();
  }

  // ---- driving turns ----------------------------------------------------------------------------

  /**
   * turn/start with a fresh clientMessageId. The message shows at once as an optimistic `sending` turn,
   * replaced when the host's turn arrives. Returns the clientMessageId.
   */
  sendMessage(sessionId: string, input: InputPart[]): string {
    const clientMessageId = this.newClientMessageId();
    const view = this.ensureView(sessionId);
    const turnId = optimisticId(clientMessageId);
    view.items[turnId] = { itemId: turnId, type: 'userMessage', turnId, status: 'inProgress', content: input, clientMessageId };
    view.turns.push({
      turnId,
      status: 'sending',
      startedAt: (this.options.now ?? (() => Math.floor(Date.now() / 1000)))(),
      completedAt: null,
      error: null,
      items: [turnId],
      optimistic: { clientMessageId },
    });
    this.changed();
    this.flush();
    void this.sendTurnStart(view, clientMessageId);
    return clientMessageId;
  }

  /** Sends a failed optimistic message again, with the same clientMessageId. */
  retrySend(sessionId: string, clientMessageId: string): void {
    const view = this.views.get(sessionId);
    const turn = view && this.optimisticTurn(view, clientMessageId);
    if (view === undefined || turn === undefined) return;
    turn.status = 'sending';
    delete turn.optimistic!.error;
    this.changed();
    void this.sendTurnStart(view, clientMessageId);
  }

  /** Drops an optimistic message the user gave up on. */
  discardSend(sessionId: string, clientMessageId: string): void {
    const view = this.views.get(sessionId);
    const turn = view && this.optimisticTurn(view, clientMessageId);
    if (view === undefined || turn === undefined) return;
    view.turns.splice(view.turns.indexOf(turn), 1);
    for (const id of turn.items) delete view.items[id];
    this.changed();
  }

  /**
   * approval/resolve. On success, already_resolved or not_found the prompt is dropped locally at once;
   * the outcome says which (already_resolved carries who answered first). Other errors reject.
   */
  resolveApproval(sessionId: string, requestId: string, decision: Decision): Promise<ResolveOutcome> {
    return this.resolve(sessionId, requestId, 'approval/resolve', { decision });
  }

  /** input/answer, with the same local handling as resolveApproval. */
  answerInput(sessionId: string, requestId: string, answers: Record<string, string[]>): Promise<ResolveOutcome> {
    return this.resolve(sessionId, requestId, 'input/answer', { answers });
  }

  /**
   * Who resolved a request this Replica saw end, from `request/resolved` or an `already_resolved` answer
   * (spec 5.3). Kept in memory only, for the answered line ("Approved on iPhone 15").
   */
  resolution(requestId: string): Resolution | undefined {
    return this.resolutions.get(requestId);
  }

  /** turn/interrupt; the turn ends with turn/completed {status: interrupted} through the Journal. */
  async interrupt(sessionId: string, turnId: string): Promise<void> {
    await this.client.request('turn/interrupt', { sessionId, turnId });
  }

  /**
   * turn/steer: adds input to the running turn (spec 7). The steered userMessage item, echoing
   * `clientMessageId`, arrives through the Journal; errors (turn_mismatch, not_supported, ...) reject.
   */
  steer(sessionId: string, turnId: string, input: InputPart[], clientMessageId: string): Promise<TurnSteerResult> {
    return this.client.request<TurnSteerResult>('turn/steer', { sessionId, turnId, input, clientMessageId });
  }

  /** turn/diff: the net change of a turn, for the diff view; adapters without diffs reject not_supported. */
  turnDiff(sessionId: string, turnId: string): Promise<TurnDiffResult> {
    return this.client.request<TurnDiffResult>('turn/diff', { sessionId, turnId });
  }

  /** model/list (spec 4): the models a session of the agent can run on. */
  async models(agentId: string): Promise<ModelInfo[]> {
    return (await this.client.request<ModelListResult>('model/list', { agentId })).models;
  }

  /**
   * session/settings/update (spec 6): changes the model or effort of an open session from its next turn.
   * The view learns the new settings from the session/changed the host journals; this resolves the
   * session the host answered with. not_supported and invalid_params reject.
   */
  async updateSettings(sessionId: string, settings: SessionSettingsUpdateParams['settings']): Promise<SessionSettingsUpdateResult['session']> {
    return (await this.client.request<SessionSettingsUpdateResult>('session/settings/update', { sessionId, settings })).session;
  }

  /** A fresh clientMessageId (the same source sendMessage uses). */
  newClientMessageId(): string {
    return (this.options.newClientMessageId ?? (() => crypto.randomUUID()))();
  }

  /**
   * session/history before the view's olderCursor (spec 6): older turns go in front of the ones the view
   * has, items inlined. Resolves true while still older turns remain, false when the start is reached
   * (or there was no cursor to page from).
   */
  async loadOlderTurns(sessionId: string, limit?: number): Promise<boolean> {
    const view = this.views.get(sessionId);
    const before = view?.olderCursor;
    if (view === undefined || before === undefined) return false;
    const result = await this.client.request<SessionHistoryResult>('session/history', {
      sessionId,
      before,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (view.olderCursor !== before) return view.olderCursor !== undefined; // a snapshot replaced the view meanwhile
    const known = new Set(view.turns.map((t) => t.turnId));
    const older: TurnView[] = [];
    // The page is newest first; the view keeps oldest first.
    for (const turn of [...result.turns].reverse()) {
      if (known.has(turn.turnId)) continue;
      const ids: string[] = [];
      for (const item of turn.items) {
        view.items[item.itemId] = item;
        ids.push(item.itemId);
      }
      older.push({ ...turn, items: ids });
    }
    view.turns.unshift(...older);
    view.olderCursor = result.olderCursor;
    this.changed();
    return view.olderCursor !== undefined;
  }

  private async resolve(sessionId: string, requestId: string, method: string, extra: Record<string, unknown>): Promise<ResolveOutcome> {
    let outcome: ResolveOutcome = { status: 'ok' };
    try {
      await this.client.request(method, { sessionId, requestId, ...extra });
    } catch (error) {
      if (!(error instanceof RequestError) || (error.code !== 'already_resolved' && error.code !== 'not_found')) throw error;
      if (error.code === 'not_found') {
        outcome = { status: 'not_found' };
      } else {
        const by = error.data?.resolvedBy;
        const resolvedBy = typeof by === 'string' && by !== '' ? by : undefined;
        outcome = { status: 'already_resolved', ...(resolvedBy !== undefined ? { resolvedBy } : {}) };
        if (resolvedBy !== undefined && !this.resolutions.has(requestId)) this.remember(requestId, { resolvedBy });
      }
    }
    const view = this.views.get(sessionId);
    if (view !== undefined) {
      delete view.approvals[requestId];
      delete view.inputs[requestId];
      this.updateSummary(view);
    }
    this.changed();
    return outcome;
  }

  /** Records a resolution; the oldest go once there are more than RESOLUTIONS_KEPT. */
  private remember(requestId: string, resolution: Resolution): void {
    this.resolutions.delete(requestId);
    this.resolutions.set(requestId, resolution);
    for (const key of this.resolutions.keys()) {
      if (this.resolutions.size <= RESOLUTIONS_KEPT) break;
      this.resolutions.delete(key);
    }
  }

  private optimisticTurn(view: SessionView, clientMessageId: string): TurnView | undefined {
    return view.turns.find((t) => t.optimistic?.clientMessageId === clientMessageId);
  }

  private async sendTurnStart(view: SessionView, clientMessageId: string): Promise<void> {
    if (this.sends.has(clientMessageId)) return;
    const turn = this.optimisticTurn(view, clientMessageId);
    const item = view.items[optimisticId(clientMessageId)];
    if (turn === undefined || item === undefined || item.type !== 'userMessage') return;
    this.sends.add(clientMessageId);
    try {
      const result = await this.client.request<TurnStartResult>('turn/start', {
        sessionId: view.sessionId,
        input: item.content,
        clientMessageId,
      });
      turn.optimistic!.hostTurnId = result.turn.turnId;
      reconcile(view);
    } catch (error) {
      const failure = error instanceof RequestError ? error : new RequestError('internal', String(error));
      if (!RETRY_LATER.has(failure.code)) {
        turn.status = 'failed_to_send';
        turn.optimistic!.error = {
          code: failure.code,
          message: failure.message,
          ...(failure.data !== undefined ? { data: failure.data } : {}),
        };
      }
    } finally {
      this.sends.delete(clientMessageId);
    }
    this.changed();
  }

  /** After an open on a new stream: optimistic sends whose delivery is uncertain go out again. */
  private resendPending(view: SessionView): void {
    for (const turn of view.turns) {
      if (turn.status === 'sending' && turn.optimistic?.hostTurnId === undefined) {
        void this.sendTurnStart(view, turn.optimistic!.clientMessageId);
      }
    }
  }

  // ---- events -----------------------------------------------------------------------------------

  private onReady(): void {
    void this.refreshSessions().catch((error) => this.fail(error));
    if (this.openId !== undefined) void this.sync(this.openId).catch((error) => this.fail(error));
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/updated') {
      const summary = params.summary as SessionSummary;
      const mark = this.removed.get(summary.sessionId);
      if (mark?.kind === 'deleted') return; // the turn and helpers stopping, after the row went
      this.summaries.set(summary.sessionId, mark?.kind === 'archived' ? withArchived(summary, true) : summary);
      this.changed();
      return;
    }
    if (method === 'host/status/changed') {
      this.hostStatusValue = params as unknown as HostStatus;
      this.changed();
      return;
    }
    if (!isSequenced(params)) return;
    const event = { method, params } as Sequenced;
    const view = this.views.get(event.params.sessionId);
    if (view === undefined) return; // not a session this Replica opened
    const sessionId = view.sessionId;
    if (!view.loaded || this.syncing.has(sessionId) || this.catchingUp.has(sessionId)) {
      if (view.loaded || this.syncing.has(sessionId)) this.hold(view, event);
      return;
    }
    if (!this.applySequenced(view, event)) {
      this.hold(view, event);
      void this.catchUp(sessionId).catch((error) => this.fail(error));
      return;
    }
    this.drain(view);
    this.changed();
  }

  /** Applies the event if it is the next one. False for a gap; stale events count as handled. */
  private applySequenced(view: SessionView, event: Sequenced): boolean {
    const { seq } = event.params;
    if (seq <= view.cursor) return true; // already applied (idempotent apply, spec 5.2)
    if (seq !== view.cursor + 1) return false;
    if (event.method === 'request/resolved') {
      const { requestId, resolvedBy, decision, answers } = event.params;
      this.remember(requestId, { resolvedBy, ...(decision !== undefined ? { decision } : {}), ...(answers !== undefined ? { answers } : {}) });
    }
    applyEvent(view, event);
    reconcile(view);
    this.updateSummary(view);
    return true;
  }

  private hold(view: SessionView, event: Sequenced): void {
    let buffer = this.buffers.get(view.sessionId);
    if (buffer === undefined) {
      buffer = new Map();
      this.buffers.set(view.sessionId, buffer);
    }
    buffer.set(event.params.seq, event);
  }

  /** Applies held events that are now next in line; a remaining gap starts a catch-up. */
  private drain(view: SessionView, catchUpOnGap = true): void {
    const buffer = this.buffers.get(view.sessionId);
    if (buffer === undefined || this.syncing.has(view.sessionId) || this.catchingUp.has(view.sessionId)) return;
    for (const seq of [...buffer.keys()].sort((a, b) => a - b)) {
      if (seq <= view.cursor) {
        buffer.delete(seq);
        continue;
      }
      if (!this.applySequenced(view, buffer.get(seq)!)) break;
      buffer.delete(seq);
    }
    if (buffer.size === 0) this.buffers.delete(view.sessionId);
    else if (catchUpOnGap) void this.catchUp(view.sessionId).catch((error) => this.fail(error));
  }

  // ---- bookkeeping ------------------------------------------------------------------------------

  private ensureView(sessionId: string): SessionView {
    let view = this.views.get(sessionId);
    if (view === undefined) {
      view = emptyView(sessionId, this.summaries.get(sessionId));
      this.views.set(sessionId, view);
    }
    return view;
  }

  /** Keeps the list row of a loaded session in step with what its Journal says. */
  private updateSummary(view: SessionView): void {
    if (!view.loaded && view.session === null) return;
    const base = this.summaries.get(view.sessionId) ?? (view.session !== null ? summaryOf(view.session) : undefined);
    // A list row newer than this view (a session not open on this stream) is left as the host sent it.
    if (base === undefined || base.lastSeq > view.cursor) return;
    // Whether the session is archived is the list's to say (session/updated), not the opened session's.
    const { archived: _openedArchived, ...fromSession }: Partial<SessionSummary> = view.session !== null ? summaryOf(view.session) : {};
    const lastHostTurn = [...view.turns].reverse().find((t) => t.optimistic === undefined);
    // Background tasks are live state (spec 5.1): the session's list replaces the row's, even with none.
    const { backgroundTasks: _rowTasks, ...row } = base;
    this.summaries.set(view.sessionId, {
      ...(view.session !== null ? row : base),
      ...fromSession,
      status: view.status,
      lastSeq: Math.max(base.lastSeq, view.cursor),
      pending: { approvals: Object.keys(view.approvals).length, inputs: Object.keys(view.inputs).length },
      ...(lastHostTurn !== undefined ? { lastTurnStatus: lastHostTurn.status as SessionSummary['lastTurnStatus'] } : {}),
    });
  }

  private fail(error: unknown): void {
    this.lastErrorValue = error instanceof RequestError ? error : new RequestError('internal', String(error));
    this.changed();
  }

  private changed(): void {
    this.versionValue += 1;
    this.schedulePersist();
    for (const listener of this.listeners) listener();
  }

  private schedulePersist(): void {
    if (this.storage === null || this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => this.flush(), this.persistDelayMs);
  }

  /**
   * Writes summaries, the open session id and the views worth keeping (the open session, and any
   * session with an unsent message) now. Called on suspend (pagehide).
   */
  flush(): void {
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    const views = [...this.views.values()].filter(
      (view) => view.sessionId === this.openId || view.turns.some((t) => t.optimistic !== undefined),
    );
    save(this.storage, this.storageKey, {
      v: 1,
      ...(this.openId !== undefined ? { openSessionId: this.openId } : {}),
      sessions: [...this.summaries.values()],
      views,
    });
  }
}
