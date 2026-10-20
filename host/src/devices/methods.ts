// Device methods on the stream (protocol-v1.md section 8): `device/list`, `device/revoke`,
// `device/rename`. Any paired device may manage any other (a lost phone is revoked from the laptop).
import type { Device } from '../generated/common.js';
import { RpcError, type MethodRegistry } from '../stream/router.js';
import { MAX_DISPLAY_NAME_LENGTH, type DeviceStore } from './store.js';

export interface DeviceMethodsOptions {
  devices: DeviceStore;
  /** Closes every open stream of a client with 4003 (`StreamServer.revokeClient`). */
  closeStreams: (clientId: string) => void;
}

type Params = Record<string, unknown>;

function clientIdOf(params: Params): string {
  const value = params.clientId;
  if (typeof value !== 'string' || value.length === 0) {
    throw RpcError.invalidParams('params.clientId', 'clientId must be a non-empty string');
  }
  return value;
}

function displayNameOf(params: Params): string {
  const value = params.displayName;
  if (typeof value !== 'string') throw RpcError.invalidParams('params.displayName', 'displayName must be a string');
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
    throw RpcError.invalidParams(
      'params.displayName',
      `displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters after trimming`,
    );
  }
  return name;
}

function notFound(clientId: string): RpcError {
  return new RpcError('not_found', 'no such device', { clientId });
}

/** Registers the three device methods on the router and returns it. */
export function registerDeviceMethods(registry: MethodRegistry, options: DeviceMethodsOptions): MethodRegistry {
  const { devices, closeStreams } = options;
  return registry
    .register('device/list', (_params, context) => ({
      devices: devices.list().map(
        (d): Device => ({
          clientId: d.clientId,
          displayName: d.displayName,
          platform: d.platform,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          current: d.clientId === context.clientId,
        }),
      ),
    }))
    .register('device/revoke', (params, context) => {
      const clientId = clientIdOf(params as Params);
      if (!devices.revoke(clientId)) throw notFound(clientId);
      // The hash is gone now, so no new stream authenticates. Other streams close at once; a device that
      // revokes itself gets its response first, then its streams close.
      if (clientId === context.clientId) context.afterResponse(() => closeStreams(clientId));
      else closeStreams(clientId);
      return { ok: true as const };
    })
    .register('device/rename', (params) => {
      const clientId = clientIdOf(params as Params);
      const displayName = displayNameOf(params as Params);
      if (!devices.rename(clientId, displayName)) throw notFound(clientId);
      return { ok: true as const };
    });
}
