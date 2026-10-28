import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AlreadyResolved,
  CursorExpired,
  EVENT_BYTE_BUDGET,
  InvalidParams,
  Journal,
  JournalError,
  MAX_ITEMS_PER_TURN,
  SNAPSHOT_BYTE_BUDGET,
  defaultJournalPath,
  replay,
} from './index.js';
import type { EventInput, Item } from './index.js';
import {
  agentMessage,
  approvalRequest,
  inputRequest,
  itemCompleted,
  itemDelta,
  itemStarted,
  requestResolved,
  sessionChanged,
  statusChanged,
  turnCompleted,
  turnStarted,
} from './testing/fixtures.js';

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

let clock = 1000;
const now = () => clock;
let journal: Journal;

beforeEach(() => {
  clock = 1000;
  journal = new Journal({ path: ':memory:', now });
});

afterEach(() => {
  journal.close();
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'journal-test-'));
}

/** One turn with `count` completed agent messages. */
function appendTurn(sessionId: string, turnId: string, count: number): void {
  journal.append(sessionId, turnStarted(turnId));
  for (let i = 0; i < count; i++) {
    journal.append(sessionId, itemCompleted(agentMessage(`${turnId}_itm_${i}`, turnId, `m${i}`, 'completed')));
  }
  journal.append(sessionId, turnCompleted(turnId));
}

describe('append and head', () => {
  it('assigns dense seqs starting at 1 per session and stamps sessionId', () => {
    const a1 = journal.append('ses_a', statusChanged('running'));
    const b1 = journal.append('ses_b', statusChanged('running'));
    const a2 = journal.append('ses_a', statusChanged('idle'));
    expect([a1.params.seq, a2.params.seq, b1.params.seq]).toEqual([1, 2, 1]);
    expect(a2).toEqual({ method: 'status/changed', params: { sessionId: 'ses_a', seq: 2, status: 'idle' } });
    expect(journal.head('ses_a')).toBe(2);
    expect(journal.head('ses_b')).toBe(1);
    expect(journal.head('ses_none')).toBe(0);
  });

  it('ignores a caller-supplied sessionId or seq in params', () => {
    const forged = { method: 'status/changed', params: { status: 'idle', seq: 99, sessionId: 'other' } };
    const event = journal.append('ses_a', forged as EventInput);
    expect(event.params).toEqual({ sessionId: 'ses_a', seq: 1, status: 'idle' });
    expect(journal.since('ses_a', 0).events).toEqual([event]);
  });

  it('rejects unknown methods, non-object params and a missing session id without consuming a seq', () => {
    const bad = (sessionId: string, input: unknown) => () => journal.append(sessionId, input as EventInput);
    expect(bad('ses_a', { method: 'turn/start', params: {} })).toThrow(InvalidParams);
    expect(bad('ses_a', undefined)).toThrow(InvalidParams);
    expect(bad('ses_a', { method: 'status/changed', params: null })).toThrow(InvalidParams);
    expect(bad('ses_a', { method: 'status/changed', params: [] })).toThrow(InvalidParams);
    expect(bad('', statusChanged('idle'))).toThrow(InvalidParams);
    expect(journal.head('ses_a')).toBe(0);
    expect(journal.append('ses_a', statusChanged('idle')).params.seq).toBe(1);
  });

  it('orders concurrent appends first-wins: seq follows the order appends reach the Journal', async () => {
    const order: string[] = [];
    const tasks = Array.from({ length: 40 }, (_, i) =>
      (async () => {
        // Interleave the callers through a shuffled number of microtask hops.
        for (let hop = 0; hop < (i * 7) % 5; hop++) await Promise.resolve();
        order.push(`c${i}`);
        return journal.append('ses_a', { method: 'session/closed', params: { reason: `c${i}` } });
      })(),
    );
    const events = await Promise.all(tasks);
    const bySeq = [...events].sort((x, y) => x.params.seq - y.params.seq);
    expect(bySeq.map((e) => e.params.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(bySeq.map((e) => (e.params as { reason: string }).reason)).toEqual(order);
  });

  it('keeps seq dense and unique when two connections append to one file in turns', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'journal.sqlite');
      const first = new Journal({ path: file, now });
      const second = new Journal({ path: file, now });
      const seqs: number[] = [];
      for (let i = 0; i < 20; i++) {
        const writer = i % 3 === 0 ? second : first;
        seqs.push(writer.append('ses_a', statusChanged('running')).params.seq);
      }
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(first.since('ses_a', 0).events.map((e) => e.params.seq)).toEqual(seqs);
      first.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps seq monotonic across reopening an existing database file', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'nested', 'journal.sqlite');
      const before = new Journal({ path: file, now });
      before.append('ses_a', sessionChanged({ title: 'Persisted' }));
      before.append('ses_a', statusChanged('running'));
      before.append('ses_a', approvalRequest('req_1'));
      before.close();

      const after = new Journal({ path: file, now });
      expect(after.head('ses_a')).toBe(3);
      expect(after.append('ses_a', statusChanged('idle')).params.seq).toBe(4);
      expect(after.since('ses_a', 0).events.map((e) => e.params.seq)).toEqual([1, 2, 3, 4]);
      expect(after.summary('ses_a')).toMatchObject({ title: 'Persisted', lastSeq: 4, pending: { approvals: 1 } });
      expect(after.pending('ses_a').approvals.map((r) => r.requestId)).toEqual(['req_1']);
      after.close();
      after.close(); // idempotent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reuses a seq: a rejected append leaves no hole and compaction does not rewind', () => {
    journal.append('ses_a', approvalRequest('req_1'));
    journal.append('ses_a', requestResolved('req_1'));
    expect(() => journal.append('ses_a', requestResolved('req_1', 'command', 'dev_b'))).toThrow(AlreadyResolved);
    expect(journal.append('ses_a', statusChanged('idle')).params.seq).toBe(3);
    journal.compactForTesting('ses_a', 3);
    expect(journal.append('ses_a', statusChanged('idle')).params.seq).toBe(4);
  });
});

