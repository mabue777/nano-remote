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
  readonly sessionsNextCursor: string | undefined;
  refreshSessions(): Promise<unknown>;
  loadMoreSessions(): Promise<boolean>;
  subscribe(listener: () => void): () => void;
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
  /** What the session is doing or how its last turn ended. */
  statusLabel: string;
  tone: 'ok' | 'busy' | 'attention' | 'error' | 'muted';
  /** Approvals plus questions waiting for an answer. */
  pending: number;
  preview: string;
  updatedAt: number;
  updated: string;
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

export function sessionRow(summary: SessionSummary, agentNames: ReadonlyMap<string, string>, nowMs: number): SessionRow {
  const status = statusOf(summary);
  return {
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
  };
}

export interface HomeModelOptions {
  client: HomeClient;
  replica: HomeReplica;
  now?: () => number;
}

export class HomeModel extends Model {
  refreshing = false;
  loadingMore = false;
  /** The last failed refresh or page, shown above the list. */
  error: string | undefined;
  private status: { value: HostStatus; receivedAt: number } | undefined;
  private readonly client: HomeClient;
  private readonly replica: HomeReplica;
  private readonly now: () => number;
  private readonly unsubscribe: (() => void)[] = [];
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(options: HomeModelOptions) {
    super();
    this.client = options.client;
    this.replica = options.replica;
    this.now = options.now ?? Date.now;
    this.unsubscribe.push(
      this.client.on('state', () => {
        this.updateTicker();
        this.changed();
      }),
      this.client.on('ready', () => this.fetchStatus()),
      this.client.onNotification('host/status/changed', (params) => {
        this.status = { value: params as unknown as HostStatus, receivedAt: this.now() };
        this.changed();
      }),
      this.replica.subscribe(() => this.changed()),
    );
    if (this.client.state === 'ready') this.fetchStatus();
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
    const names = new Map<string, string>();
    for (const agent of this.status?.value.agents ?? this.client.host?.agents ?? []) names.set(agent.id, agent.name);
    const now = this.now();
    return [...this.replica.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((summary) => sessionRow(summary, names, now));
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
      await Promise.all([this.replica.refreshSessions(), this.fetchStatus()]);
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
