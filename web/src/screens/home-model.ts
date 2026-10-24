// The home screen: the connection indicator (with the reconnect countdown), the host's status (name,
// agents and their state, uptime) and the session list.
//
// Host status starts from the `initialize` result of the current stream (host and agents, spec 4), then
// `host/status` on every new stream adds uptime and the active count, and `host/status/changed` replaces
// it whenever an agent's state changes. The session list is the Replica's (it lists on every new stream
// and folds `session/updated` in); this model adds pull-to-refresh and paging by cursor on top.
import type { Agent, HostStatus, InitializeResult } from '../generated/methods';
import type { SessionSummary } from '../replica/types';
import type { ClientState } from '../stream/client';
import { errorText, Model } from './model';
import { modelLabel } from './new-session-model';

/** What the home screen needs from the stream client; StreamClient fits. */
export interface HomeClient {
  readonly state: ClientState;
  readonly reconnectAt: number | undefined;
  readonly host: InitializeResult | undefined;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: 'state', listener: (state: ClientState, detail: string) => void): () => void;
  on(event: 'ready', listener: () => void): () => void;
  onNotification(method: string, handler: (params: Record<string, unknown>, method: string) => void): () => void;
  retryNow(): void;
}

/** What the home screen needs from the Replica; Replica fits. */
export interface HomeReplica {
  readonly sessions: SessionSummary[];
  /** The archived sessions, for the "Archived" section. */
  readonly archivedSessions: SessionSummary[];
  readonly sessionsNextCursor: string | undefined;
  refreshSessions(): Promise<unknown>;
  refreshArchived(): Promise<unknown>;
  loadMoreSessions(): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  /** The session as last opened (its settings name the model); optional, rows then show no model. */
  session?(sessionId: string): { session: { settings?: { model?: string } } | null } | undefined;
}

export type ConnectionKind = 'connecting' | 'connected' | 'offline' | 'update_required' | 'unpaired';

export interface Connection {
  kind: ConnectionKind;
  /** While offline and a retry is scheduled: whole seconds until it starts. */
  retryInSeconds?: number;
  label: string;
}

export interface AgentRow {
  id: string;
  name: string;
  status: string;
  /** ready, degraded or unavailable, for the dot's color. */
  tone: 'ok' | 'warn' | 'off';
  detail: string;
}

export interface HostView {
  name: string;
  version: string;
  agents: AgentRow[];
  /** Absent until `host/status` answered. */
  uptime?: string;
  sessionsActive?: number;
}

export interface SessionRow {
  sessionId: string;
  title: string;
  agentName: string;
  /** The last part of the working folder. */
  folder: string;
  /** The model it runs on ("model · provider" for provider/model ids), when the phone knows it. */
  model?: string;
  /** What the session is doing or how its last turn ended. */
  statusLabel: string;
  tone: 'ok' | 'busy' | 'attention' | 'error' | 'muted';
  /** Approvals plus questions waiting for an answer. */
  pending: number;
  preview: string;
  updatedAt: number;
  updated: string;
  /** Its turn ended while the app was hidden or offline, and it has not been opened since. */
  finishedWhileAway: boolean;
  /** Background tasks of its agent still running (Session.backgroundTasks, spec 5.1). */
  backgroundTasks: number;
}

/** "1 background task", "3 background tasks". */
export function backgroundTasksText(count: number): string {
  return `${count} background task${count === 1 ? '' : 's'}`;
}

export function connectionOf(state: ClientState, reconnectAt: number | undefined, now: number): Connection {
  switch (state) {
    case 'ready':
      return { kind: 'connected', label: 'Connected' };
    case 'idle':
    case 'connecting':
      return { kind: 'connecting', label: 'Connecting…' };
    case 'waiting': {
      if (reconnectAt === undefined) return { kind: 'offline', label: 'Offline' };
      const retryInSeconds = Math.max(0, Math.ceil((reconnectAt - now) / 1000));
      return { kind: 'offline', retryInSeconds, label: `Offline, retrying in ${retryInSeconds} s` };
    }
    case 'suspended':
    case 'stopped':
      return { kind: 'offline', label: 'Offline' };
    case 'update_required':
      return { kind: 'update_required', label: 'Update needed: the host speaks another protocol version' };
    case 'unpaired':
      return { kind: 'unpaired', label: 'Not paired' };
  }
}

