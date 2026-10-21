// Web Push subscriptions (protocol-v1.md section 9, ADR 0005): the browser's `PushSubscription` JSON per
// paired device, in the same SQLite file and on the same connection as the device store
// (docs/security/host-v0-pass.md item 6). The device store owns the connection and creates this store,
// so revoking a device can drop its subscriptions in the same transaction that clears its token hash.
//
// One subscription per client: a browser that re-subscribes (after `pushsubscriptionchange`, or a fresh
// `pushManager.subscribe`) replaces its old endpoint, so a phone never gets the same push twice.
//
// The endpoint and `keys.auth` are capabilities: anyone holding them can push to the device. Nothing in
// this module logs, and callers log the clientId and the event name only.
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { PushSubscription } from '../generated/common.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  client_id TEXT NOT NULL REFERENCES devices(client_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  subscription TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, endpoint)
);
`;

/** A stored subscription and the device it belongs to. */
export interface StoredPushSubscription {
  clientId: string;
  subscription: PushSubscription;
  /** Unix seconds. */
  createdAt: number;
}

type Row = Record<string, unknown>;

function toStored(row: Row): StoredPushSubscription {
  return {
    clientId: row.client_id as string,
    subscription: JSON.parse(row.subscription as string) as PushSubscription,
    createdAt: Number(row.created_at),
  };
}

/** The fields sending needs (RFC 8291): the endpoint and the two keys. Anything else is dropped. */
function normalize({ endpoint, keys }: PushSubscription): PushSubscription {
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export class PushSubscriptionStore {
  private readonly statements: {
    clear: StatementSync;
    insert: StatementSync;
    has: StatementSync;
    list: StatementSync;
    byClient: StatementSync;
    deleteEndpoint: StatementSync;
  };

  /** `db` is the device store's connection; the `devices` table must exist. Foreign keys are switched on. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {
    // Off by default in SQLite, per connection: without it ON DELETE CASCADE does nothing.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    this.statements = {
      clear: db.prepare('DELETE FROM push_subscriptions WHERE client_id = ?'),
      // Only a paired, not revoked device may subscribe; a revoke racing a subscribe stores nothing.
      insert: db.prepare(
        `INSERT INTO push_subscriptions (client_id, endpoint, subscription, created_at)
         SELECT client_id, ?, ?, ? FROM devices WHERE client_id = ? AND revoked_at IS NULL`,
      ),
      has: db.prepare('SELECT 1 FROM push_subscriptions WHERE client_id = ? LIMIT 1'),
      list: db.prepare('SELECT client_id, subscription, created_at FROM push_subscriptions ORDER BY created_at, client_id'),
      byClient: db.prepare('SELECT client_id, subscription, created_at FROM push_subscriptions WHERE client_id = ?'),
      deleteEndpoint: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    };
  }

  /**
   * Stores `subscription` as the client's only one, replacing any earlier endpoint. The caller has checked
   * the shape. False when the client is unknown or revoked (nothing is stored then).
   */
  subscribe(clientId: string, subscription: PushSubscription): boolean {
    const kept = normalize(subscription);
    return this.transaction(() => {
      this.statements.clear.run(clientId);
      const changes = this.statements.insert.run(kept.endpoint, JSON.stringify(kept), this.now(), clientId).changes;
      return Number(changes) > 0;
    });
  }

  /** Removes every subscription of the client. Returns how many were removed. */
  unsubscribe(clientId: string): number {
    return Number(this.statements.clear.run(clientId).changes);
  }

  isSubscribed(clientId: string): boolean {
    return this.statements.has.get(clientId) !== undefined;
  }

  /** The client's subscription, or undefined. */
  get(clientId: string): StoredPushSubscription | undefined {
    const row = this.statements.byClient.get(clientId) as Row | undefined;
    return row ? toStored(row) : undefined;
  }

  /** Every stored subscription, oldest first: the sender evaluates each client separately (spec 9). */
  list(): StoredPushSubscription[] {
    return (this.statements.list.all() as Row[]).map(toStored);
  }

  /** Drops an endpoint the push service answered 404 or 410 for. Returns how many rows were removed. */
  deleteByEndpoint(endpoint: string): number {
    return Number(this.statements.deleteEndpoint.run(endpoint).changes);
  }

  /** Runs `fn` in a transaction on the shared connection (the device store uses it for revoke). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
