import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { Journal } from '../journal/journal.js';
import {
  DEVICE_TOKEN_BYTES,
  DeviceStore,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLATFORM_LENGTH,
  MAX_USER_AGENT_LENGTH,
  hashToken,
} from './index.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function store(now = { value: 1000 }): { devices: DeviceStore; now: { value: number } } {
  const devices = new DeviceStore({ path: ':memory:', now: () => now.value });
  cleanup.push(() => devices.close());
  return { devices, now };
}

describe('device store', () => {
  it('creates a dev_ device with a 256-bit base64url token and authenticates it', () => {
    const { devices } = store();
    const { device, token } = devices.create({ displayName: '  iPhone (Safari) ', platform: 'ios-web', userAgent: 'UA' });
    expect(device.clientId).toMatch(/^dev_[0-9a-f]{16}$/);
    expect(device).toMatchObject({ displayName: 'iPhone (Safari)', platform: 'ios-web', userAgent: 'UA', createdAt: 1000, lastSeenAt: 1000 });
    expect(Buffer.from(token, 'base64url')).toHaveLength(DEVICE_TOKEN_BYTES);
    expect(devices.authenticate(token)).toBe(device.clientId);
    expect(devices.authenticate('not-a-token')).toBeNull();
    expect(devices.authenticate('')).toBeNull();
    expect(devices.get(device.clientId)).toEqual(device);
    expect(devices.get('dev_missing')).toBeUndefined();
  });

  it('stores only the SHA-256 of the token', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-devices-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'nested', 'journal.sqlite');
    const devices = new DeviceStore({ path: file });
    const { token } = devices.create({ displayName: 'Mac', platform: 'macos' });
    devices.close();
    const db = new DatabaseSync(file);
    const rows = db.prepare('SELECT * FROM devices').all();
    db.close();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shares the Journal file and survives a reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-devices-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'journal.sqlite');
    const journal = new Journal({ path: file });
    cleanup.push(() => journal.close());
    const first = new DeviceStore({ path: file });
    const { device, token } = first.create({ displayName: 'Phone', platform: 'ios-web' });
    first.close();
    first.close();
    const second = new DeviceStore({ path: file });
    cleanup.push(() => second.close());
    expect(second.authenticate(token)).toBe(device.clientId);
    expect(second.path).toBe(file);
  });

  it('updates lastSeenAt on authentication', () => {
    const { devices, now } = store();
    const { device, token } = devices.create({ displayName: 'Phone', platform: 'ios-web' });
    devices.authenticate(token);
    expect(devices.get(device.clientId)!.lastSeenAt).toBe(1000);
    now.value = 2000;
    devices.authenticate(token);
    expect(devices.get(device.clientId)).toMatchObject({ createdAt: 1000, lastSeenAt: 2000 });
  });

  it('lists devices oldest first, renames and revokes', () => {
    const { devices, now } = store();
    const a = devices.create({ displayName: 'A', platform: 'ios-web' });
    now.value = 1500;
    const b = devices.create({ displayName: 'B', platform: 'macos' });
    expect(devices.list().map((d) => d.displayName)).toEqual(['A', 'B']);
    expect(devices.rename(a.device.clientId, 'A2')).toBe(true);
    expect(devices.rename('dev_missing', 'x')).toBe(false);
    expect(devices.revoke(a.device.clientId)).toBe(true);
    expect(devices.revoke(a.device.clientId)).toBe(false);
    expect(devices.authenticate(a.token)).toBeNull();
    expect(devices.get(a.device.clientId)).toBeUndefined();
    expect(devices.rename(a.device.clientId, 'again')).toBe(false);
    expect(devices.list().map((d) => d.clientId)).toEqual([b.device.clientId]);
    expect(devices.authenticate(b.token)).toBe(b.device.clientId);
  });

  it('cuts overlong client strings', () => {
    const { devices } = store();
    const { device } = devices.create({
      displayName: 'n'.repeat(500),
      platform: 'p'.repeat(500),
      userAgent: 'u'.repeat(5000),
    });
    expect(device.displayName).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
    expect(device.platform).toHaveLength(MAX_PLATFORM_LENGTH);
    expect(device.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
  });

  it('defaults to the wall clock', () => {
    const devices = new DeviceStore({ path: ':memory:' });
    cleanup.push(() => devices.close());
    const before = Math.floor(Date.now() / 1000);
    const { device } = devices.create({ displayName: 'x', platform: 'y' });
    expect(device.createdAt).toBeGreaterThanOrEqual(before);
    expect(device.userAgent).toBe('');
  });
});
