// The Journal: the host-side, per-session, sequence-numbered event log that is the single source of
// truth for a session (CONTEXT.md "Journal"; protocol-v1.md sections 5.2, 5.3, 6).
//
// Storage is SQLite through node:sqlite. Every append runs in one write transaction that allocates the
// next seq, stores the event and updates the materialized views the read paths need (session summary,
// turns, items, pending requests), so a reader never sees an event without its effects. node:sqlite is
// synchronous: within one process an append, a read and a subscriber attach never interleave, which is
// what makes the subscribe guarantee below hold without locks.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import { AlreadyResolved, CursorExpired, InvalidParams } from './errors.js';
import {
  MAX_ITEMS_PER_TURN,
  applyDelta,
  bindItem,
  inlineTurn,
  mergeTurn,
  placeholderTurn,
  previewOf,
} from './reconstruct.js';
import type {
  ApprovalRequest,
  EventInput,
  HistoryResult,
  InputRequest,
  Item,
  JournalEvent,
  JournalMethod,
  ListResult,
  Listener,
  Pending,
  Session,
  SessionStatus,
  SessionSummary,
  Settings,
  SinceResult,
  SnapshotResult,
  Subscription,
  Turn,
  TurnStatus,
  TurnWithItems,
} from './types.js';

const JOURNAL_METHODS: ReadonlySet<string> = new Set<JournalMethod>([
  'session/changed',
  'status/changed',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/delta',
  'item/completed',
  'approval/request',
  'input/request',
  'request/resolved',
  'usage/updated',
  'session/closed',
]);

export const DEFAULT_SINCE_LIMIT = 500;
export const MAX_SINCE_LIMIT = 5000;
export const DEFAULT_SNAPSHOT_TURNS = 5;
export const MAX_SNAPSHOT_TURNS = 50;
export const DEFAULT_HISTORY_LIMIT = 5;
export const MAX_HISTORY_LIMIT = 50;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
const SCHEMA_VERSION = 1;

/** `~/Library/Application Support/NanoHost/journal.sqlite`, the host's default Journal file. */
export function defaultJournalPath(home = homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'NanoHost', 'journal.sqlite');
}

export interface JournalOptions {
  /** Database file, or ":memory:". Defaults to `defaultJournalPath()`; parent directories are created. */
  path?: string;
  /** Clock in Unix seconds, for `createdAt`/`updatedAt` and placeholder turns. */
  now?: () => number;
  /** Called when a subscriber's listener throws; the event still counts as delivered. */
  onListenerError?: (error: unknown, event: JournalEvent) => void;
}

export interface SubscribeOptions {
  /**
   * Deliver every event with seq greater than this, then live events. Pass the `cursor` of the
   * `since()` or `snapshot()` read just served. Defaults to the current head (live events only).
   */
  after?: number;
  /** Called once if the subscription ends because the events it needs were compacted away. */
  onExpired?: (error: CursorExpired) => void;
}

export interface ListOptions {
  agentId?: string;
  cursor?: string;
  limit?: number;
}

type Row = Record<string, unknown>;

