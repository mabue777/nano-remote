import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { DeviceStore } from '../devices/store.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nano-push-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'journal.sqlite');
}

function open(file = ':memory:', now = { value: 1000 }): DeviceStore {
  const devices = new DeviceStore({ path: file, now: () => now.value });
  cleanup.push(() => devices.close());
  return devices;
}

const sub = (n: number) => ({
  endpoint: `https://push.example/send/${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
});

describe('push subscription store', () => {
  it('stores one subscription per client; a new endpoint replaces the old one', () => {
    const now = { value: 1000 };
    const devices = open(':memory:', now);
    const phone = devices.create({ displayName: 'Phone', platform: 'ios-web' }).device.clientId;
    const laptop = devices.create({ displayName: 'Laptop', platform: 'macos' }).device.clientId;
    expect(devices.push.isSubscribed(phone)).toBe(false);
    expect(devices.push.get(phone)).toBeUndefined();

    expect(devices.push.subscribe(phone, { ...sub(1), expirationTime: null, extra: 'dropped' })).toBe(true);
    expect(devices.push.isSubscribed(phone)).toBe(true);
    expect(devices.push.get(phone)).toEqual({ clientId: phone, subscription: sub(1), createdAt: 1000 });

    // Same endpoint again: upsert, still one row.
    now.value = 1500;
    expect(devices.push.subscribe(phone, sub(1))).toBe(true);
    expect(devices.push.list()).toEqual([{ clientId: phone, subscription: sub(1), createdAt: 1500 }]);

    // pushsubscriptionchange: a new endpoint, only the newest stays.
    now.value = 2000;
    devices.push.subscribe(phone, sub(2));
    now.value = 2500;
    devices.push.subscribe(laptop, sub(3));
    expect(devices.push.list()).toEqual([
      { clientId: phone, subscription: sub(2), createdAt: 2000 },
      { clientId: laptop, subscription: sub(3), createdAt: 2500 },
    ]);

    expect(devices.push.unsubscribe(phone)).toBe(1);
    expect(devices.push.unsubscribe(phone)).toBe(0);
    expect(devices.push.isSubscribed(phone)).toBe(false);
    expect(devices.push.list().map((r) => r.clientId)).toEqual([laptop]);
  });

  it('refuses unknown and revoked clients', () => {
    const devices = open();
    expect(devices.push.subscribe('dev_missing', sub(1))).toBe(false);
    const phone = devices.create({ displayName: 'Phone', platform: 'ios-web' }).device.clientId;
    devices.revoke(phone);
    expect(devices.push.subscribe(phone, sub(1))).toBe(false);
    expect(devices.push.list()).toEqual([]);
  });

  it('deletes by endpoint (push service answered 404 or 410)', () => {
    const devices = open();
    const phone = devices.create({ displayName: 'Phone', platform: 'ios-web' }).device.clientId;
    const laptop = devices.create({ displayName: 'Laptop', platform: 'macos' }).device.clientId;
    devices.push.subscribe(phone, sub(1));
    devices.push.subscribe(laptop, sub(2));
    expect(devices.push.deleteByEndpoint(sub(1).endpoint)).toBe(1);
    expect(devices.push.deleteByEndpoint(sub(1).endpoint)).toBe(0);
    expect(devices.push.list().map((r) => r.clientId)).toEqual([laptop]);
  });

  it('revoking a device drops its subscriptions; other devices keep theirs', () => {
    const devices = open();
    const phone = devices.create({ displayName: 'Phone', platform: 'ios-web' }).device.clientId;
    const laptop = devices.create({ displayName: 'Laptop', platform: 'macos' }).device.clientId;
    devices.push.subscribe(phone, sub(1));
    devices.push.subscribe(laptop, sub(2));
    expect(devices.revoke(phone)).toBe(true);
    expect(devices.push.isSubscribed(phone)).toBe(false);
    expect(devices.push.isSubscribed(laptop)).toBe(true);
    expect(devices.revoke(phone)).toBe(false);
  });

  it('rolls back a failed transaction', () => {
    const devices = open();
    const phone = devices.create({ displayName: 'Phone', platform: 'ios-web' }).device.clientId;
    devices.push.subscribe(phone, sub(1));
    expect(() =>
      devices.push.transaction(() => {
        devices.push.unsubscribe(phone);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(devices.push.isSubscribed(phone)).toBe(true);
  });

  it('deleting a device row cascades to its subscriptions (foreign keys on, same file, still 0600)', () => {
    const file = tempFile();
    const devices = open(file);
    const phone = devices.create({ displayName: 'Phone', platform: 'ios-web' }).device.clientId;
    devices.push.subscribe(phone, sub(1));
    devices.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // The table is in the device store's file, with the designed shape.
    const db = new DatabaseSync(file);
    cleanup.push(() => db.isOpen && db.close());
    const columns = db.prepare('PRAGMA table_info(push_subscriptions)').all().map((c) => [c.name, c.pk]);
    expect(columns).toEqual([
      ['client_id', 1],
      ['endpoint', 2],
      ['subscription', 0],
      ['created_at', 0],
    ]);
    expect(db.prepare('PRAGMA foreign_key_list(push_subscriptions)').all()).toMatchObject([
      { table: 'devices', from: 'client_id', to: 'client_id', on_delete: 'CASCADE' },
    ]);
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM devices WHERE client_id = ?').run(phone);
    expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
    db.close();

    // Reopening keeps the mode and enables foreign keys on the store's own connection.
    const again = open(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(again.push.subscribe(phone, sub(1))).toBe(false);
    const other = again.create({ displayName: 'Laptop', platform: 'macos' }).device.clientId;
    again.push.subscribe(other, sub(2));
    again.close();
    const check = new DatabaseSync(file);
    cleanup.push(() => check.isOpen && check.close());
    expect(() => check.exec("PRAGMA foreign_keys = ON; INSERT INTO push_subscriptions VALUES ('dev_none', 'e', '{}', 1)")).toThrow(
      /FOREIGN KEY/,
    );
    expect(JSON.parse((check.prepare('SELECT subscription FROM push_subscriptions').get() as { subscription: string }).subscription)).toEqual(sub(2));
  });
});
