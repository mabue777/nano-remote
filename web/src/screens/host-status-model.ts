// The paired host's status: name, version, agents and their state, uptime and the active count. Settings
// shows it as the host card (it left Home in look step 6); Home reads the agent names for its rows.
//
// It starts from the `initialize` result of the current stream (host and agents, spec 4), then
// `host/status` on every new stream adds uptime and the active count, and `host/status/changed` replaces
// it whenever an agent's state changes.
import type { Agent, HostStatus, InitializeResult } from '../generated/methods';
import type { ClientState } from '../stream/client';
import { Model } from './model';

/** What the host status needs from the stream client; StreamClient fits. */
export interface HostStatusClient {
  readonly state: ClientState;
  readonly host: InitializeResult | undefined;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: 'ready', listener: () => void): () => void;
  onNotification(method: string, handler: (params: Record<string, unknown>, method: string) => void): () => void;
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

export function agentRow(agent: Agent): AgentRow {
  const tone = agent.status === 'ready' ? 'ok' : agent.status === 'unavailable' ? 'off' : 'warn';
  const detail = [agent.status, agent.version, agent.reason].filter((part) => typeof part === 'string' && part !== '').join(' · ');
  return { id: agent.id, name: agent.name, status: agent.status, tone, detail };
}

export interface HostStatusOptions {
  client: HostStatusClient;
  now?: () => number;
}

export class HostStatusModel extends Model {
  private status: { value: HostStatus; receivedAt: number } | undefined;
  private readonly client: HostStatusClient;
  private readonly now: () => number;
  private readonly offs: (() => void)[] = [];

  constructor(options: HostStatusOptions) {
    super();
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.offs.push(
      this.client.on('ready', () => void this.refresh()),
      this.client.onNotification('host/status/changed', (params) => {
        this.status = { value: params as unknown as HostStatus, receivedAt: this.now() };
        this.changed();
      }),
    );
    if (this.client.state === 'ready') void this.refresh();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Undefined until the host is known (initialize or host/status). */
  get view(): HostView | undefined {
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

  /** agentId → display name, from the newest status. */
  agentNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const agent of this.status?.value.agents ?? this.client.host?.agents ?? []) names.set(agent.id, agent.name);
    return names;
  }

  /** Asks `host/status` again; a failure keeps what initialize said (the next stream asks again). */
  async refresh(): Promise<void> {
    try {
      const value = await this.client.request<HostStatus>('host/status');
      this.status = { value, receivedAt: this.now() };
      this.changed();
    } catch {
      // keep what initialize said; the next stream asks again
    }
  }
}
