import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SID,
  agentItem,
  approval,
  eventsResult,
  ev,
  inputRequest,
  session,
  snapshot,
  summary,
  turn,
  userItem,
} from '../../test/replica-fixtures';
import { FakeTransport, MemoryStorage, rpcError, settle } from '../../test/replica-doubles';
import { Replica, type ReplicaOptions } from './replica';
import { DEFAULT_STORAGE_KEY, defaultStorage, load, save } from './storage';

function setup(options: Partial<ReplicaOptions> = {}) {
  const client = new FakeTransport();
  client.rule('session/list', () => ({ sessions: [summary()] }));
  const storage = options.storage === undefined ? new MemoryStorage() : options.storage;
  let n = 0;
  const replica = new Replica({
    client,
    storage,
    persistDelayMs: 50,
    newClientMessageId: () => `cm-${++n}`,
    now: () => 1000,
    ...options,
  });
  const changes = vi.fn();
  replica.subscribe(changes);
  return { client, storage: storage as MemoryStorage, replica, changes };
}

/** Opens SID with a snapshot at `cursor` and returns once applied. */
async function openAt(client: FakeTransport, replica: Replica, cursor: number, turns: unknown[] = []) {
  const opened = replica.open(SID);
  client.last('session/open').resolve(snapshot(cursor, turns));
  await opened;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Replica: opening (spec 6)', () => {
  it('first open has no cursor: snapshot mode replaces the state; later opens send the cursor', async () => {
    const { client, replica } = setup({ snapshotTurns: 3 });
    const opened = replica.open(SID);
    expect(replica.openSessionId).toBe(SID);
    expect(replica.session(SID)).toMatchObject({ loaded: false, cursor: 0 });
    expect(client.last('session/open').params).toEqual({ sessionId: SID, turns: 3 });
    client.last('session/open').resolve(
      snapshot(7, [{ ...turn('t1', { status: 'completed' }), items: [agentItem('i1', 't1', 'hello')] }], {
        pending: { approvals: [approval('r1')], inputs: [] },
      }),
    );
    await opened;
    const view = replica.session(SID)!;
    expect(view).toMatchObject({ loaded: true, cursor: 7, status: 'idle' });
    expect(view.items.i1).toMatchObject({ text: 'hello' });
    expect(Object.keys(view.approvals)).toEqual(['r1']);
    expect(replica.sessions[0]).toMatchObject({ sessionId: SID, lastSeq: 7, pending: { approvals: 1, inputs: 0 }, lastTurnStatus: 'completed' });

    client.goReady(); // a reconnect: session/open again, now with the cursor
    expect(client.last('session/open').params).toEqual({ sessionId: SID, cursor: 7, turns: 3 });
    client.last('session/open').resolve(
      eventsResult([ev(8, 'turn/started', { turn: turn('t2') }), ev(9, 'status/changed', { status: 'running' })], 9, {
        session: session({ status: 'running', lastSeq: 9 }),
      }),
    );
    await settle();
    expect(view).toMatchObject({ cursor: 9, status: 'running' });
    expect(view.turns.map((t) => t.turnId)).toEqual(['t1', 't2']);
    expect(view.approvals).toEqual({}); // pending is replaced by the host's answer
  });

  it('on every ready: session/list, and session/open for the open session only', async () => {
    const { client, replica } = setup();
    client.goReady();
    expect(client.count('session/list')).toBe(1);
    expect(client.count('session/open')).toBe(0);
    await openAt(client, replica, 3);
    client.goReady();
    expect(client.count('session/list')).toBe(2);
    expect(client.count('session/open')).toBe(2);
  });

  it('a second open of the same session while one is in flight shares it', async () => {
    const { client, replica } = setup();
    const a = replica.open(SID);
    const b = replica.open(SID);
    expect(client.count('session/open')).toBe(1);
    client.last('session/open').resolve(snapshot(1));
    await Promise.all([a, b]);
  });

  it('holds live events that arrive during the open and applies them after it', async () => {
    const { client, replica } = setup();
    const opened = replica.open(SID);
    client.notify('item/started', ev(6, 'item/started', { turnId: 't1', item: agentItem('i1', 't1') }).params);
    client.notify('item/delta', ev(7, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'x' }).params);
    client.notify('turn/started', ev(4, 'turn/started', { turn: turn('stale') }).params); // at or below the cursor
    client.last('session/open').resolve(snapshot(5, [{ ...turn('t1'), items: [] }]));
    await opened;
    const view = replica.session(SID)!;
    expect(view.cursor).toBe(7);
    expect(view.items.i1).toMatchObject({ text: 'x' });
    expect(view.turns.map((t) => t.turnId)).toEqual(['t1']);
  });

  it('a session/open that reports cursor_expired as an error is retried in snapshot mode', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 5);
    client.goReady();
    client.last('session/open').reject(rpcError('cursor_expired'));
    await settle();
    expect(client.last('session/open').params).toEqual({ sessionId: SID });
    client.last('session/open').resolve(snapshot(50));
    await settle();
    expect(replica.session(SID)!.cursor).toBe(50);
  });

  it('a failed open is reported through lastError, and the next stream tries again', async () => {
    const { client, replica, changes } = setup();
    client.goReady();
    await settle();
    void replica.open(SID).catch(() => {});
    client.last('session/open').reject(rpcError('connection_lost'));
    await settle();
    client.goReady();
    client.last('session/open').reject(rpcError('internal'));
    await settle();
    expect(replica.lastError).toMatchObject({ code: 'internal' });
    expect(changes).toHaveBeenCalled();
    expect(client.count('session/open')).toBe(2);
  });

  it('events mode whose events stop short of the head catches up with events/since', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 2);
    client.goReady();
    client.last('session/open').resolve(eventsResult([ev(3, 'status/changed', { status: 'running' })], 5));
    await settle();
    expect(client.last('events/since').params).toEqual({ sessionId: SID, cursor: 3 });
    client.last('events/since').resolve({
      events: [ev(4, 'turn/started', { turn: turn('t1') }), ev(5, 'status/changed', { status: 'idle' })],
      cursor: 5,
      complete: true,
    });
    await settle();
    expect(replica.session(SID)).toMatchObject({ cursor: 5, status: 'idle' });
  });
});