interface SubscriberState {
  readonly sessionId: string;
  handle?: Subscription;
  readonly listener: Listener;
  readonly onExpired: ((error: CursorExpired) => void) | undefined;
  delivered: number;
  pumping: boolean;
  closed: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  head INTEGER NOT NULL DEFAULT 0,
  floor INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_turn_status TEXT,
  last_turn_ordinal INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  pending_approvals INTEGER NOT NULL DEFAULT 0,
  pending_inputs INTEGER NOT NULL DEFAULT 0,
  turn_ordinals INTEGER NOT NULL DEFAULT 0,
  item_ordinals INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_by_update ON sessions (updated_at DESC, session_id DESC);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  method TEXT NOT NULL,
  params TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS turns_by_ordinal ON turns (session_id, ordinal);
CREATE TABLE IF NOT EXISTS items (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, item_id)
);
CREATE INDEX IF NOT EXISTS items_by_turn ON items (session_id, turn_id, ordinal);
CREATE TABLE IF NOT EXISTS requests (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  family TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  resolved_seq INTEGER,
  resolved_by TEXT,
  PRIMARY KEY (session_id, request_id)
);
CREATE INDEX IF NOT EXISTS requests_open ON requests (session_id, resolved_seq, seq);
`;

function int(value: unknown): number {
  return Number(value);
}

function str(value: unknown): string {
  return String(value);
}

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function checkCount(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new InvalidParams(`${name} must be a positive integer`);
  return Math.min(value, max);
}

function checkSeq(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new InvalidParams(`${name} must be a non-negative integer`);
  return value;
}

const TURN_CURSOR = /^turn:([1-9][0-9]*)$/;

function turnCursor(ordinal: number): string {
  return `turn:${ordinal}`;
}

function parseTurnCursor(cursor: string): number {
  const match = TURN_CURSOR.exec(cursor);
  if (!match) throw new InvalidParams(`invalid history cursor ${JSON.stringify(cursor)}`);
  return Number(match[1]);
}

function listCursor(updatedAt: number, sessionId: string): string {
  return Buffer.from(JSON.stringify([updatedAt, sessionId])).toString('base64url');
}

function parseListCursor(cursor: string): [number, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isInteger(value[0]) &&
      typeof value[1] === 'string'
    ) {
      return [value[0] as number, value[1]];
    }
  } catch {
    // fall through
  }
  throw new InvalidParams(`invalid session list cursor ${JSON.stringify(cursor)}`);
}

export class Journal {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly onListenerError: (error: unknown, event: JournalEvent) => void;
  private readonly subscribers = new Map<string, Set<SubscriberState>>();
  private readonly sql: Record<string, StatementSync>;

  constructor(options: JournalOptions = {}) {
    this.path = options.path ?? defaultJournalPath();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.onListenerError =
      options.onListenerError ??
      ((error, event) => {
        console.error(`journal: listener failed on ${event.method} seq ${event.params.seq}`, error);
      });
    if (this.path !== ':memory:') mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { timeout: 5000 });
    if (this.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    // FULL: a committed append survives power loss, not only a crash of the host process.
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(SCHEMA);
    this.db
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('schemaVersion', String(SCHEMA_VERSION));
    this.sql = this.prepareStatements();
  }

  private prepareStatements(): Record<string, StatementSync> {
    const p = (source: string) => this.db.prepare(source);
    return {
      ensureSession: p(
        'INSERT OR IGNORE INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)',
      ),
      nextSeq: p(
        'UPDATE sessions SET head = head + 1, updated_at = ? WHERE session_id = ? RETURNING head',
      ),
      insertEvent: p('INSERT INTO events (session_id, seq, method, params) VALUES (?, ?, ?, ?)'),
      head: p('SELECT head, floor FROM sessions WHERE session_id = ?'),
      eventsAfter: p(
        'SELECT seq, method, params FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?',
      ),
      session: p('SELECT * FROM sessions WHERE session_id = ?'),
      setSessionInfo: p(
        'UPDATE sessions SET agent_id = ?, title = ?, cwd = ?, settings = ? WHERE session_id = ?',
      ),
      setStatus: p('UPDATE sessions SET status = ? WHERE session_id = ?'),
      setPreview: p('UPDATE sessions SET preview = ? WHERE session_id = ?'),
      setLastTurn: p(
        'UPDATE sessions SET last_turn_status = ?, last_turn_ordinal = ? WHERE session_id = ? AND last_turn_ordinal <= ?',
      ),
      nextTurnOrdinal: p(
        'UPDATE sessions SET turn_ordinals = turn_ordinals + 1 WHERE session_id = ? RETURNING turn_ordinals',
      ),
      nextItemOrdinal: p(
        'UPDATE sessions SET item_ordinals = item_ordinals + 1 WHERE session_id = ? RETURNING item_ordinals',
      ),
      turn: p('SELECT ordinal, data FROM turns WHERE session_id = ? AND turn_id = ?'),
      insertTurn: p('INSERT INTO turns (session_id, turn_id, ordinal, data) VALUES (?, ?, ?, ?)'),
      updateTurn: p('UPDATE turns SET data = ? WHERE session_id = ? AND turn_id = ?'),
      newestTurns: p(
        'SELECT ordinal, data FROM turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?',
      ),
      turnsBefore: p(
        'SELECT ordinal, data FROM turns WHERE session_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?',
      ),
      hasTurnBefore: p('SELECT 1 FROM turns WHERE session_id = ? AND ordinal < ? LIMIT 1'),
      item: p('SELECT data FROM items WHERE session_id = ? AND item_id = ?'),
      insertItem: p(
        'INSERT INTO items (session_id, item_id, turn_id, ordinal, data) VALUES (?, ?, ?, ?, ?)',
      ),
      updateItem: p('UPDATE items SET turn_id = ?, data = ? WHERE session_id = ? AND item_id = ?'),
      newestItems: p(
        'SELECT data FROM items WHERE session_id = ? AND turn_id = ? ORDER BY ordinal DESC LIMIT ?',
      ),
      request: p('SELECT family, resolved_seq, resolved_by FROM requests WHERE session_id = ? AND request_id = ?'),
      insertRequest: p(
        'INSERT INTO requests (session_id, request_id, family, seq, data) VALUES (?, ?, ?, ?, ?)',
      ),
      updateRequest: p('UPDATE requests SET data = ? WHERE session_id = ? AND request_id = ?'),
      resolveRequest: p(
        'UPDATE requests SET resolved_seq = ?, resolved_by = ? WHERE session_id = ? AND request_id = ?',
      ),
      openRequests: p(
        'SELECT family, data FROM requests WHERE session_id = ? AND resolved_seq IS NULL ORDER BY seq',
      ),
      bumpPending: p(
        'UPDATE sessions SET pending_approvals = pending_approvals + ?, pending_inputs = pending_inputs + ? WHERE session_id = ?',
      ),
      compact: p('DELETE FROM events WHERE session_id = ? AND seq <= ?'),
      setFloor: p('UPDATE sessions SET floor = ? WHERE session_id = ? AND floor < ?'),
    };
  }

  // ---- writing ---------------------------------------------------------------------------------

  /**
   * Appends one event and returns it with its seq. Seq is dense per session starting at 1, assigned
   * in commit order (the first append to commit gets the lower seq, also across connections to the
   * same file), durable once this returns, and never reused. Subscribers are notified after commit.
   * Throws `AlreadyResolved` for a second `request/resolved` of one request; nothing is appended then.
   */
  append(sessionId: string, input: EventInput): JournalEvent {
    if (typeof sessionId !== 'string' || sessionId === '') throw new InvalidParams('sessionId is required');
    if (!input || !JOURNAL_METHODS.has(input.method)) {
      throw new InvalidParams(`not a Journal event method: ${String(input?.method)}`);
    }
    if (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params)) {
      throw new InvalidParams(`params of ${input.method} must be an object`);
    }
    const { sessionId: _ignoredSession, seq: _ignoredSeq, ...params } = input.params as Row;
    const now = this.now();
    let event: JournalEvent;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.sql.ensureSession!.run(sessionId, now, now);
      const seq = int(this.sql.nextSeq!.get(now, sessionId)!.head);
      event = { method: input.method, params: { sessionId, seq, ...params } } as JournalEvent;
      this.project(sessionId, event, now);
      this.sql.insertEvent!.run(sessionId, seq, input.method, JSON.stringify(params));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.notify(event);
    return event;
  }

  /** Updates the materialized views for one event inside the append transaction. */
  private project(sessionId: string, event: JournalEvent, now: number): void {
    const s = this.sql;
    switch (event.method) {
      case 'session/changed': {
        const { agentId, title, cwd, settings } = event.params.session;
        const current = s.session!.get(sessionId)!;
        s.setSessionInfo!.run(
          typeof agentId === 'string' ? agentId : str(current.agent_id),
          typeof title === 'string' ? title : str(current.title),
          typeof cwd === 'string' ? cwd : str(current.cwd),
          settings && typeof settings === 'object' ? JSON.stringify(settings) : str(current.settings),
          sessionId,
        );
        break;
      }
      case 'status/changed':
        s.setStatus!.run(event.params.status, sessionId);
        break;
      case 'session/closed':
        s.setStatus!.run('closed', sessionId);
        break;
      case 'turn/started':
      case 'turn/completed': {
        const turn = event.params.turn;
        this.upsertTurn(sessionId, turn.turnId, (previous) => mergeTurn(previous, turn));
        break;
      }
      case 'item/started':
      case 'item/completed': {
        const { turnId } = event.params;
        if (!s.turn!.get(sessionId, turnId)) this.upsertTurn(sessionId, turnId, () => placeholderTurn(turnId, now));
        const item = bindItem(event.params.item, turnId);
        this.putItem(sessionId, item);
        if (event.method === 'item/completed') {
          const preview = previewOf(item);
          if (preview !== undefined) s.setPreview!.run(preview, sessionId);
        }
        break;
      }
      case 'item/delta': {
        const row = s.item!.get(sessionId, event.params.itemId);
        if (row) {
          const item = applyDelta(parse<Item>(row.data), event.params.field, event.params.delta);
          s.updateItem!.run(item.turnId, JSON.stringify(item), sessionId, item.itemId);
        }
        break;
      }
      case 'approval/request':
      case 'input/request': {
        const family = event.method === 'approval/request' ? 'approval' : 'input';
        const request = event.params.request;
        const existing = s.request!.get(sessionId, request.requestId);
        if (existing) {
          s.updateRequest!.run(JSON.stringify(request), sessionId, request.requestId);
        } else {
          s.insertRequest!.run(sessionId, request.requestId, family, event.params.seq, JSON.stringify(request));
          s.bumpPending!.run(family === 'approval' ? 1 : 0, family === 'input' ? 1 : 0, sessionId);
        }
        break;
      }
      case 'request/resolved': {
        const { requestId, resolvedBy } = event.params;
        const existing = s.request!.get(sessionId, requestId);
        if (!existing) break;
        if (existing.resolved_seq !== null) throw new AlreadyResolved(requestId, str(existing.resolved_by));
        s.resolveRequest!.run(event.params.seq, resolvedBy, sessionId, requestId);
        const family = str(existing.family);
        s.bumpPending!.run(family === 'approval' ? -1 : 0, family === 'input' ? -1 : 0, sessionId);
        break;
      }
      default:
        // usage/updated: journaled for replay, no materialized state.
        break;
    }
  }

  /**
   * Inserts or rewrites a turn row. Ordinals number a session's turns in order of first appearance; the
   * summary's `lastTurnStatus` follows the turn with the highest ordinal.
   */
  private upsertTurn(sessionId: string, turnId: string, update: (previous: Turn | undefined) => Turn): void {
    const row = this.sql.turn!.get(sessionId, turnId);
    let ordinal: number;
    let turn: Turn;
    if (row) {
      ordinal = int(row.ordinal);
      turn = update(parse<Turn>(row.data));
      this.sql.updateTurn!.run(JSON.stringify(turn), sessionId, turnId);
    } else {
      ordinal = int(this.sql.nextTurnOrdinal!.get(sessionId)!.turn_ordinals);
      turn = update(undefined);
      this.sql.insertTurn!.run(sessionId, turnId, ordinal, JSON.stringify(turn));
    }
    this.sql.setLastTurn!.run(turn.status, ordinal, sessionId, ordinal);
  }

  private putItem(sessionId: string, item: Item): void {
    if (this.sql.item!.get(sessionId, item.itemId)) {
      this.sql.updateItem!.run(item.turnId, JSON.stringify(item), sessionId, item.itemId);
      return;
    }
    const ordinal = int(this.sql.nextItemOrdinal!.get(sessionId)!.item_ordinals);
    this.sql.insertItem!.run(sessionId, item.itemId, item.turnId, ordinal, JSON.stringify(item));
  }

  // ---- reading events --------------------------------------------------------------------------

  /** Current seq of the session: the seq of its newest event, 0 for a session with no events. */
  head(sessionId: string): number {
    const row = this.sql.head!.get(sessionId);
    return row ? int(row.head) : 0;
  }

  /**
   * Events after `cursor` in seq order, at most `limit` (default 500, capped at 5000). Throws
   * `CursorExpired` when the Journal no longer holds `cursor + 1` or the cursor is past the head.
   */
  since(sessionId: string, cursor: number, limit?: number): SinceResult {
    checkSeq('cursor', cursor);
    const max = checkCount('limit', limit, DEFAULT_SINCE_LIMIT, MAX_SINCE_LIMIT);
    const row = this.sql.head!.get(sessionId);
    const head = row ? int(row.head) : 0;
    const floor = row ? int(row.floor) : 0;
    if (cursor < floor || cursor > head) throw new CursorExpired(sessionId, cursor, floor, head);
    const events = this.sql.eventsAfter!.all(sessionId, cursor, head, max).map((r) => this.toEvent(sessionId, r));
    const last = events.length > 0 ? events[events.length - 1]!.params.seq : cursor;
    return { events, cursor: last, complete: last === head };
  }

  private toEvent(sessionId: string, row: Row): JournalEvent {
    return {
      method: str(row.method),
      params: { sessionId, seq: int(row.seq), ...parse<Row>(row.params) },
    } as JournalEvent;
  }

  // ---- reading turns ---------------------------------------------------------------------------

  /**
   * Snapshot mode of `session/open`: the newest `turns` turns (default 5), newest last, items inlined,
   * at most 100 per turn (the newest, with `itemsTruncated: true`), the pending requests, and `cursor`
   * = the head the snapshot reflects. `olderCursor` pages `history()`; when a returned turn was
   * truncated it points just above that turn, so history returns it again in full.
   */
  snapshot(sessionId: string, turns: number = DEFAULT_SNAPSHOT_TURNS): SnapshotResult {
    const count = checkCount('turns', turns, DEFAULT_SNAPSHOT_TURNS, MAX_SNAPSHOT_TURNS);
    return this.read(() => {
      const rows = this.sql.newestTurns!.all(sessionId, count).reverse();
      let olderOrdinal = rows.length > 0 ? int(rows[0]!.ordinal) : 0;
      const out: TurnWithItems[] = rows.map((row) => {
        const turn = this.inline(sessionId, row, MAX_ITEMS_PER_TURN);
        if (turn.itemsTruncated) olderOrdinal = int(row.ordinal) + 1;
        return turn;
      });
      const result: SnapshotResult = { turns: out, cursor: this.head(sessionId), pending: this.pending(sessionId) };
      if (olderOrdinal > 0 && this.sql.hasTurnBefore!.get(sessionId, olderOrdinal)) {
        result.olderCursor = turnCursor(olderOrdinal);
      }
      return result;
    });
  }

  /** `session/history`: up to `limit` turns (default 5) older than `before`, newest first, items in full. */
  history(sessionId: string, before: string, limit?: number): HistoryResult {
    const ordinal = parseTurnCursor(before);
    const max = checkCount('limit', limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    return this.read(() => {
      const rows = this.sql.turnsBefore!.all(sessionId, ordinal, max);
      const result: HistoryResult = { turns: rows.map((row) => this.inline(sessionId, row)) };
      const oldest = rows.length > 0 ? int(rows[rows.length - 1]!.ordinal) : 0;
      if (oldest > 0 && this.sql.hasTurnBefore!.get(sessionId, oldest)) result.olderCursor = turnCursor(oldest);
      return result;
    });
  }

  private inline(sessionId: string, row: Row, cap?: number): TurnWithItems {
    const turn = parse<Turn>(row.data);
    const limit = cap === undefined ? -1 : cap + 1;
    const items = this.sql.newestItems!.all(sessionId, turn.turnId, limit).map((r) => parse<Item>(r.data));
    const truncated = cap !== undefined && items.length > cap;
    if (truncated) items.length = cap;
    return inlineTurn(turn, items.reverse(), truncated);
  }

  /**
   * Runs several reads against one consistent database state (matters with other writers on the file).
   * Never nested: appends commit before listeners run, so no read starts inside a write transaction.
   */
  private read<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      return fn();
    } finally {
      this.db.exec('COMMIT');
    }
  }

  // ---- pending requests ------------------------------------------------------------------------

  /** Requests from `approval/request` and `input/request` with no later `request/resolved`, oldest first. */
  pending(sessionId: string): Pending {
    const approvals: ApprovalRequest[] = [];
    const inputs: InputRequest[] = [];
    for (const row of this.sql.openRequests!.all(sessionId)) {
      if (row.family === 'approval') approvals.push(parse<ApprovalRequest>(row.data));
      else inputs.push(parse<InputRequest>(row.data));
    }
    return { approvals, inputs };
  }

  // ---- session summaries -----------------------------------------------------------------------

  /** The session's summary as `session/list` shows it, or undefined for a session with no events. */
  summary(sessionId: string): SessionSummary | undefined {
    const row = this.sql.session!.get(sessionId);
    return row ? toSummary(row) : undefined;
  }

  /** Summary plus `settings` (the `Session` of spec 5.1), or undefined for a session with no events. */
  session(sessionId: string): Session | undefined {
    const row = this.sql.session!.get(sessionId);
    return row ? { ...toSummary(row), settings: parse<Settings>(row.settings) } : undefined;
  }

  /** `session/list`: summaries sorted by `updatedAt` descending (ties by sessionId), paged by cursor. */
  list(options: ListOptions = {}): ListResult {
    const max = checkCount('limit', options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (options.agentId !== undefined) {
      where.push('agent_id = ?');
      args.push(options.agentId);
    }
    if (options.cursor !== undefined) {
      const [updatedAt, sessionId] = parseListCursor(options.cursor);
      where.push('(updated_at < ? OR (updated_at = ? AND session_id < ?))');
      args.push(updatedAt, updatedAt, sessionId);
    }
    const sql =
      'SELECT * FROM sessions' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY updated_at DESC, session_id DESC LIMIT ?';
    const rows = this.db.prepare(sql).all(...args, max + 1);
    const sessions = rows.slice(0, max).map(toSummary);
    const result: ListResult = { sessions };
    if (rows.length > max) {
      const last = sessions[sessions.length - 1]!;
      result.nextCursor = listCursor(last.updatedAt, last.sessionId);
    }
    return result;
  }

  // ---- subscriptions ---------------------------------------------------------------------------

  /**
   * Delivers the session's events with seq greater than `options.after` (default: the head now), then
   * every later event as it is appended: in seq order, no duplicates, no gap. Events already in the
   * Journal are delivered synchronously before this returns, so serve a read, send its response, then
   * subscribe with `after: read.cursor`; appends that happened in between arrive first.
   */
  subscribe(sessionId: string, listener: Listener, options: SubscribeOptions = {}): Subscription {
    const after = options.after === undefined ? this.head(sessionId) : checkSeq('after', options.after);
    const state: SubscriberState = {
      sessionId,
      listener,
      onExpired: options.onExpired,
      delivered: after,
      pumping: false,
      closed: false,
    };
    let set = this.subscribers.get(sessionId);
    if (!set) this.subscribers.set(sessionId, (set = new Set()));
    set.add(state);
    const subscription: Subscription = {
      get cursor() {
        return state.delivered;
      },
      get closed() {
        return state.closed;
      },
      close: () => this.unsubscribe(state),
    };
    state.handle = subscription;
    this.pump(state);
    return subscription;
  }

  private unsubscribe(state: SubscriberState): void {
    state.closed = true;
    const set = this.subscribers.get(state.sessionId);
    if (!set) return;
    set.delete(state);
    if (set.size === 0) this.subscribers.delete(state.sessionId);
  }

  private notify(event: JournalEvent): void {
    const set = this.subscribers.get(event.params.sessionId);
    if (!set) return;
    for (const state of [...set]) this.pump(state, event);
  }

  /**
   * Brings one subscriber up to the head. Reentrant appends (a listener that appends) only advance the
   * head; the outer loop picks their events up, so each subscriber sees strictly increasing seqs.
   */
  private pump(state: SubscriberState, live?: JournalEvent): void {
    if (state.pumping || state.closed) return;
    state.pumping = true;
    try {
      while (!state.closed && state.delivered < this.head(state.sessionId)) {
        const batch =
          live && live.params.seq === state.delivered + 1
            ? [live]
            : this.since(state.sessionId, state.delivered).events;
        live = undefined;
        for (const event of batch) {
          if (state.closed) break;
          state.delivered = event.params.seq;
          try {
            state.listener(event, state.handle!);
          } catch (error) {
            this.onListenerError(error, event);
          }
        }
      }
    } catch (error) {
      this.unsubscribe(state);
      if (!(error instanceof CursorExpired)) throw error;
      state.onExpired?.(error);
    } finally {
      state.pumping = false;
    }
  }

  // ---- lifecycle and test hooks ----------------------------------------------------------------

  close(): void {
    for (const set of [...this.subscribers.values()]) for (const state of [...set]) this.unsubscribe(state);
    if (this.db.isOpen) this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * TEST ONLY. Drops the session's events with seq <= `throughSeq`, as a compacting host would, so the
   * `cursor_expired` path can be exercised. v1 hosts never compact (spec 6, Journal retention): no
   * production code calls this. Materialized turns, items and pending requests are kept.
   */
  compactForTesting(sessionId: string, throughSeq: number): void {
    const through = Math.min(checkSeq('throughSeq', throughSeq), this.head(sessionId));
    this.sql.compact!.run(sessionId, through);
    this.sql.setFloor!.run(through, sessionId, through);
  }
}

function toSummary(row: Row): SessionSummary {
  const summary: SessionSummary = {
    sessionId: str(row.session_id),
    agentId: str(row.agent_id),
    title: str(row.title),
    cwd: str(row.cwd),
    status: str(row.status) as SessionStatus,
    createdAt: int(row.created_at),
    updatedAt: int(row.updated_at),
    lastSeq: int(row.head),
    pending: { approvals: int(row.pending_approvals), inputs: int(row.pending_inputs) },
  };
  if (row.preview !== null) summary.preview = str(row.preview);
  if (row.last_turn_status !== null) summary.lastTurnStatus = str(row.last_turn_status) as TurnStatus;
  return summary;
}
