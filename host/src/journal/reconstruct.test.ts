import { describe, expect, it } from 'vitest';

import { Journal } from './index.js';
import type { Item, JournalEvent } from './index.js';
import { applyDelta, inlineTurn, mergeTurn, placeholderTurn, previewOf, replay } from './reconstruct.js';
import { asInput, exampleEvents, turn } from './testing/fixtures.js';

const TURN_A = 'trn_01JFQ3KA0ZP8W1N6HE2Y4RT7XC';
const TURN_B = 'trn_01JFQ3PX9K4M2T7VB0RWHD1ZQ8';

/**
 * The example events as one session's log, in seq order. The examples are separate captures, so the
 * same seq can name different events (814 is item/started in one file, status/changed in another);
 * only exact repeats of method and seq are dropped.
 */
function exampleLog(): JournalEvent[] {
  const seen = new Map<string, JournalEvent>();
  for (const { event } of exampleEvents()) {
    const key = `${event.params.seq} ${event.method}`;
    if (!seen.has(key)) seen.set(key, event);
  }
  return [...seen.values()].sort((a, b) => a.params.seq - b.params.seq);
}

describe('pure reconstruction', () => {
  it('appends deltas to the named string field, starting from empty', () => {
    const item: Item = { itemId: 'i', type: 'command', turnId: 't', status: 'inProgress', command: 'ls', cwd: '/', output: 'a' };
    expect(applyDelta(item, 'output', 'b')).toMatchObject({ output: 'ab' });
    expect(applyDelta(item, 'patch', 'p')).toMatchObject({ patch: 'p' });
    expect(item.output).toBe('a'); // not mutated
  });

  it('merges turns field by field and never stores itemsTruncated', () => {
    const merged = mergeTurn(turn('t', 'inProgress', { extra: 1, itemsTruncated: true }), turn('t', 'failed', { error: { code: 'x', message: 'y' } }));
    expect(merged).toMatchObject({ status: 'failed', extra: 1, error: { code: 'x', message: 'y' } });
    expect(merged.itemsTruncated).toBeUndefined();
    expect(placeholderTurn('t', 9)).toEqual({ turnId: 't', status: 'inProgress', startedAt: 9, completedAt: null, error: null, items: [] });
  });

  it('inlines items and marks truncation only when asked', () => {
    expect(inlineTurn(turn('t', 'completed', { itemsTruncated: true }), []).itemsTruncated).toBeUndefined();
    expect(inlineTurn(turn('t'), [], true).itemsTruncated).toBe(true);
  });

  it('previews only agent messages with text, cut to 200 characters', () => {
    expect(previewOf({ itemId: 'i', type: 'plan', turnId: 't', status: 'completed', text: 'x' })).toBeUndefined();
    expect(previewOf({ itemId: 'i', type: 'agentMessage', turnId: 't', status: 'completed', text: 'hi' })).toBe('hi');
    expect(previewOf({ itemId: 'i', type: 'agentMessage', turnId: 't', status: 'completed', text: 'y'.repeat(201) })).toHaveLength(200);
  });

  it('replay ignores deltas for unknown items and non-turn events', () => {
    const events = [
      { method: 'item/delta', params: { sessionId: 's', seq: 1, itemId: 'nope', turnId: 't', field: 'text', delta: 'x' } },
      { method: 'status/changed', params: { sessionId: 's', seq: 2, status: 'idle' } },
    ] as JournalEvent[];
    expect(replay(events)).toEqual([]);
  });
});

describe('protocol examples', () => {
  it('contains the Journal events this suite relies on', () => {
    const methods = new Set(exampleLog().map((e) => e.method));
    for (const m of ['turn/started', 'turn/completed', 'item/started', 'item/delta', 'item/completed', 'approval/request', 'input/request', 'request/resolved', 'status/changed']) {
      expect(methods.has(m as JournalEvent['method']), m).toBe(true);
    }
  });

  it('round-trips every example event and reconstructs the captured turns', () => {
    const journal = new Journal({ path: ':memory:', now: () => 1 });
    const log = exampleLog();
    const session = log[0]!.params.sessionId;
    for (const event of log) journal.append(session, asInput(event));

    const stored = journal.since(session, 0, 5000).events;
    expect(stored).toHaveLength(log.length);
    stored.forEach((event, i) => {
      expect(event.params.seq).toBe(i + 1);
      expect(event.method).toBe(log[i]!.method);
      expect({ ...event.params, seq: 0 }).toEqual({ ...log[i]!.params, seq: 0 });
    });

    const turns = journal.snapshot(session).turns;
    expect(turns.map((t) => [t.turnId, t.status])).toEqual([
      [TURN_A, 'inProgress'],
      [TURN_B, 'completed'],
    ]);
    // The second message of the running turn waits behind background tasks (example 62).
    expect(turns[0]!.items.map((i) => i.type)).toEqual(['userMessage', 'userMessage']);
    expect(turns[0]!.items[0]).toMatchObject({ clientMessageId: '6f1b0c2e-8a4d-4f3e-9b7a-1d2c3e4f5a6b' });
    expect(turns[0]!.items[1]).toMatchObject({ queued: true });
    const [message, command] = turns[1]!.items;
    expect(message).toMatchObject({ type: 'agentMessage', status: 'completed', text: 'Done. Created hello.txt in the current directory.' });
    expect(command).toMatchObject({ type: 'command', status: 'completed', output: 'Created hello.txt\n', exitCode: 0 });
    expect(turns).toEqual(replay(log));

    // 32 asked for approval and 37 resolved it; the question from 35 is still open.
    const pending = journal.pending(session);
    expect(pending.approvals).toEqual([]);
    expect(pending.inputs.map((r) => r.requestId)).toEqual(['req_01JFQ3N1E7CZR5J9B3QWT8MK6D']);
    expect(journal.summary(session)).toMatchObject({
      lastSeq: log.length,
      lastTurnStatus: 'completed',
      pending: { approvals: 0, inputs: 1 },
      preview: 'Done. Created hello.txt in the current directory.',
    });
    journal.close();
  });
});