describe('Replica: live events strictly by seq (spec 5.2)', () => {
  it('applies the next seq, ignores seq at or below the cursor, buffers a gap and fills it with events/since', async () => {
    const { client, replica } = setup({ catchUpLimit: 2 });
    await openAt(client, replica, 10, [{ ...turn('t1'), items: [] }]);
    const view = replica.session(SID)!;
    client.notify('item/started', ev(11, 'item/started', { turnId: 't1', item: agentItem('i1', 't1') }).params);
    client.notify('item/started', ev(11, 'item/started', { turnId: 't1', item: agentItem('i1', 't1', 'dup') }).params);
    client.notify('item/delta', ev(9, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'old' }).params);
    expect(view.cursor).toBe(11);
    expect(client.count('events/since')).toBe(0); // stale events are not gaps
    expect(view.items.i1).toMatchObject({ text: '' });

    // 12 and 13 are lost; 14 and 15 arrive.
    client.notify('item/delta', ev(14, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'c' }).params);
    expect(view.cursor).toBe(11);
    expect(client.last('events/since').params).toEqual({ sessionId: SID, cursor: 11, limit: 2 });
    client.notify('item/delta', ev(15, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'd' }).params);
    client.last('events/since').resolve({
      events: [
        ev(12, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'a' }),
        ev(13, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'b' }),
      ],
      cursor: 13,
      complete: false,
    });
    await settle();
    // Not complete: one more page, which overlaps what is buffered.
    expect(client.last('events/since').params).toMatchObject({ cursor: 13 });
    client.last('events/since').resolve({
      events: [ev(14, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'c' })],
      cursor: 14,
      complete: false,
    });
    await settle();
    client.last('events/since').resolve({ events: [], cursor: 14, complete: false }); // no progress: stop
    await settle();
    expect(view.items.i1).toMatchObject({ text: 'abcd' });
    expect(view.cursor).toBe(15);
    expect(client.count('events/since')).toBe(3);
  });

  it('cursor_expired from events/since reopens in snapshot mode', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 10);
    client.notify('status/changed', ev(13, 'status/changed', { status: 'running' }).params);
    client.last('events/since').reject(rpcError('cursor_expired'));
    await settle();
    expect(client.last('session/open').params).toEqual({ sessionId: SID });
    client.last('session/open').resolve(snapshot(20, [], { session: session({ status: 'idle' }) }));
    await settle();
    expect(replica.session(SID)).toMatchObject({ cursor: 20, status: 'idle' });
  });

  it('a failing catch-up is reported without a retry loop; the next live event tries again', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 10);
    client.notify('status/changed', ev(12, 'status/changed', { status: 'running' }).params);
    client.last('events/since').reject(rpcError('internal'));
    await settle();
    expect(replica.lastError).toMatchObject({ code: 'internal' });
    expect(client.count('events/since')).toBe(1); // no immediate retry
    client.notify('status/changed', ev(13, 'status/changed', { status: 'waiting_approval' }).params);
    expect(client.open('events/since')).toHaveLength(1);
    client.last('events/since').resolve({ events: [ev(11, 'status/changed', { status: 'idle' })], cursor: 11, complete: true });
    await settle();
    expect(replica.session(SID)).toMatchObject({ cursor: 13, status: 'waiting_approval' });
  });

  it('explicit catchUp: events/since on a loaded view, session/open on one never loaded', async () => {
    const { client, replica } = setup();
    void replica.catchUp('other');
    expect(client.last('session/open').params).toEqual({ sessionId: 'other' });
    await openAt(client, replica, 4);
    const a = replica.catchUp(SID);
    const b = replica.catchUp(SID);
    expect(client.count('events/since')).toBe(1);
    client.last('events/since').resolve({ events: [], cursor: 4, complete: true });
    await Promise.all([a, b]);
  });

  it('ignores events for sessions it never opened, and for a known but unloaded view', async () => {
    const { client, replica, changes } = setup();
    client.notify('status/changed', ev(1, 'status/changed', { status: 'running' }, 'unknown').params);
    void replica.catchUp(SID).catch(() => {});
    client.last('session/open').reject(rpcError('internal'));
    await settle();
    changes.mockClear();
    client.notify('status/changed', ev(1, 'status/changed', { status: 'running' }).params);
    client.notify('something/else', { foo: 1 });
    expect(replica.session(SID)!.status).toBe('idle');
    expect(changes).not.toHaveBeenCalled();
  });

  it('keeps unsequenced notifications: session/updated in the list, host/status/changed', () => {
    const { client, replica } = setup();
    client.notify('session/updated', { summary: summary({ sessionId: 'b', updatedAt: 9 }) });
    client.notify('session/updated', { summary: summary({ sessionId: 'a', updatedAt: 5 }) });
    expect(replica.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
    const status = { host: {}, agents: [], sessionsActive: 1, uptimeSeconds: 2 };
    client.notify('host/status/changed', status);
    expect(replica.hostStatus).toEqual(status);
  });
});