/** "3 d 4 h", "2 h 5 min", "7 min", "40 s". */
export function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${s} s`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" from Unix seconds. */
export function formatAgo(unixSeconds: number, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000) - unixSeconds;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export function agentRow(agent: Agent): AgentRow {
  const tone = agent.status === 'ready' ? 'ok' : agent.status === 'unavailable' ? 'off' : 'warn';
  const detail = [agent.status, agent.version, agent.reason].filter((part) => typeof part === 'string' && part !== '').join(' · ');
  return { id: agent.id, name: agent.name, status: agent.status, tone, detail };
}

export function statusOf(summary: Pick<SessionSummary, 'status' | 'lastTurnStatus'>): { label: string; tone: SessionRow['tone'] } {
  switch (summary.status) {
    case 'running':
      return { label: 'Working', tone: 'busy' };
    case 'waiting_approval':
      return { label: 'Needs approval', tone: 'attention' };
    case 'waiting_input':
      return { label: 'Needs an answer', tone: 'attention' };
    case 'error':
      return { label: 'Error', tone: 'error' };
    case 'closed':
      return { label: 'Closed', tone: 'muted' };
    case 'idle':
      switch (summary.lastTurnStatus) {
        case 'completed':
          return { label: 'Finished', tone: 'ok' };
        case 'interrupted':
          return { label: 'Interrupted', tone: 'muted' };
        case 'failed':
          return { label: 'Failed', tone: 'error' };
        case 'inProgress':
          return { label: 'Working', tone: 'busy' };
        default:
          return { label: 'Idle', tone: 'muted' };
      }
  }
}

export function folderOf(cwd: string): string {
  const parts = cwd.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? cwd;
}

export function sessionRow(summary: SessionSummary, agentNames: ReadonlyMap<string, string>, nowMs: number, modelId?: string): SessionRow {
  const status = statusOf(summary);
  const row: SessionRow = {
    sessionId: summary.sessionId,
    title: summary.title.trim() === '' ? 'Untitled session' : summary.title,
    agentName: agentNames.get(summary.agentId) ?? summary.agentId,
    folder: folderOf(summary.cwd),
    statusLabel: status.label,
    tone: status.tone,
    pending: summary.pending.approvals + summary.pending.inputs,
    preview: summary.preview ?? '',
    updatedAt: summary.updatedAt,
    updated: formatAgo(summary.updatedAt, nowMs),
    finishedWhileAway: false,
    // Running ones only; none while the agent is stopped (they cannot still run).
    backgroundTasks: summary.status === 'error' ? 0 : (summary.backgroundTasks ?? []).filter((task) => task.status === 'running').length,
  };
  if (modelId !== undefined && modelId !== '') row.model = modelLabel(modelId);
  return row;
}

type Ranked = Pick<SessionSummary, 'status' | 'lastTurnStatus' | 'pending' | 'updatedAt'>;

/** 0: waiting for this user (a pending request), 1: running, 2: everything else. */
export function rankOf(summary: Ranked): 0 | 1 | 2 {
  const pending = (summary.pending?.approvals ?? 0) + (summary.pending?.inputs ?? 0);
  if (pending > 0 || summary.status === 'waiting_approval' || summary.status === 'waiting_input') return 0;
  if (summary.status === 'running' || (summary.status === 'idle' && summary.lastTurnStatus === 'inProgress')) return 1;
  return 2;
}

/** The home list's order: waiting first, then running, then the rest; newest activity first within each. */
export function orderSessions<T extends Ranked>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt);
}

// ---- finished while away ------------------------------------------------------------------------

type Tracked = Pick<SessionSummary, 'sessionId' | 'status' | 'lastTurnStatus' | 'lastSeq'>;

/** Idle after a turn that ended (completed, failed or interrupted). */
export function isFinished(summary: Pick<SessionSummary, 'status' | 'lastTurnStatus'>): boolean {
  return summary.status === 'idle' && (summary.lastTurnStatus === 'completed' || summary.lastTurnStatus === 'failed' || summary.lastTurnStatus === 'interrupted');
}

/**
 * The rule, for one session the app looks at while present (visible and connected):
 * - `mark`: it is finished now, its Journal moved past what the app last saw (`seenSeq`), and the app did
 *   not watch that happen live (no notification for it reached `summary.lastSeq` while present, `liveSeq`).
 *   So the turn ended while the page was hidden or the stream was down, and the list caught up later.
 * - `unmark`: it is no longer finished (a new turn started); a mark would be stale.
 * - `none`: otherwise, including a session the app sees for the first time (nothing to compare with).
 */
export function awayTransition(seenSeq: number | undefined, summary: Tracked, liveSeq: number | undefined): 'mark' | 'unmark' | 'none' {
  if (!isFinished(summary)) return 'unmark';
  if (seenSeq === undefined || summary.lastSeq <= seenSeq) return 'none';
  if (liveSeq !== undefined && liveSeq >= summary.lastSeq) return 'none';
  return 'mark';
}

/** sessionStorage, or anything with the same two calls. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What the tracker needs from the stream client; StreamClient fits. */
export interface AwayClient {
  readonly state: ClientState;
  on(event: 'state', listener: (state: ClientState, detail: string) => void): () => void;
  onNotification(method: string, handler: (params: Record<string, unknown>, method: string) => void): () => void;
}

/** What the tracker needs from the Replica; Replica fits. */
export interface AwayReplica {
  readonly sessions: readonly Tracked[];
  readonly openSessionId: string | undefined;
  subscribe(listener: () => void): () => void;
}

export interface AwayDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export const AWAY_STORAGE_KEY = 'nano.finishedWhileAway';

interface AwayState {
  /** sessionId → the lastSeq the app last saw while present. */
  seen: Record<string, number>;
  /** sessionId → the lastSeq at which its turn was found finished while away. */
  marks: Record<string, number>;
}

function readAwayState(storage: SessionStorageLike | null | undefined): AwayState {
  try {
    const raw = storage?.getItem(AWAY_STORAGE_KEY);
    if (raw === null || raw === undefined) return { seen: {}, marks: {} };
    const parsed = JSON.parse(raw) as Partial<AwayState>;
    const numbers = (value: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (value !== null && typeof value === 'object') {
        for (const [key, seq] of Object.entries(value)) if (typeof seq === 'number') out[key] = seq;
      }
      return out;
    };
    return { seen: numbers(parsed.seen), marks: numbers(parsed.marks) };
  } catch {
    return { seen: {}, marks: {} };
  }
}

export interface AwayTrackerOptions {
  client: AwayClient;
  replica: AwayReplica;
  /** sessionStorage: the marks live as long as the tab (a reload keeps them). */
  storage?: SessionStorageLike | null;
  doc?: AwayDocument;
}

/**
 * Tracks which sessions finished while the app was away. Present means the page is visible and the
 * stream is ready; only then does it look at the list. A live notification for a session (a Journal event
 * of the open session, or `session/updated`) counts as watched; a list row that moved on without one (the
 * session/list after a reconnect, or catching up after the page was hidden) is what happened while away.
 */
export class AwayTracker {
  private readonly state: AwayState;
  private readonly live = new Map<string, number>();
  private readonly stops: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly options: AwayTrackerOptions;
  private scheduled = false;
  private wasPresent = false;

  constructor(options: AwayTrackerOptions) {
    this.options = options;
    this.state = readAwayState(options.storage);
    const { client, replica, doc } = options;
    const onVisibility = () => this.presenceChanged();
    this.stops.push(
      client.onNotification('*', (params, method) => this.heard(method, params)),
      client.on('state', () => this.presenceChanged()),
      replica.subscribe(() => this.schedule()),
    );
    if (doc !== undefined) {
      doc.addEventListener('visibilitychange', onVisibility);
      this.stops.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }
    this.presenceChanged();
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.listeners.clear();
  }

  get present(): boolean {
    const visible = this.options.doc === undefined || this.options.doc.visibilityState === 'visible';
    return visible && this.options.client.state === 'ready';
  }

  /** True while the session carries the "Finished while away" marker. */
  isMarked(sessionId: string): boolean {
    return this.state.marks[sessionId] !== undefined;
  }

  /** The session was opened: its marker goes away. */
  opened(sessionId: string): void {
    const seq = this.options.replica.sessions.find((s) => s.sessionId === sessionId)?.lastSeq;
    if (seq !== undefined) this.state.seen[sessionId] = Math.max(this.state.seen[sessionId] ?? 0, seq);
    if (this.state.marks[sessionId] === undefined) {
      this.persist();
      return;
    }
    delete this.state.marks[sessionId];
    this.persist();
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Looks at the list now (normally deferred to after the notification that changed it). */
  evaluate(): void {
    this.scheduled = false;
    if (!this.present) return;
    const openId = this.options.replica.openSessionId;
    let changed = false;
    for (const summary of this.options.replica.sessions) {
      const { sessionId } = summary;
      const transition = sessionId === openId ? 'unmark' : awayTransition(this.state.seen[sessionId], summary, this.live.get(sessionId));
      if (transition === 'mark' && this.state.marks[sessionId] !== summary.lastSeq) {
        this.state.marks[sessionId] = summary.lastSeq;
        changed = true;
      } else if (transition === 'unmark' && this.state.marks[sessionId] !== undefined) {
        delete this.state.marks[sessionId];
        changed = true;
      }
      this.state.seen[sessionId] = summary.lastSeq;
    }
    this.live.clear();
    this.persist();
    if (changed) this.notify();
  }

  private heard(method: string, params: Record<string, unknown>): void {
    if (!this.present) return;
    const summary = method === 'session/updated' ? (params.summary as Partial<Tracked> | undefined) : undefined;
    const sessionId = summary?.sessionId ?? params.sessionId;
    const seq = summary?.lastSeq ?? params.seq;
    if (typeof sessionId !== 'string' || typeof seq !== 'number') return;
    this.live.set(sessionId, Math.max(this.live.get(sessionId) ?? 0, seq));
  }

  private presenceChanged(): void {
    const present = this.present;
    if (present && !this.wasPresent) this.schedule();
    this.wasPresent = present;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // After the notification that changed the Replica has reached every handler (heard() runs after it).
    queueMicrotask(() => this.evaluate());
  }

  private persist(): void {
    try {
      this.options.storage?.setItem(AWAY_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // storage full or blocked: the markers then last only as long as this page
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface HomeModelOptions {
  client: HomeClient;
  replica: HomeReplica;
  /** Marks rows that finished while the app was away; absent means no markers. */
  away?: Pick<AwayTracker, 'isMarked' | 'subscribe'>;
  now?: () => number;
}

export class HomeModel extends Model {
  refreshing = false;
  loadingMore = false;
  /** The "Archived" section is open (it starts collapsed). */
  archivedOpen = false;
  /** The row whose swipe actions show, if any. */
  revealedId: string | undefined;
  /** The row whose long-press menu (the actions sheet) is open, if any. */
  menuId: string | undefined;
  /** The last failed refresh or page, shown above the list. */
  error: string | undefined;
  private status: { value: HostStatus; receivedAt: number } | undefined;
  private readonly client: HomeClient;
  private readonly replica: HomeReplica;
  private readonly away: HomeModelOptions['away'];
  private readonly now: () => number;
  private readonly unsubscribe: (() => void)[] = [];
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(options: HomeModelOptions) {
    super();
    this.client = options.client;
    this.replica = options.replica;
    this.away = options.away;
    this.now = options.now ?? Date.now;
    this.unsubscribe.push(
      this.client.on('state', () => {
        this.updateTicker();
        this.changed();
      }),
      this.client.on('ready', () => {
        void this.fetchStatus();
        this.fetchArchived();
      }),
      this.client.onNotification('host/status/changed', (params) => {
        this.status = { value: params as unknown as HostStatus, receivedAt: this.now() };
        this.changed();
      }),
      this.replica.subscribe(() => this.changed()),
    );
    if (this.away !== undefined) this.unsubscribe.push(this.away.subscribe(() => this.changed()));
    if (this.client.state === 'ready') {
      void this.fetchStatus();
      this.fetchArchived();
    }
    this.updateTicker();
  }

  dispose(): void {
    for (const fn of this.unsubscribe.splice(0)) fn();
    this.stopTicker();
  }

  get connection(): Connection {
    return connectionOf(this.client.state, this.client.reconnectAt, this.now());
  }

  get host(): HostView | undefined {
    const init = this.client.host;
    if (this.status === undefined && init === undefined) return undefined;
    const host = this.status?.value.host ?? init!.host;
    const agents = this.status?.value.agents ?? init!.agents;
    const view: HostView = { name: host.name, version: host.version, agents: agents.map(agentRow) };
    if (this.status !== undefined) {
      const elapsed = (this.now() - this.status.receivedAt) / 1000;
      view.uptime = formatUptime(this.status.value.uptimeSeconds + elapsed);
      view.sessionsActive = this.status.value.sessionsActive;
    }
    return view;
  }

  get sessions(): SessionRow[] {
    const names = this.agentNames();
    const now = this.now();
    return orderSessions(this.replica.sessions).map((summary) => {
      const row = sessionRow(summary, names, now, this.replica.session?.(summary.sessionId)?.session?.settings?.model);
      if (this.away?.isMarked(summary.sessionId) === true && isFinished(summary)) row.finishedWhileAway = true;
      return row;
    });
  }

  /** The "Archived" section's rows, newest first. */
  get archived(): SessionRow[] {
    const names = this.agentNames();
    const now = this.now();
    return this.replica.archivedSessions.map((summary) => sessionRow(summary, names, now, this.replica.session?.(summary.sessionId)?.session?.settings?.model));
  }

  get archivedCount(): number {
    return this.replica.archivedSessions.length;
  }

  toggleArchived(): void {
    this.archivedOpen = !this.archivedOpen;
    this.changed();
  }

  /** A swipe: the row shows its actions; any other row's hide. */
  reveal(sessionId: string): void {
    if (this.revealedId === sessionId) return;
    this.revealedId = sessionId;
    this.changed();
  }

  conceal(): void {
    if (this.revealedId === undefined) return;
    this.revealedId = undefined;
    this.changed();
  }

  /** A long-press: the actions sheet for the row. */
  openMenu(sessionId: string): void {
    this.revealedId = undefined;
    this.menuId = sessionId;
    this.changed();
  }

  closeMenu(): void {
    if (this.menuId === undefined) return;
    this.menuId = undefined;
    this.changed();
  }

  /** The row the menu is open for, while it is still listed. */
  get menuRow(): SessionRow | undefined {
    const id = this.menuId;
    if (id === undefined) return undefined;
    return [...this.sessions, ...this.archived].find((row) => row.sessionId === id);
  }

  get hasMore(): boolean {
    return this.replica.sessionsNextCursor !== undefined;
  }

  /** Pull to refresh: the list and the host status again. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.error = undefined;
    this.changed();
    try {
      await Promise.all([this.replica.refreshSessions(), this.fetchStatus(), this.replica.refreshArchived()]);
    } catch (error) {
      this.error = `Could not refresh: ${errorText(error)}`;
    } finally {
      this.refreshing = false;
      this.changed();
    }
  }

  /** Infinite scroll: the next page, when there is one and none is loading. */
  async loadMore(): Promise<void> {
    if (this.loadingMore || this.refreshing || !this.hasMore) return;
    this.loadingMore = true;
    this.changed();
    try {
      await this.replica.loadMoreSessions();
    } catch (error) {
      this.error = `Could not load more sessions: ${errorText(error)}`;
    } finally {
      this.loadingMore = false;
      this.changed();
    }
  }

  /** The "retry now" button on the offline indicator. */
  retryNow(): void {
    this.client.retryNow();
  }

  private agentNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const agent of this.status?.value.agents ?? this.client.host?.agents ?? []) names.set(agent.id, agent.name);
    return names;
  }

  /** The archived list for the "Archived" section; a failure leaves what the phone had. */
  private fetchArchived(): void {
    this.replica.refreshArchived().catch(() => undefined);
  }

  private async fetchStatus(): Promise<void> {
    try {
      const value = await this.client.request<HostStatus>('host/status');
      this.status = { value, receivedAt: this.now() };
      this.changed();
    } catch {
      // keep what initialize said; the next stream asks again
    }
  }

  /**
   * Re-renders every second while the reconnect countdown runs, and every 30 s while connected (uptime
   * and "5 min ago" labels).
   */
  private updateTicker(): void {
    this.stopTicker();
    const period = this.client.state === 'waiting' ? 1000 : this.client.state === 'ready' ? 30_000 : undefined;
    if (period !== undefined) this.ticker = setInterval(() => this.changed(), period);
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
