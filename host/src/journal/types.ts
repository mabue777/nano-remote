// Journal types, all derived from the generated protocol types (host/src/generated). Nothing here
// restates a protocol shape by hand.
import type * as common from '../generated/common.js';
import type * as events from '../generated/events.js';

/** A sequenced Journal event as it goes on the wire: `{method, params}`, params carry `sessionId, seq`. */
export type JournalEvent = events.JournalEvent;
export type JournalMethod = JournalEvent['method'];
export type EventOf<M extends JournalMethod> = Extract<JournalEvent, { method: M }>;

/** Drops `sessionId` and `seq` while keeping known keys next to the schema's index signature. */
type WithoutPosition<T> = { [K in keyof T as K extends 'sessionId' | 'seq' ? never : K]: T[K] };

/** What a caller appends: method and params without `sessionId`/`seq`, which the Journal assigns. */
export type EventInput = {
  [M in JournalMethod]: { method: M; params: WithoutPosition<EventOf<M>['params']> };
}[JournalMethod];

export type Item = common.Item;
export type TurnBase = common.TurnBase;
/** A turn as journaled: `items` lists item ids. */
export type Turn = common.Turn;
/** A turn with its items inlined, as snapshot and history return it. */
export type TurnWithItems = common.TurnWithItems;
export type SessionSummary = common.SessionSummary;
export type Session = common.Session;
export type Settings = common.Settings;
export type Pending = common.Pending;
export type ApprovalRequest = common.ApprovalRequest;
export type InputRequest = common.InputRequest;
export type TurnStatus = common.TurnStatus;
export type SessionStatus = common.SessionStatus;
export type DeltaField = events.ItemDelta['field'];

/** `events/since` result (spec 6). */
export interface SinceResult {
  events: JournalEvent[];
  /** Seq of the last returned event, or the request cursor when nothing was returned. */
  cursor: number;
  /** False when more events remain after `cursor`. */
  complete: boolean;
}

/** Snapshot mode body of `session/open` (spec 6), minus `session` which the caller adds. */
export interface SnapshotResult {
  /** Newest last, items inlined, at most 100 items per turn (`itemsTruncated: true` when cut). */
  turns: TurnWithItems[];
  /** Pass to `history()` for older turns; absent when there is nothing older. */
  olderCursor?: string;
  /** Journal head at snapshot time; apply live events with a greater seq. */
  cursor: number;
  pending: Pending;
}

/** `session/history` result (spec 6). */
export interface HistoryResult {
  /** Newest first, items inlined in full. */
  turns: TurnWithItems[];
  olderCursor?: string;
}

/** `session/list` result (spec 6). */
export interface ListResult {
  sessions: SessionSummary[];
  nextCursor?: string;
}

/**
 * Receives one event. The subscription is passed too, because catch-up runs before `subscribe()`
 * returns its handle: a listener that wants to stop (for example mid catch-up) calls `close()` on it.
 */
export type Listener = (event: JournalEvent, subscription: Subscription) => void;

export interface Subscription {
  /** Seq of the last event delivered to this subscriber. */
  readonly cursor: number;
  readonly closed: boolean;
  close(): void;
}