describe('Replica: optimistic sends (spec 7)', () => {
  it('shows a sending turn at once and reconciles it when turn/started for the returned turnId arrives', async () => {
    const { client, replica, storage } = setup();
    await openAt(client, replica, 3);
    const writes = storage.writes;
    const id = replica.sendMessage(SID, [{ type: 'text', text: 'list files' }]);
    expect(id).toBe('cm-1');
    expect(storage.writes).toBe(writes + 1); // written at once, so a lock cannot lose it
    const view = replica.session(SID)!;
    expect(view.turns).toEqual([
      expect.objectContaining({ turnId: 'local:cm-1', status: 'sending', startedAt: 1000, optimistic: { clientMessageId: 'cm-1' } }),
    ]);
    expect(view.items['local:cm-1']).toMatchObject({ type: 'userMessage', content: [{ type: 'text', text: 'list files' }] });
    expect(client.last('turn/start').params).toEqual({ sessionId: SID, input: [{ type: 'text', text: 'list files' }], clientMessageId: 'cm-1' });
    client.last('turn/start').resolve({ turn: turn('t7') });
    await settle();
    expect(view.turns[0]!.optimistic).toEqual({ clientMessageId: 'cm-1', hostTurnId: 't7' });
    client.notify('turn/started', ev(4, 'turn/started', { turn: turn('t7') }).params);
    expect(view.turns.map((t) => t.turnId)).toEqual(['t7']);
    expect(view.items['local:cm-1']).toBeUndefined();
  });

  it('reconciles by clientMessageId when the userMessage arrives before the turn/start result', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 0);
    replica.sendMessage(SID, [{ type: 'text', text: 'hi' }]);
    client.notify('turn/started', ev(1, 'turn/started', { turn: turn('t1') }).params);
    expect(replica.session(SID)!.turns).toHaveLength(2);
    client.notify('item/started', ev(2, 'item/started', { turnId: 't1', item: userItem('u1', 't1', 'cm-1') }).params);
    expect(replica.session(SID)!.turns.map((t) => t.turnId)).toEqual(['t1']);
    client.last('turn/start').resolve({ turn: turn('t1') });
    await settle();
    expect(replica.session(SID)!.turns.map((t) => t.turnId)).toEqual(['t1']);
  });

  it('a refused send becomes failed_to_send with the error; retry re-sends with the same id; discard drops it', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 0);
    replica.sendMessage(SID, [{ type: 'text', text: 'hi' }]);
    client.last('turn/start').reject(rpcError('session_busy', { turnId: 't0' }));
    await settle();
    const view = replica.session(SID)!;
    expect(view.turns[0]).toMatchObject({
      status: 'failed_to_send',
      optimistic: { error: { code: 'session_busy', message: 'session_busy', data: { turnId: 't0' } } },
    });
    replica.retrySend(SID, 'cm-1');
    expect(view.turns[0]!.status).toBe('sending');
    expect(view.turns[0]!.optimistic!.error).toBeUndefined();
    expect(client.last('turn/start').params.clientMessageId).toBe('cm-1');
    client.last('turn/start').reject(new Error('weird') as never);
    await settle();
    expect(view.turns[0]!.optimistic!.error).toMatchObject({ code: 'internal' });
    expect(view.turns[0]!.optimistic!.error).not.toHaveProperty('data');
    replica.discardSend(SID, 'cm-1');
    expect(view.turns).toEqual([]);
    expect(view.items).toEqual({});
    replica.retrySend(SID, 'nope');
    replica.discardSend(SID, 'nope');
    replica.retrySend('no-session', 'cm-1');
  });

  it('an uncertain send (connection lost) stays sending and goes out again, same id, after the next open', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 0);
    replica.sendMessage(SID, [{ type: 'text', text: 'hi' }]);
    client.last('turn/start').reject(rpcError('connection_lost'));
    await settle();
    expect(replica.session(SID)!.turns[0]!.status).toBe('sending');
    client.goReady();
    expect(client.count('turn/start')).toBe(1); // not before the open
    client.last('session/open').resolve(eventsResult([], 0));
    await settle();
    expect(client.count('turn/start')).toBe(2);
    expect(client.last('turn/start').params.clientMessageId).toBe('cm-1');
    // A send already in flight is not doubled by another open.
    client.goReady();
    client.last('session/open').resolve(eventsResult([], 0));
    await settle();
    expect(client.count('turn/start')).toBe(2);
  });

  it('a snapshot that already holds the echoed message reconciles the optimistic turn', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 0);
    replica.sendMessage(SID, [{ type: 'text', text: 'hi' }]);
    client.goReady();
    client.last('session/open').resolve(snapshot(3, [{ ...turn('t1'), items: [userItem('u1', 't1', 'cm-1')] }]));
    await settle();
    expect(replica.session(SID)!.turns.map((t) => t.turnId)).toEqual(['t1']);
  });
});

