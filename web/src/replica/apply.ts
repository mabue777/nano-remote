// How one Journal event changes a SessionView (spec 5.2), how a snapshot replaces it (spec 6), and how
// optimistic sends are reconciled (spec 7). Pure functions over plain objects; ordering by seq is the
// caller's job (Replica.applySequenced).
import type { TurnBase } from '../generated/events';
import type { Pending, SessionOpenResult } from '../generated/methods';
import type { Item, JournalEvent, SessionView, TurnView } from './types';

type Snapshot = Extract<SessionOpenResult, { mode: 'snapshot' }>;
type TurnLike = TurnBase & { items: readonly string[] };

function upsertTurn(view: SessionView, turn: TurnLike): TurnView {
  const existing = view.turns.find((t) => t.turnId === turn.turnId && t.optimistic === undefined);
  if (existing === undefined) {
    const created: TurnView = { ...turn, items: [...turn.items] };
    // Real turns go before optimistic ones, which stay at the end until reconciled.
    const firstOptimistic = view.turns.findIndex((t) => t.optimistic !== undefined);
    if (firstOptimistic < 0) view.turns.push(created);
    else view.turns.splice(firstOptimistic, 0, created);
    return created;
  }
  const items = [...existing.items];
  for (const id of turn.items) if (!items.includes(id)) items.push(id);
  Object.assign(existing, turn, { items });
  return existing;
}

function upsertItem(view: SessionView, turnId: string, item: Item): void {
  view.items[item.itemId] = { ...item };
  const turn =
    view.turns.find((t) => t.turnId === turnId && t.optimistic === undefined) ??
    upsertTurn(view, { turnId, status: 'inProgress', startedAt: 0, completedAt: null, error: null, items: [] });
  if (!turn.items.includes(item.itemId)) turn.items.push(item.itemId);
}

/** Applies one event. Unknown methods only move the cursor (spec 12: ignore what you do not know). */
export function applyEvent(view: SessionView, event: JournalEvent): void {
  switch (event.method) {
    case 'session/changed':
      view.session = event.params.session;
      view.status = event.params.session.status;
      break;
    case 'status/changed':
      view.status = event.params.status;
      if (view.session !== null) view.session.status = event.params.status;
      break;
    case 'turn/started':
    case 'turn/completed':
      upsertTurn(view, event.params.turn);
      break;
    case 'item/started':
    case 'item/completed':
      upsertItem(view, event.params.turnId, event.params.item);
      break;
    case 'item/delta': {
      const item = view.items[event.params.itemId] as Record<string, unknown> | undefined;
      if (item !== undefined) {
        const previous = item[event.params.field];
        item[event.params.field] = (typeof previous === 'string' ? previous : '') + event.params.delta;
      }
      break;
    }
    case 'approval/request':
      view.approvals[event.params.request.requestId] = event.params.request;
      break;
    case 'input/request':
      view.inputs[event.params.request.requestId] = event.params.request;
      break;
    case 'request/resolved':
      delete view.approvals[event.params.requestId];
      delete view.inputs[event.params.requestId];
      break;
    case 'usage/updated':
      view.usage = event.params.usage;
      break;
    case 'session/closed':
      view.status = 'closed';
      view.closedReason = event.params.reason;
      if (view.session !== null) view.session.status = 'closed';
      break;
  }
  view.cursor = event.params.seq;
}

/** Pending requests from session/open are the state at the head: they replace what the view had. */
export function replacePending(view: SessionView, pending: Pending): void {
  view.approvals = {};
  view.inputs = {};
  for (const request of pending.approvals) view.approvals[request.requestId] = request;
  for (const request of pending.inputs) view.inputs[request.requestId] = request;
}

/** Snapshot mode: the view becomes the snapshot. Optimistic turns not yet reconciled are kept. */
export function replaceWithSnapshot(view: SessionView, snapshot: Snapshot): void {
  const optimistic = view.turns.filter((t) => t.optimistic !== undefined);
  const optimisticItems = optimistic.flatMap((t) => t.items.map((id) => [id, view.items[id]] as const));
  view.session = snapshot.session;
  view.status = snapshot.session.status;
  view.turns = [];
  view.items = {};
  for (const turn of snapshot.turns) {
    const ids: string[] = [];
    for (const item of turn.items) {
      view.items[item.itemId] = item;
      ids.push(item.itemId);
    }
    view.turns.push({ ...turn, items: ids });
  }
  for (const [id, item] of optimisticItems) if (item !== undefined) view.items[id] = item;
  view.turns.push(...optimistic);
  replacePending(view, snapshot.pending);
  view.cursor = snapshot.cursor;
  view.olderCursor = snapshot.olderCursor;
  view.loaded = true;
  delete view.closedReason;
  reconcile(view);
}

/**
 * Drops optimistic turns the host has caught up with: their turn (by the turnId from the turn/start
 * result) or their userMessage item (by clientMessageId) is now in the view. Returns true on change.
 */
export function reconcile(view: SessionView): boolean {
  const pending = view.turns.filter((t) => t.optimistic !== undefined);
  if (pending.length === 0) return false;
  const echoed = new Set<string>();
  for (const item of Object.values(view.items)) {
    if (item.type === 'userMessage' && typeof item.clientMessageId === 'string' && !isOptimisticId(item.itemId)) {
      echoed.add(item.clientMessageId);
    }
  }
  const hostTurns = new Set<string>();
  for (const turn of view.turns) {
    if (turn.optimistic !== undefined) continue;
    hostTurns.add(turn.turnId);
    // Unknown fields are allowed (spec 12): a host may echo clientMessageId on the turn itself.
    if (typeof turn.clientMessageId === 'string') echoed.add(turn.clientMessageId);
  }
  let changed = false;
  for (const turn of pending) {
    const { clientMessageId, hostTurnId } = turn.optimistic!;
    if (echoed.has(clientMessageId) || (hostTurnId !== undefined && hostTurns.has(hostTurnId))) {
      view.turns.splice(view.turns.indexOf(turn), 1);
      for (const id of turn.items) delete view.items[id];
      changed = true;
    }
  }
  return changed;
}

const OPTIMISTIC_PREFIX = 'local:';

export function optimisticId(clientMessageId: string): string {
  return `${OPTIMISTIC_PREFIX}${clientMessageId}`;
}

export function isOptimisticId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_PREFIX);
}
