// Turn and Item reconstruction from Journal events (spec 5.1 and 5.2). Pure functions: the SQLite
// store applies them one event at a time to its materialized rows, and `replay` applies them to a
// whole event list in memory. Tests check that both paths agree.
import type { DeltaField, Item, JournalEvent, Turn, TurnWithItems } from './types.js';

/** Spec 14 point 1: a snapshot carries at most this many items per turn, the newest ones. */
export const MAX_ITEMS_PER_TURN = 100;

/** A turn the Journal saw items for before (or without) its `turn/started`. */
export function placeholderTurn(turnId: string, startedAt: number): Turn {
  return { turnId, status: 'inProgress', startedAt, completedAt: null, error: null, items: [] };
}

/** `turn/started` and `turn/completed` carry the whole turn; later fields win, earlier ones survive. */
export function mergeTurn(previous: Turn | undefined, next: Turn): Turn {
  const merged: Turn = { ...previous, ...next };
  delete merged.itemsTruncated;
  return merged;
}

/** The item as `item/started` or `item/completed` carries it, bound to the event's turn. */
export function bindItem(item: Item, turnId: string): Item {
  return { ...item, turnId };
}

/**
 * `item/delta` appends `delta` to the string field it names: `text` (agentMessage, plan, reasoning),
 * `summary` (reasoning), `output` (command), `patch` (fileChange; kept as a running `patch` string until
 * `item/completed` delivers the final `changes`).
 */
export function applyDelta(item: Item, field: DeltaField, delta: string): Item {
  const current = item[field];
  return { ...item, [field]: (typeof current === 'string' ? current : '') + delta } as Item;
}

/** A journaled turn with its items inlined; `itemsTruncated` only when the caller cut the list. */
export function inlineTurn(turn: Turn, items: Item[], truncated = false): TurnWithItems {
  const out: TurnWithItems = { ...turn, items };
  if (truncated) out.itemsTruncated = true;
  else delete out.itemsTruncated;
  return out;
}

/** Text the session list shows under the title: the start of the newest finished agent message. */
export function previewOf(item: Item): string | undefined {
  if (item.type !== 'agentMessage' || typeof item.text !== 'string' || item.text === '') return undefined;
  return item.text.length > 200 ? `${item.text.slice(0, 199)}…` : item.text;
}

/**
 * Rebuilds every turn of a session from its events, oldest first, items in full and in the order they
 * appeared. `now` stamps placeholder turns for items whose turn was never started.
 */
export function replay(events: Iterable<JournalEvent>, now = 0): TurnWithItems[] {
  const turns = new Map<string, Turn>();
  const items = new Map<string, Item>();
  const ensureTurn = (turnId: string) => {
    if (!turns.has(turnId)) turns.set(turnId, placeholderTurn(turnId, now));
  };
  for (const event of events) {
    switch (event.method) {
      case 'turn/started':
      case 'turn/completed': {
        const turn = event.params.turn;
        turns.set(turn.turnId, mergeTurn(turns.get(turn.turnId), turn));
        break;
      }
      case 'item/started':
      case 'item/completed': {
        ensureTurn(event.params.turnId);
        items.set(event.params.item.itemId, bindItem(event.params.item, event.params.turnId));
        break;
      }
      case 'item/delta': {
        const item = items.get(event.params.itemId);
        if (item) items.set(item.itemId, applyDelta(item, event.params.field, event.params.delta));
        break;
      }
      default:
        break;
    }
  }
  return [...turns.values()].map((turn) =>
    inlineTurn(
      turn,
      [...items.values()].filter((item) => item.turnId === turn.turnId),
    ),
  );
}