describe('Replica: requests and approvals (spec 5.3)', () => {
  it('resolveApproval drops the prompt on success, already_resolved and not_found, and rethrows the rest', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 0);
    client.notify('approval/request', ev(1, 'approval/request', { request: approval('r1') }).params);
    client.notify('approval/request', ev(2, 'approval/request', { request: approval('r2') }).params);
    client.notify('input/request', ev(3, 'input/request', { request: inputRequest('r3') }).params);
    expect(replica.sessions[0]!.pending).toEqual({ approvals: 2, inputs: 1 });
    const a = replica.resolveApproval(SID, 'r1', 'accept');
    expect(client.last('approval/resolve').params).toEqual({ sessionId: SID, requestId: 'r1', decision: 'accept' });
    client.last('approval/resolve').resolve({ ok: true });
    await a;
    const b = replica.resolveApproval(SID, 'r2', 'decline');
    client.last('approval/resolve').reject(rpcError('already_resolved', { resolvedBy: 'dev_other' }));
    await b;
    const c = replica.answerInput(SID, 'r3', { q: ['yes'] });
    expect(client.last('input/answer').params).toEqual({ sessionId: SID, requestId: 'r3', answers: { q: ['yes'] } });
    client.last('input/answer').reject(rpcError('not_found'));
    await c;
    const view = replica.session(SID)!;
    expect(view.approvals).toEqual({});
    expect(view.inputs).toEqual({});
    expect(replica.sessions[0]!.pending).toEqual({ approvals: 0, inputs: 0 });
    const d = replica.resolveApproval(SID, 'r9', 'accept');
    client.last('approval/resolve').reject(rpcError('internal'));
    await expect(d).rejects.toMatchObject({ code: 'internal' });
    const e = replica.resolveApproval('elsewhere', 'r9', 'accept');
    client.last('approval/resolve').resolve({ ok: true });
    await e;
  });

  it('interrupt sends turn/interrupt', async () => {
    const { client, replica } = setup();
    const done = replica.interrupt(SID, 't1');
    expect(client.last('turn/interrupt').params).toEqual({ sessionId: SID, turnId: 't1' });
    client.last('turn/interrupt').resolve({ ok: true });
    await done;
  });
});

