// The device store (protocol-v1.md section 8): one row per paired client. The host keeps only the
// SHA-256 of each device token; the token itself lives in the client's cookie or keychain.
//
// The table sits next to the Journal: same SQLite file by default (`defaultJournalPath()`), its own
// connection in WAL mode, so the two never block each other for long. Revoking a device clears its hash
// and marks the row; a revoked row never authenticates again and is not listed.
//
// Web Push subscriptions (spec 9) live on the same connection (`push`): foreign keys are on, so deleting
// a device row cascades to its subscriptions, and revoking one deletes them in the same transaction.
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { ensurePrivateFile, tightenSqliteSideFiles } from '../config/private-files.js';
import { defaultJournalPath } from '../journal/journal.js';
import { PushSubscriptionStore } from '../push/subscriptions.js';

/** Random bytes per device token: 256 bits (spec 8). Security-pass seam. */
export const DEVICE_TOKEN_BYTES = 32;

/** Hash the host stores instead of the token (spec 8). Security-pass seam. */
export const TOKEN_HASH_ALGORITHM = 'sha256';

/** Prefix of every clientId (spec 0: `dev_...`). */
export const CLIENT_ID_PREFIX = 'dev_';

/** Longest display name, in UTF-16 code units, after trimming. Longer names are cut (pairing) or refused (rename). */
export const MAX_DISPLAY_NAME_LENGTH = 100;

/** Longest stored platform and user agent strings; longer values are cut. */
export const MAX_PLATFORM_LENGTH = 64;
export const MAX_USER_AGENT_LENGTH = 512;

/** A paired device as the host stores it (without the token hash). Times are Unix seconds. */
export interface DeviceRecord {
  clientId: string;
  displayName: string;
  platform: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface NewDevice {
  displayName: string;
  platform: string;
  userAgent?: string;
}

export interface DeviceStoreOptions {
  /** Database file, or ":memory:". Defaults to the Journal's file; parent directories are created. */
  path?: string;
  /** Clock in Unix seconds. */
  now?: () => number;
}

/** Hex digest of a device token. The only form in which a token is stored or compared. */
export function hashToken(token: string): string {
  return createHash(TOKEN_HASH_ALGORITHM).update(token, 'utf8').digest('hex');
}

/** A fresh device token: DEVICE_TOKEN_BYTES random bytes, base64url (cookie- and header-safe). */
export function newDeviceToken(): string {
  return randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
}

export function newClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(8).toString('hex')}`;
}

/** Trims and cuts a client-supplied string to `max` code units. */
export function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  client_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`;

type Row = Record<string, unknown>;

function toRecord(row: Row): DeviceRecord {
  return {
    clientId: row.client_id as string,
    displayName: row.display_name as string,
    platform: row.platform as string,
    userAgent: row.user_agent as string,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

const COLUMNS = 'client_id, display_name, platform, user_agent, created_at, last_seen_at';

export class DeviceStore {
  readonly path: string;
  /** The push subscriptions of the paired devices (same file, same connection). */
  readonly push: PushSubscriptionStore;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly statements: {
    insert: StatementSync;
    byHash: StatementSync;
    touch: StatementSync;
    get: StatementSync;
    list: StatementSync;
    rename: StatementSync;
    revoke: StatementSync;
  };

  constructor(options: DeviceStoreOptions = {}) {
    this.path = options.path ?? defaultJournalPath();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    // Session content and device hashes: 0600 from the first byte (security pass item 5).
    if (this.path !== ':memory:') ensurePrivateFile(this.path);
    this.db = new DatabaseSync(this.path, { timeout: 5000 });
    if (this.path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      tightenSqliteSideFiles(this.path);
    }
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(SCHEMA);
    this.push = new PushSubscriptionStore(this.db, this.now);
    this.statements = {
      insert: this.db.prepare(
        `INSERT INTO devices (client_id, display_name, platform, user_agent, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      byHash: this.db.prepare(
        'SELECT client_id, last_seen_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL',
      ),
      touch: this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE client_id = ?'),
      get: this.db.prepare(`SELECT ${COLUMNS} FROM devices WHERE client_id = ? AND revoked_at IS NULL`),
      list: this.db.prepare(`SELECT ${COLUMNS} FROM devices WHERE revoked_at IS NULL ORDER BY created_at, client_id`),
      rename: this.db.prepare('UPDATE devices SET display_name = ? WHERE client_id = ? AND revoked_at IS NULL'),
      revoke: this.db.prepare(
        'UPDATE devices SET token_hash = NULL, revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL',
      ),
    };
  }

  /** Pairs a new device. Returns its record and its token; the token is not kept and cannot be read again. */
  create(input: NewDevice): { device: DeviceRecord; token: string } {
    const now = this.now();
    const device: DeviceRecord = {
      clientId: newClientId(),
      displayName: clip(input.displayName, MAX_DISPLAY_NAME_LENGTH),
      platform: clip(input.platform, MAX_PLATFORM_LENGTH),
      userAgent: clip(input.userAgent ?? '', MAX_USER_AGENT_LENGTH),
      createdAt: now,
      lastSeenAt: now,
    };
    const token = newDeviceToken();
    this.statements.insert.run(
      device.clientId,
      device.displayName,
      device.platform,
      device.userAgent,
      hashToken(token),
      device.createdAt,
      device.lastSeenAt,
    );
    return { device, token };
  }

  /**
   * Device token to clientId, or null when unknown or revoked; records the device as seen now. The lookup
   * is by hash, so the database index never sees the token and its timing reveals nothing about it.
   */
  authenticate(token: string): string | null {
    if (token.length === 0) return null;
    const row = this.statements.byHash.get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    const clientId = row.client_id as string;
    const now = this.now();
    if (Number(row.last_seen_at) !== now) this.statements.touch.run(now, clientId);
    return clientId;
  }

  get(clientId: string): DeviceRecord | undefined {
    const row = this.statements.get.get(clientId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Paired (not revoked) devices, oldest first. */
  list(): DeviceRecord[] {
    return (this.statements.list.all() as Row[]).map(toRecord);
  }

  /** False when the device is unknown or revoked. The caller validates the name. */
  rename(clientId: string, displayName: string): boolean {
    return Number(this.statements.rename.run(displayName, clientId).changes) > 0;
  }

  /**
   * Clears the token hash so the token never authenticates again, and drops the device's push
   * subscriptions in the same transaction (a revoked phone must not keep getting titles). False when
   * unknown or already revoked.
   */
  revoke(clientId: string): boolean {
    return this.push.transaction(() => {
      const revoked = Number(this.statements.revoke.run(this.now(), clientId).changes) > 0;
      if (revoked) this.push.unsubscribe(clientId);
      return revoked;
    });
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
