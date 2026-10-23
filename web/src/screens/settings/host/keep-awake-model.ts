// Settings, host section: "Keep this Mac awake while plugged in" (protocol-v1.md section 4, `keepAwake`).
// The status comes from `host/status` on every new stream and from `host/status/changed`; the switch sends
// `host/settings/update {keepAwake}`, which the host writes to its config file and applies at once. A host
// that sends no `keepAwake` cannot do this, so the section stays hidden.
import type { KeepAwakeSetting, KeepAwakeStatus } from '../../../generated/common';
import type { ClientState } from '../../../stream/client';
import { Model } from '../../model';

/** The parts of the StreamClient the section uses. */
export interface KeepAwakeLink {
  readonly state: ClientState;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): () => void;
  on(event: 'ready', listener: () => void): () => void;
}

export type KeepAwakeLineKind = 'active' | 'battery' | 'off' | 'inactive';

export const KEEP_AWAKE_TITLE = 'Keep this Mac awake while plugged in';
export const KEEP_AWAKE_LINES: Record<KeepAwakeLineKind, string> = {
  active: 'Active',
  battery: 'On battery: the Mac may sleep',
  off: 'Off',
  // Plugged in, but the host does not hold the assertion right now (it is restarting it).
  inactive: 'Not active right now: the Mac may sleep',
};
export const KEEP_AWAKE_NOTE = 'The display can still turn off. With the lid closed and no external display, the Mac sleeps anyway.';
export const KEEP_AWAKE_FAILED = 'Could not change this setting. Check that your Mac is reachable and try again.';

export function lineKind(status: KeepAwakeStatus): KeepAwakeLineKind {
  if (status.setting === 'off') return 'off';
  if (status.active) return 'active';
  return status.onBattery ? 'battery' : 'inactive';
}

function readStatus(value: unknown): KeepAwakeStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if ((v.setting !== 'pluggedIn' && v.setting !== 'off') || typeof v.active !== 'boolean' || typeof v.onBattery !== 'boolean') return undefined;
  return { setting: v.setting, active: v.active, onBattery: v.onBattery };
}

export class KeepAwakeModel extends Model {
  /** Undefined until the host answered, and for a host that does not report it. */
  status: KeepAwakeStatus | undefined;
  /** The setting a request is changing to right now. */
  pending: KeepAwakeSetting | undefined;
  error: string | undefined;
  private readonly offs: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly link: KeepAwakeLink) {
    super();
  }

  /** Reads the status now and on every new stream, and follows `host/status/changed`. */
  start(): void {
    this.offs.push(
      this.link.onNotification('host/status/changed', (params) => this.take(params.keepAwake)),
      this.link.on('ready', () => void this.load()),
    );
    void this.load();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
  }

  /** What the switch shows: the pending choice while a change is in flight. */
  get checked(): boolean {
    return (this.pending ?? this.status?.setting) === 'pluggedIn';
  }

  get line(): string | undefined {
    return this.status === undefined ? undefined : KEEP_AWAKE_LINES[lineKind(this.status)];
  }

  get kind(): KeepAwakeLineKind | undefined {
    return this.status === undefined ? undefined : lineKind(this.status);
  }

  async set(on: boolean): Promise<void> {
    const setting: KeepAwakeSetting = on ? 'pluggedIn' : 'off';
    if (this.pending !== undefined || this.status === undefined || setting === this.status.setting) return;
    this.pending = setting;
    this.error = undefined;
    this.changed();
    try {
      const result = await this.link.request<{ keepAwake?: unknown }>('host/settings/update', { keepAwake: setting });
      this.pending = undefined;
      this.take(result?.keepAwake);
    } catch {
      this.pending = undefined;
      this.error = KEEP_AWAKE_FAILED;
    }
    if (!this.disposed) this.changed();
  }

  private async load(): Promise<void> {
    try {
      const status = await this.link.request<{ keepAwake?: unknown }>('host/status');
      // An older host leaves the field out: the section stays hidden.
      this.take(status?.keepAwake, true);
    } catch {
      // Unreachable now; the next stream's `ready` asks again.
    }
  }

  private take(value: unknown, absentClears = false): void {
    if (this.disposed) return;
    const status = readStatus(value);
    if (status === undefined && !absentClears) return;
    this.status = status;
    this.changed();
  }
}