describe('Replica: session list', () => {
  it('refreshSessions replaces the list, newest first, keeps nextCursor, and keeps loaded views in step', async () => {
    const { client, replica } = setup();
    await openAt(client, replica, 4);
    client.notify('status/changed', ev(5, 'status/changed', { status: 'running' }).params);
    client.rule('session/list', () => ({
      sessions: [summary({ sessionId: 'old', updatedAt: 1 }), summary({ lastSeq: 3, status: 'idle', updatedAt: 9 })],
      nextCursor: 'page-2',
    }));
    const list = await replica.refreshSessions({ limit: 2 });
    expect(client.last('session/list').params).toEqual({ limit: 2 });
    expect(list.map((s) => s.sessionId)).toEqual([SID, 'old']);
    expect(replica.sessionsNextCursor).toBe('page-2');
    // The open view (seq 5) is newer than the list row (seq 3): the row follows the view.
    expect(list[0]).toMatchObject({ status: 'running', lastSeq: 5 });
    // A row newer than the view wins.
    client.rule('session/list', () => ({ sessions: [summary({ lastSeq: 99, status: 'error' })] }));
    expect((await replica.refreshSessions())[0]).toMatchObject({ status: 'error', lastSeq: 99 });
  });

  it('loadMoreSessions fetches the next page by cursor and appends rows until there is none', async () => {
    const { client, replica } = setup();
    expect(await replica.loadMoreSessions()).toBe(false);
    client.rule('session/list', (params) =>
      params?.cursor === undefined
        ? { sessions: [summary({ sessionId: 'a', updatedAt: 9 })], nextCursor: 'p2' }
        : { sessions: [summary({ sessionId: 'a', updatedAt: 1 }), summary({ sessionId: 'b', updatedAt: 5 })] },
    );
    await replica.refreshSessions();
    expect(await replica.loadMoreSessions({ limit: 2 })).toBe(true);
    expect(client.last('session/list').params).toEqual({ limit: 2, cursor: 'p2' });
    expect(replica.sessions.map((s) => [s.sessionId, s.updatedAt])).toEqual([['a', 9], ['b', 5]]);
    expect(replica.sessionsNextCursor).toBeUndefined();
    expect(await replica.loadMoreSessions()).toBe(false);
  });

  it('loadMoreSessions drops a page that a refresh overtook', async () => {
    const { client, replica } = setup();
    client.rule('session/list', () => ({ sessions: [summary({ sessionId: 'a' })], nextCursor: 'p2' }));
    await replica.refreshSessions();
    client.unrule('session/list');
    const more = replica.loadMoreSessions();
    const pending = client.last('session/list');
    client.rule('session/list', () => ({ sessions: [summary({ sessionId: 'fresh' })], nextCursor: 'q2' }));
    await replica.refreshSessions();
    pending.resolve({ sessions: [summary({ sessionId: 'stale' })] });
    expect(await more).toBe(true);
    expect(replica.sessions.map((s) => s.sessionId)).toEqual(['fresh']);
    expect(replica.sessionsNextCursor).toBe('q2');
  });

  it('startSession: session/start, then opens the new session', async () => {
    const { client, replica } = setup();
    const started = replica.startSession({ agentId: 'codex', cwd: '/work', input: [{ type: 'text', text: 'go' }] });
    client.last('session/start').resolve({ session: session({ status: 'running' }), turn: turn('t1') });
    await settle();
    expect(replica.openSessionId).toBe(SID);
    expect(replica.sessions[0]).not.toHaveProperty('settings');
    client.last('session/open').resolve(snapshot(2));
    await expect(started).resolves.toMatchObject({ turn: { turnId: 't1' } });
  });

  it('close: session/close for the open session; nothing to do when none is open', async () => {
    const { client, replica } = setup();
    await replica.close();
    expect(client.count('session/close')).toBe(0);
    await openAt(client, replica, 1);
    const closing = replica.close();
    expect(replica.openSessionId).toBeUndefined();
    client.last('session/close').resolve({ ok: true });
    await closing;
    expect(client.last('session/close').params).toEqual({ sessionId: SID });
  });

  it('a list row is created from the session when the list does not have it yet', async () => {
    const { client, replica } = setup();
    client.rule('session/list', () => ({ sessions: [] }));
    await openAt(client, replica, 2);
    expect(replica.sessions).toEqual([expect.objectContaining({ sessionId: SID, lastSeq: 2 })]);
  });

  it('subscribers hear every change until they unsubscribe; version increases', async () => {
    const { client, replica } = setup();
    const listener = vi.fn();
    const off = replica.subscribe(listener);
    const before = replica.version;
    client.notify('session/updated', { summary: summary() });
    off();
    client.notify('session/updated', { summary: summary() });
    expect(listener).toHaveBeenCalledOnce();
    expect(replica.version).toBe(before + 2);
  });
});

