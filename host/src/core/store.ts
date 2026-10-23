// What the session core keeps beside the Journal: facts about a session that are not protocol events.
// The engine's own session id (needed to resume after a restart), whether the session was archived or
// deleted, which turn each `clientMessageId` produced (turn/start idempotency, spec 7), and the git trees
// recorded when each turn started and ended (turn/diff, spec 7). SQLite through
// node:sqlite like the Journal; production points it at the Journal's file (separate tables).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS core_sessions (
  session_id TEXT PRIMARY KEY,
  engine_session_id TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS core_client_messages (
  session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY (session_id, client_message_id)
);
CREATE TABLE IF NOT EXISTS core_turn_trees (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  start_tree TEXT NOT NULL DEFAULT '',
  end_tree TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, turn_id)
);
`;

/** The git trees of one turn's session folder; absent when no snapshot was recorded. */
export interface TurnTrees {
  start?: string;
  end?: string;
}

export interface SessionRecord {
  engineSessionId: string;
  archived: boolean;
  deleted: boolean;
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly sql: Record<string, StatementSync>;

  /** `file` is a database path or ":memory:" (the default). Parent directories are created. */
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    const p = (source: string) => this.db.prepare(source);
    this.sql = {
      ensure: p('INSERT OR IGNORE INTO core_sessions (session_id) VALUES (?)'),
      get: p('SELECT engine_session_id, archived, deleted FROM core_sessions WHERE session_id = ?'),
      setEngine: p('UPDATE core_sessions SET engine_session_id = ? WHERE session_id = ?'),
      setArchived: p('UPDATE core_sessions SET archived = ? WHERE session_id = ?'),
      setDeleted: p('UPDATE core_sessions SET deleted = 1 WHERE session_id = ?'),
      turnFor: p('SELECT turn_id FROM core_client_messages WHERE session_id = ? AND client_message_id = ?'),
      remember: p('INSERT OR IGNORE INTO core_client_messages (session_id, client_message_id, turn_id) VALUES (?, ?, ?)'),
      ensureTurn: p('INSERT OR IGNORE INTO core_turn_trees (session_id, turn_id) VALUES (?, ?)'),
      setStartTree: p('UPDATE core_turn_trees SET start_tree = ? WHERE session_id = ? AND turn_id = ?'),
      setEndTree: p('UPDATE core_turn_trees SET end_tree = ? WHERE session_id = ? AND turn_id = ?'),
      trees: p('SELECT start_tree, end_tree FROM core_turn_trees WHERE session_id = ? AND turn_id = ?'),
    };
  }

  /** The record of a session; sessions the store never saw count as live, not archived, no engine id. */
  get(sessionId: string): SessionRecord {
    const row = this.sql.get!.get(sessionId);
    return {
      engineSessionId: row ? String(row.engine_session_id) : '',
      archived: row ? Number(row.archived) === 1 : false,
      deleted: row ? Number(row.deleted) === 1 : false,
    };
  }

  setEngineSessionId(sessionId: string, engineSessionId: string): void {
    this.sql.ensure!.run(sessionId);
    this.sql.setEngine!.run(engineSessionId, sessionId);
  }

  setArchived(sessionId: string, archived: boolean): void {
    this.sql.ensure!.run(sessionId);
    this.sql.setArchived!.run(archived ? 1 : 0, sessionId);
  }

  markDeleted(sessionId: string): void {
    this.sql.ensure!.run(sessionId);
    this.sql.setDeleted!.run(sessionId);
  }

  /** The turn an earlier `turn/start` or `turn/steer` with this clientMessageId produced. */
  turnFor(sessionId: string, clientMessageId: string): string | undefined {
    const row = this.sql.turnFor!.get(sessionId, clientMessageId);
    return row ? String(row.turn_id) : undefined;
  }

  rememberClientMessage(sessionId: string, clientMessageId: string, turnId: string): void {
    this.sql.remember!.run(sessionId, clientMessageId, turnId);
  }

  /** Records the tree of the session folder at the start or the end of a turn. */
  setTurnTree(sessionId: string, turnId: string, which: 'start' | 'end', tree: string): void {
    this.sql.ensureTurn!.run(sessionId, turnId);
    (which === 'start' ? this.sql.setStartTree! : this.sql.setEndTree!).run(tree, sessionId, turnId);
  }

  turnTrees(sessionId: string, turnId: string): TurnTrees {
    const row = this.sql.trees!.get(sessionId, turnId);
    const trees: TurnTrees = {};
    if (row && String(row.start_tree) !== '') trees.start = String(row.start_tree);
    if (row && String(row.end_tree) !== '') trees.end = String(row.end_tree);
    return trees;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
