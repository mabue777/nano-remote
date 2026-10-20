// Device names for "answered on <device>" (spec 8, device/list). One device/list call is shared by every
// lookup until it settles; a clientId the list does not know triggers one refresh (a device paired since).
import type { DeviceListResult } from '../../../generated/methods';

export interface DeviceTransport {
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export class DeviceNames {
  private names = new Map<string, string>();
  private loading: Promise<void> | undefined;
  private loadedOnce = false;
  private readonly refreshed = new Set<string>();

  constructor(private readonly client: DeviceTransport) {}

  /** The display name of `clientId`, or undefined when the host does not know it or cannot be asked. */
  async nameOf(clientId: string): Promise<string | undefined> {
    if (!this.loadedOnce || (!this.names.has(clientId) && !this.refreshed.has(clientId))) {
      if (this.loadedOnce) this.refreshed.add(clientId);
      await this.load();
    }
    return this.names.get(clientId);
  }

  private load(): Promise<void> {
    this.loading ??= this.client.request<DeviceListResult>('device/list', {}).then(
      (result) => {
        this.names = new Map(result.devices.map((d) => [d.clientId, d.displayName]));
        this.loadedOnce = true;
        this.loading = undefined;
      },
      () => {
        this.loadedOnce = true;
        this.loading = undefined;
      },
    );
    return this.loading;
  }
}