describe('Replica: persistence (lock and reopen)', () => {
  it('a new Replica on the same storage renders at once and reopens with the persisted cursor', async () => {
    const storage = new MemoryStorage();
    const first = setup({ storage });
    await openAt(first.client, first.replica, 6, [{ ...turn('t1'), items: [agentItem('i1', 't1', 'kept')] }]);
    first.client.notify('session/updated', { summary: summary({ sessionId: 'other', updatedAt: 1 }) });
    vi.advanceTimersByTime(50);
    first.replica.dispose();

    const second = setup({ storage });
    expect(second.replica.openSessionId).toBe(SID);
    expect(second.replica.sessions.map((s) => s.sessionId)).toEqual([SID, 'other']);
    expect(second.replica.session(SID)).toMatchObject({ loaded: true, cursor: 6 });
    expect(second.replica.session(SID)!.items.i1).toMatchObject({ text: 'kept' });
    second.client.goReady();
    expect(second.client.last('session/open').params).toEqual({ sessionId: SID, cursor: 6 });
  });

  it('a client that is already ready when the Replica is made syncs at once', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify({ v: 1, openSessionId: SID, sessions: [], views: [] }));
    const client = new FakeTransport();
    client.state = 'ready';
    client.rule('session/list', () => ({ sessions: [] }));
    new Replica({ client, storage });
    expect(client.last('session/open').params).toEqual({ sessionId: SID });
  });

  it('coalesces writes, writes at once on suspend, and keeps views with unsent messages', async () => {
    const { client, replica, storage } = setup();
    await openAt(client, replica, 1);
    const writes = storage.writes;
    client.notify('status/changed', ev(2, 'status/changed', { status: 'running' }).params);
    client.notify('status/changed', ev(3, 'status/changed', { status: 'idle' }).params);
    expect(storage.writes).toBe(writes);
    vi.advanceTimersByTime(50);
    expect(storage.writes).toBe(writes + 1);
    client.notify('status/changed', ev(4, 'status/changed', { status: 'running' }).params);
    client.fireSuspend();
    expect(storage.writes).toBe(writes + 2);
    replica.sendMessage('other', [{ type: 'text', text: 'later' }]);
    const closing = replica.close();
    client.last('session/close').resolve({ ok: true });
    await closing;
    replica.flush();
    const saved = load(storage, DEFAULT_STORAGE_KEY)!;
    expect(saved.openSessionId).toBeUndefined();
    expect(saved.views.map((v) => v.sessionId)).toEqual(['other']);
  });

  it('when storage is full it keeps the list and drops views, so the next open is a snapshot', async () => {
    const { client, replica, storage } = setup();
    await openAt(client, replica, 1, [{ ...turn('t1'), items: [agentItem('i1', 't1', 'x'.repeat(5000))] }]);
    storage.failWhenLongerThan = 3000;
    replica.flush();
    const saved = load(storage, DEFAULT_STORAGE_KEY)!;
    expect(saved.views).toEqual([]);
    expect(saved.sessions).toHaveLength(1);
    const again = setup({ storage });
    again.client.goReady();
    expect(again.client.last('session/open').params).toEqual({ sessionId: SID });
  });

  it('works without storage', async () => {
    const { client, replica } = setup({ storage: null });
    await openAt(client, replica, 1);
    replica.flush();
    vi.advanceTimersByTime(1000);
    expect(replica.session(SID)!.cursor).toBe(1);
  });
});

