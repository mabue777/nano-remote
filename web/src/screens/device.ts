// Which device this browser is, as far as the app needs to know: the clientId from pairing (sent as
// `client_id` on every envelope, spec 2) and the host's name for the header. Neither is a secret; the
// device token lives only in the host's HttpOnly `nano_device` cookie (spec 8), which the app never sees.
import type { StorageLike } from '../replica/storage';

export const DEVICE_STORAGE_KEY = 'nano-remote.device.v1';

export interface PairedDevice {
  clientId: string;
  hostName: string;
}

export function loadDevice(storage: StorageLike | null): PairedDevice | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(DEVICE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PairedDevice>;
    if (typeof parsed.clientId !== 'string' || parsed.clientId === '') return null;
    return { clientId: parsed.clientId, hostName: typeof parsed.hostName === 'string' ? parsed.hostName : '' };
  } catch {
    return null;
  }
}

export function saveDevice(storage: StorageLike | null, device: PairedDevice): void {
  try {
    storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ clientId: device.clientId, hostName: device.hostName }));
  } catch {
    // storage full or blocked: pairing still worked for this page load
  }
}

/** Forgets the device (after `unpaired`: revoked or the cookie is gone). */
export function forgetDevice(storage: StorageLike | null): void {
  try {
    storage?.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // nothing to do
  }
}