describe('since', () => {
  beforeEach(() => {
    for (let i = 0; i < 10; i++) journal.append('ses_a', statusChanged(i % 2 ? 'idle' : 'running'));
  });

  it('returns the events after the cursor in seq order with the last seq as cursor', () => {
    const page = journal.since('ses_a', 4);
    expect(page.events.map((e) => e.params.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(page).toMatchObject({ cursor: 10, complete: true });
  });

  it('pages with limit and reports complete only at the head', () => {
    const first = journal.since('ses_a', 0, 4);
    expect(first.events.map((e) => e.params.seq)).toEqual([1, 2, 3, 4]);
    expect(first).toMatchObject({ cursor: 4, complete: false });
    const second = journal.since('ses_a', first.cursor, 6);
    expect(second).toMatchObject({ cursor: 10, complete: true });
    expect(journal.since('ses_a', 0, 1_000_000).events).toHaveLength(10); // capped, not an error
  });

  it('returns nothing and keeps the cursor at the head or for an unknown session at 0', () => {
    expect(journal.since('ses_a', 10)).toEqual({ events: [], cursor: 10, complete: true });
    expect(journal.since('ses_new', 0)).toEqual({ events: [], cursor: 0, complete: true });
  });

  it('throws CursorExpired when compaction dropped cursor + 1', () => {
    journal.compactForTesting('ses_a', 6);
    expect(journal.since('ses_a', 6).events.map((e) => e.params.seq)).toEqual([7, 8, 9, 10]);
    let thrown: unknown;
    try {
      journal.since('ses_a', 5);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CursorExpired);
    expect(thrown).toBeInstanceOf(JournalError);
    expect(thrown).toMatchObject({ code: 'cursor_expired', name: 'CursorExpired', cursor: 5, floor: 6, head: 10 });
    expect(() => journal.since('ses_a', 0)).toThrow(CursorExpired);
  });

  it('caps compaction at the head and never lowers the floor', () => {
    journal.compactForTesting('ses_a', 50);
    expect(() => journal.since('ses_a', 9)).toThrow(CursorExpired);
    journal.compactForTesting('ses_a', 2);
    expect(journal.since('ses_a', 10).complete).toBe(true);
  });

  it('throws CursorExpired for a cursor past the head and InvalidParams for malformed input', () => {
    expect(() => journal.since('ses_a', 11)).toThrow(CursorExpired);
    expect(() => journal.since('ses_a', -1)).toThrow(InvalidParams);
    expect(() => journal.since('ses_a', 1.5)).toThrow(InvalidParams);
    expect(() => journal.since('ses_a', 0, 0)).toThrow(InvalidParams);
    expect(() => journal.compactForTesting('ses_a', -1)).toThrow(InvalidParams);
  });

  it('pages by serialized bytes, returning at least one event even if it alone exceeds the budget', () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    for (let i = 0; i < 4; i++) {
      journal.append('ses_big', itemCompleted(agentMessage(`itm_${i}`, 'trn_1', big, 'completed')));
    }
    const first = journal.since('ses_big', 0);
    expect(first.events.length).toBe(2);
    expect(responseBytes(first)).toBeLessThanOrEqual(EVENT_BYTE_BUDGET);
    expect(first.complete).toBe(false);

    const second = journal.since('ses_big', first.cursor);
    expect(second.events.length).toBe(2);
    expect(responseBytes(second)).toBeLessThanOrEqual(EVENT_BYTE_BUDGET);
    expect(second.complete).toBe(true);
  });
});

describe('session summaries', () => {
  it('derives the summary from events', () => {
    clock = 1000;
    journal.append('ses_a', sessionChanged({ agentId: 'codex', title: 'Hello', cwd: '/w', settings: { model: 'm1' } }));
    expect(journal.summary('ses_a')).toEqual({
      sessionId: 'ses_a',
      agentId: 'codex',
      title: 'Hello',
      cwd: '/w',
      status: 'idle',
      createdAt: 1000,
      updatedAt: 1000,
      lastSeq: 1,
      pending: { approvals: 0, inputs: 0 },
    });
    clock = 1010;
    journal.append('ses_a', statusChanged('running'));
    journal.append('ses_a', turnStarted('trn_1'));
    journal.append('ses_a', itemCompleted(agentMessage('itm_1', 'trn_1', 'x'.repeat(300), 'completed')));
    journal.append('ses_a', approvalRequest('req_1'));
    journal.append('ses_a', inputRequest('req_2'));
    journal.append('ses_a', inputRequest('req_3'));
    clock = 1020;
    journal.append('ses_a', requestResolved('req_2', 'input'));
    journal.append('ses_a', turnCompleted('trn_1', 'interrupted'));
    const summary = journal.summary('ses_a')!;
    expect(summary).toMatchObject({
      status: 'running',
      createdAt: 1000,
      updatedAt: 1020,
      lastSeq: 9,
      lastTurnStatus: 'interrupted',
      pending: { approvals: 1, inputs: 1 },
    });
    expect(summary.preview).toHaveLength(200);
    expect(summary.preview!.endsWith('…')).toBe(true);
    expect(journal.session('ses_a')).toEqual({ ...summary, settings: { model: 'm1' } });
    journal.append('ses_a', { method: 'session/closed', params: { reason: 'archived' } });
    expect(journal.summary('ses_a')!.status).toBe('closed');
  });

  it('keeps earlier session fields when a session/changed omits them', () => {
    journal.append('ses_a', sessionChanged({ agentId: 'codex', title: 'T', cwd: '/w', settings: { model: 'm1' } }));
    const partial = { method: 'session/changed', params: { session: { title: 'Renamed' } } };
    journal.append('ses_a', partial as EventInput);
    expect(journal.session('ses_a')).toMatchObject({ agentId: 'codex', title: 'Renamed', cwd: '/w', settings: { model: 'm1' } });
    journal.append('ses_a', { method: 'session/changed', params: { session: { cwd: '/moved' } } } as EventInput);
    expect(journal.session('ses_a')).toMatchObject({ agentId: 'codex', title: 'Renamed', cwd: '/moved' });
  });

  it('takes the preview only from finished, non-empty agent messages', () => {
    journal.append('ses_a', itemCompleted({ itemId: 'i1', type: 'plan', turnId: 't', status: 'completed', text: 'plan' }));
    journal.append('ses_a', itemCompleted(agentMessage('i2', 't', '', 'completed')));
    expect(journal.summary('ses_a')!.preview).toBeUndefined();
    journal.append('ses_a', itemStarted(agentMessage('i3', 't', 'streaming')));
    expect(journal.summary('ses_a')!.preview).toBeUndefined();
    journal.append('ses_a', itemCompleted(agentMessage('i3', 't', 'Done.', 'completed')));
    expect(journal.summary('ses_a')!.preview).toBe('Done.');
  });

  it('returns undefined for a session without events', () => {
    expect(journal.summary('ses_none')).toBeUndefined();
    expect(journal.session('ses_none')).toBeUndefined();
  });

  it('lists by updatedAt descending with cursor paging and an agent filter', () => {
    const touched: [string, number, string][] = [
      ['ses_1', 10, 'codex'],
      ['ses_2', 30, 'claude'],
      ['ses_3', 20, 'codex'],
      ['ses_4', 30, 'codex'],
      ['ses_5', 5, 'codex'],
    ];
    for (const [id, at, agentId] of touched) {
      clock = at;
      journal.append(id, sessionChanged({ agentId }));
    }
    clock = 40;
    journal.append('ses_1', statusChanged('running')); // moves ses_1 to the top
    const ids = (r: { sessions: { sessionId: string }[] }) => r.sessions.map((s) => s.sessionId);

    expect(ids(journal.list())).toEqual(['ses_1', 'ses_4', 'ses_2', 'ses_3', 'ses_5']);
    const page1 = journal.list({ limit: 2 });
    expect(ids(page1)).toEqual(['ses_1', 'ses_4']);
    const page2 = journal.list({ limit: 2, cursor: page1.nextCursor! });
    expect(ids(page2)).toEqual(['ses_2', 'ses_3']);
    const page3 = journal.list({ limit: 2, cursor: page2.nextCursor! });
    expect(ids(page3)).toEqual(['ses_5']);
    expect(page3.nextCursor).toBeUndefined();
    expect(ids(journal.list({ agentId: 'codex', limit: 3 }))).toEqual(['ses_1', 'ses_4', 'ses_3']);
    expect(ids(journal.list({ agentId: 'kimi' }))).toEqual([]);
  });

  it('rejects malformed list cursors and limits', () => {
    expect(() => journal.list({ cursor: 'not-a-cursor' })).toThrow(InvalidParams);
    const wrongShape = Buffer.from(JSON.stringify({ a: 1 })).toString('base64url');
    expect(() => journal.list({ cursor: wrongShape })).toThrow(InvalidParams);
    expect(() => journal.list({ limit: -2 })).toThrow(InvalidParams);
  });
});

describe('pending requests', () => {
  it('lists approval and input requests until a request/resolved arrives', () => {
    journal.append('ses_a', approvalRequest('req_a1'));
    journal.append('ses_a', inputRequest('req_i1'));
    journal.append('ses_a', approvalRequest('req_a2'));
    let pending = journal.pending('ses_a');
    expect(pending.approvals.map((r) => r.requestId)).toEqual(['req_a1', 'req_a2']);
    expect(pending.inputs.map((r) => r.requestId)).toEqual(['req_i1']);
    expect(pending.approvals[0]).toMatchObject({ kind: 'command', command: 'echo hi' });

    journal.append('ses_a', requestResolved('req_a1', 'command', 'dev_a'));
    journal.append('ses_a', requestResolved('req_i1', 'input', 'agent'));
    pending = journal.pending('ses_a');
    expect(pending.approvals.map((r) => r.requestId)).toEqual(['req_a2']);
    expect(pending.inputs).toEqual([]);
    expect(journal.summary('ses_a')!.pending).toEqual({ approvals: 1, inputs: 0 });
    expect(journal.pending('ses_other')).toEqual({ approvals: [], inputs: [] });
  });

  it('first resolution wins: a second request/resolved throws AlreadyResolved and is not journaled', () => {
    journal.append('ses_a', approvalRequest('req_1'));
    journal.append('ses_a', requestResolved('req_1', 'command', 'dev_a'));
    let thrown: unknown;
    try {
      journal.append('ses_a', requestResolved('req_1', 'command', 'dev_b'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AlreadyResolved);
    expect(thrown).toMatchObject({ code: 'already_resolved', requestId: 'req_1', resolvedBy: 'dev_a' });
    expect(journal.head('ses_a')).toBe(2);
    expect(journal.summary('ses_a')!.pending.approvals).toBe(0);
  });

  it('journals a resolution of an unknown request without touching pending state', () => {
    journal.append('ses_a', approvalRequest('req_1'));
    expect(journal.append('ses_a', requestResolved('req_ghost')).params.seq).toBe(2);
    expect(journal.summary('ses_a')!.pending.approvals).toBe(1);
  });

  it('a repeated request with the same id updates it without double counting', () => {
    journal.append('ses_a', approvalRequest('req_1'));
    const repeat = approvalRequest('req_1') as Extract<EventInput, { method: 'approval/request' }>;
    journal.append('ses_a', { method: 'approval/request', params: { request: { ...repeat.params.request, reason: 'Again?' } } });
    expect(journal.summary('ses_a')!.pending.approvals).toBe(1);
    expect(journal.pending('ses_a').approvals[0]!.reason).toBe('Again?');
  });
});

describe('snapshot and history', () => {
  it('returns the last 5 turns newest last with items inlined, the head cursor and pending', () => {
    for (let t = 1; t <= 7; t++) appendTurn('ses_a', `trn_${t}`, 2);
    journal.append('ses_a', approvalRequest('req_1', 'trn_7'));
    const snap = journal.snapshot('ses_a');
    expect(snap.turns.map((t) => t.turnId)).toEqual(['trn_3', 'trn_4', 'trn_5', 'trn_6', 'trn_7']);
    expect(snap.turns[4]!.items.map((i) => i.itemId)).toEqual(['trn_7_itm_0', 'trn_7_itm_1']);
    expect(snap.turns[4]!.status).toBe('completed');
    expect(snap.turns.every((t) => t.itemsTruncated === undefined)).toBe(true);
    expect(snap.cursor).toBe(journal.head('ses_a'));
    expect(snap.pending.approvals.map((r) => r.requestId)).toEqual(['req_1']);
    expect(snap.olderCursor).toBeDefined();

    const older = journal.history('ses_a', snap.olderCursor!);
    expect(older.turns.map((t) => t.turnId)).toEqual(['trn_2', 'trn_1']);
    expect(older.turns[0]!.items).toHaveLength(2);
    expect(older.olderCursor).toBeUndefined();
  });

  it('looks up one turn by id, merged across turn/started and turn/completed', () => {
    journal.append('ses_a', turnStarted('trn_1'));
    expect(journal.turn('ses_a', 'trn_1')?.status).toBe('inProgress');
    journal.append('ses_a', turnCompleted('trn_1', 'interrupted'));
    expect(journal.turn('ses_a', 'trn_1')).toMatchObject({ turnId: 'trn_1', status: 'interrupted', completedAt: 200 });
    expect(journal.turn('ses_a', 'trn_missing')).toBeUndefined();
    expect(journal.turn('ses_missing', 'trn_1')).toBeUndefined();
  });

  it('honours the turns argument and omits olderCursor when nothing is older', () => {
    appendTurn('ses_a', 'trn_1', 1);
    appendTurn('ses_a', 'trn_2', 1);
    expect(journal.snapshot('ses_a', 1).turns.map((t) => t.turnId)).toEqual(['trn_2']);
    expect(journal.snapshot('ses_a', 1).olderCursor).toBe('turn:2');
    expect(journal.snapshot('ses_a', 2).olderCursor).toBeUndefined();
    expect(journal.snapshot('ses_a', 500).turns).toHaveLength(2); // capped, not an error
    expect(() => journal.snapshot('ses_a', 0)).toThrow(InvalidParams);
  });

  it('is empty for a session with no turns', () => {
    expect(journal.snapshot('ses_none')).toEqual({ turns: [], cursor: 0, pending: { approvals: [], inputs: [] } });
  });

  it('cuts a turn to its newest 100 items with itemsTruncated, and history returns it in full', () => {
    appendTurn('ses_a', 'trn_old', 1);
    appendTurn('ses_a', 'trn_big', MAX_ITEMS_PER_TURN + 5);
    appendTurn('ses_a', 'trn_exact', MAX_ITEMS_PER_TURN);
    const snap = journal.snapshot('ses_a');
    const [old, big, exact] = snap.turns;
    expect(old!.itemsTruncated).toBeUndefined();
    expect(big!.itemsTruncated).toBe(true);
    expect(big!.items).toHaveLength(100);
    expect(big!.items[0]!.itemId).toBe('trn_big_itm_5');
    expect(big!.items[99]!.itemId).toBe('trn_big_itm_104');
    expect(exact!.itemsTruncated).toBeUndefined();
    expect(exact!.items).toHaveLength(100);

    // olderCursor points just above the truncated turn so history repeats it in full.
    const page = journal.history('ses_a', snap.olderCursor!, 10);
    expect(page.turns.map((t) => t.turnId)).toEqual(['trn_big', 'trn_old']);
    expect(page.turns[0]!.items).toHaveLength(105);
    expect(page.turns[0]!.itemsTruncated).toBeUndefined();
  });

  it('pages history newest first with limit', () => {
    for (let t = 1; t <= 4; t++) appendTurn('ses_a', `trn_${t}`, 0);
    const first = journal.history('ses_a', 'turn:5', 2);
    expect(first.turns.map((t) => t.turnId)).toEqual(['trn_4', 'trn_3']);
    const second = journal.history('ses_a', first.olderCursor!, 2);
    expect(second.turns.map((t) => t.turnId)).toEqual(['trn_2', 'trn_1']);
    expect(second.olderCursor).toBeUndefined();
    expect(journal.history('ses_a', 'turn:1')).toEqual({ turns: [] });
  });

  it('rejects malformed history cursors', () => {
    for (const bad of ['', 'turn:0', 'turn:-1', 'turn:abc', 'cur_older_4f2a']) {
      expect(() => journal.history('ses_a', bad)).toThrow(InvalidParams);
    }
    expect(() => journal.history('ses_a', 'turn:1', 0)).toThrow(InvalidParams);
  });

  it('survives compaction: snapshot still serves turns whose events are gone', () => {
    appendTurn('ses_a', 'trn_1', 3);
    journal.compactForTesting('ses_a', journal.head('ses_a'));
    expect(journal.snapshot('ses_a').turns[0]!.items).toHaveLength(3);
  });

  it('truncates oversized fields so a single huge turn still fits the snapshot budget', () => {
    const imageData = 'A'.repeat(15 * 1024 * 1024);
    journal.append('ses_a', turnStarted('trn_big'));
    journal.append(
      'ses_a',
      itemCompleted({
        itemId: 'itm_1',
        type: 'toolCall',
        turnId: 'trn_big',
        status: 'completed',
        tool: 'read_image',
        arguments: {},
        result: { type: 'image', data: imageData },
      } as unknown as Item),
    );
    journal.append('ses_a', turnCompleted('trn_big'));

    const snap = journal.snapshot('ses_a', 1);
    expect(snap.turns).toHaveLength(1);
    expect(responseBytes(snap)).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
    const item = snap.turns[0]!.items[0] as { result: { data: string } };
    expect(item.result.data).toMatch(/\[truncated — \d+ bytes\]/);
    expect(snap.turns[0]!.turnTruncated).toBe(true);
  });

  it('truncates oversized fields in history and keeps the response under budget', () => {
    journal.append('ses_a', turnStarted('trn_old'));
    journal.append('ses_a', itemCompleted(agentMessage('itm_old', 'trn_old', 'small', 'completed')));
    journal.append('ses_a', turnCompleted('trn_old'));

    const bigText = 'y'.repeat(15 * 1024 * 1024);
    journal.append('ses_a', turnStarted('trn_new'));
    journal.append('ses_a', itemCompleted(agentMessage('itm_new', 'trn_new', bigText, 'completed')));
    journal.append('ses_a', turnCompleted('trn_new'));

    const hist = journal.history('ses_a', 'turn:3', 5);
    expect(hist.turns.length).toBeGreaterThanOrEqual(1);
    expect(responseBytes(hist)).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
    const newTurn = hist.turns.find((t) => t.turnId === 'trn_new');
    expect(newTurn).toBeDefined();
    expect(newTurn!.turnTruncated).toBe(true);
    expect((newTurn!.items[0] as { text: string }).text).toMatch(/\[truncated — \d+ bytes\]/);
  });
});

describe('turn and item reconstruction in the store', () => {
  it('builds items from started, deltas and completed, and matches an in-memory replay', () => {
    const turnId = 'trn_1';
    const command: Item = { itemId: 'itm_cmd', type: 'command', turnId, status: 'inProgress', command: 'ls', cwd: '/w', output: '' };
    const reasoning: Item = { itemId: 'itm_r', type: 'reasoning', turnId, status: 'inProgress', summary: '' };
    const fileChange: Item = { itemId: 'itm_f', type: 'fileChange', turnId, status: 'inProgress', changes: [] };
    const inputs: EventInput[] = [
      turnStarted(turnId),
      itemStarted(agentMessage('itm_msg', turnId)),
      itemDelta('itm_msg', turnId, 'Hel'),
      itemDelta('itm_msg', turnId, 'lo'),
      itemStarted(command),
      itemDelta('itm_cmd', turnId, 'a\n', 'output'),
      itemDelta('itm_cmd', turnId, 'b\n', 'output'),
      itemStarted(reasoning),
      itemDelta('itm_r', turnId, 'think', 'summary'),
      itemDelta('itm_r', turnId, 'raw', 'text'),
      itemStarted(fileChange),
      itemDelta('itm_f', turnId, '--- a', 'patch'),
      itemDelta('itm_missing', turnId, 'dropped'),
      itemCompleted({ ...command, status: 'completed', output: 'a\nb\n', exitCode: 0 }),
      turnCompleted(turnId),
    ];
    for (const input of inputs) journal.append('ses_a', input);

    const [turn] = journal.snapshot('ses_a').turns;
    expect(turn).toMatchObject({ turnId, status: 'completed', completedAt: 200 });
    expect(turn!.items).toEqual([
      { itemId: 'itm_msg', type: 'agentMessage', turnId, status: 'inProgress', text: 'Hello' },
      { ...command, status: 'completed', output: 'a\nb\n', exitCode: 0 },
      { ...reasoning, summary: 'think', text: 'raw' },
      { ...fileChange, patch: '--- a' },
    ]);
    expect(journal.snapshot('ses_a').turns).toEqual(replay(journal.since('ses_a', 0).events));
  });

  it('creates a placeholder turn for items that arrive before their turn/started', () => {
    clock = 777;
    journal.append('ses_a', itemStarted(agentMessage('itm_1', 'trn_x', 'early')));
    expect(journal.snapshot('ses_a').turns[0]).toMatchObject({ turnId: 'trn_x', status: 'inProgress', startedAt: 777 });
    expect(journal.summary('ses_a')!.lastTurnStatus).toBe('inProgress');
    journal.append('ses_a', turnStarted('trn_x'));
    journal.append('ses_a', itemCompleted(agentMessage('itm_1', 'trn_x', 'early done', 'completed')));
    const [turn] = journal.snapshot('ses_a').turns;
    expect(turn).toMatchObject({ startedAt: 100, items: [{ itemId: 'itm_1', text: 'early done' }] });
    expect(journal.snapshot('ses_a').turns).toEqual(replay(journal.since('ses_a', 0).events, 777));
  });

  it('lastTurnStatus follows the newest turn, not a late update of an older one', () => {
    journal.append('ses_a', turnStarted('trn_1'));
    journal.append('ses_a', turnStarted('trn_2'));
    journal.append('ses_a', turnCompleted('trn_1', 'failed'));
    expect(journal.summary('ses_a')!.lastTurnStatus).toBe('inProgress');
    journal.append('ses_a', turnCompleted('trn_2', 'completed'));
    expect(journal.summary('ses_a')!.lastTurnStatus).toBe('completed');
  });

  it('usage/updated is journaled without changing turns', () => {
    journal.append('ses_a', { method: 'usage/updated', params: { usage: { inputTokens: 1, outputTokens: 2 } } });
    expect(journal.since('ses_a', 0).events[0]!.method).toBe('usage/updated');
    expect(journal.snapshot('ses_a').turns).toEqual([]);
  });
});

describe('database location', () => {
  it('defaults under ~/Library/Application Support/NanoHost', () => {
    expect(defaultJournalPath('/Users/me')).toBe('/Users/me/Library/Application Support/NanoHost/journal.sqlite');
    expect(defaultJournalPath()).toMatch(/Library\/Application Support\/NanoHost\/journal\.sqlite$/);
  });

  it('uses the default path and the real clock when no options are given, and disposes', () => {
    const dir = tempDir();
    const home = process.env.HOME;
    try {
      process.env.HOME = dir;
      const own = new Journal();
      expect(own.path).toBe(defaultJournalPath(dir));
      const before = Math.floor(Date.now() / 1000);
      own.append('ses_a', statusChanged('idle'));
      expect(own.summary('ses_a')!.createdAt).toBeGreaterThanOrEqual(before);
      own[Symbol.dispose]();
      expect(() => own.head('ses_a')).toThrow();
    } finally {
      process.env.HOME = home;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