describe('storage', () => {
  it('load ignores missing, corrupt and foreign data', () => {
    const s = new MemoryStorage();
    expect(load(null, 'k')).toBeNull();
    expect(load(s, 'k')).toBeNull();
    s.setItem('k', '{not json');
    expect(load(s, 'k')).toBeNull();
    s.setItem('k', JSON.stringify({ v: 2, sessions: [], views: [] }));
    expect(load(s, 'k')).toBeNull();
    s.setItem('k', JSON.stringify({ v: 1, sessions: [], views: [] }));
    expect(load(s, 'k')).toEqual({ v: 1, sessions: [], views: [] });
  });

  it('save falls back to summaries only, then to nothing', () => {
    const data = { v: 1 as const, sessions: [], views: [] };
    expect(save(null, 'k', data)).toBe('none');
    const throwing = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('no'); } };
    expect(save(throwing, 'k', data)).toBe('none');
    let calls = 0;
    const once = { getItem: () => null, setItem: () => { if (calls++ === 0) throw new Error('quota'); }, removeItem: () => {} };
    expect(save(once, 'k', data)).toBe('summaries');
  });

  it('defaultStorage is localStorage when there is one, and null when access throws', () => {
    expect(defaultStorage()).toBeNull(); // Node has no localStorage by default
    const fake = new MemoryStorage();
    vi.stubGlobal('localStorage', fake);
    expect(defaultStorage()).toBe(fake);
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
    try {
      expect(defaultStorage()).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
