// End-to-end: real stream server, real Journal, FakeAdapter. These are the acceptance scenarios of the
// session core (protocol-v1 sections 5.3, 6, 7).
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { JournalEvent } from '../journal/types.js';
import type { TestClient } from '../stream/testing/client.js';
import { eventsOf, rpc, rpcError, startHarness, text, waitEvent, type Harness, type HarnessOptions } from './testing/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness(options);
  return harness;
}

async function newSession(h: Harness, client: TestClient): Promise<string> {
  const { session } = await rpc<{ session: { sessionId: string } }>(client, 'session/start', { agentId: 'fake', cwd: h.cwd });
  return session.sessionId;
}

function seqs(events: JournalEvent[]): number[] {
  return events.map((e) => e.params.seq);
}

/** Every live event of the session on this client, checked dense and in order from `after + 1`. */
function expectDenseFrom(events: JournalEvent[], after: number): void {
  expect(seqs(events)).toEqual(events.map((_, i) => after + 1 + i));
}

describe('session core end to end', () => {
  it('open, turn/start, approval/request, approval/resolve accept, turn/completed', async () => {
    const h = await setup({ agent: { script: [[{ approval: { reason: 'May I create hello.txt?' } }, { reply: 'Done.' }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);

    const opened = await rpc<{ mode: string; cursor: number; turns: unknown[] }>(phone, 'session/open', { sessionId });
    expect(opened.mode).toBe('snapshot');
    expect(opened.turns).toEqual([]);

    const clientMessageId = randomUUID();
    const { turn } = await rpc<{ turn: { turnId: string; status: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('Create hello.txt'),
      clientMessageId,
    });
    expect(turn.turnId).toMatch(/^trn_/);
    expect(turn.status).toBe('inProgress');

    const request = await waitEvent(phone, 'approval/request');
    const req = (request.params as { request: Record<string, unknown> }).request;
    expect(req).toMatchObject({ kind: 'command', sessionId, turnId: turn.turnId, reason: 'May I create hello.txt?', expiresAt: null });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'waiting_approval');

    expect(await rpc(phone, 'approval/resolve', { sessionId, requestId: req.requestId, decision: 'accept' })).toEqual({ ok: true });
    const completed = await waitEvent(phone, 'turn/completed');
    expect((completed.params as { turn: { status: string; items: string[] } }).turn.status).toBe('completed');
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');

    const live = eventsOf(phone, sessionId);
    expectDenseFrom(live, opened.cursor);
    expect(live.map((e) => e.method)).toEqual([
      'session/changed', // title from the first input
      'turn/started',
      'item/started', // userMessage
      'item/completed',
      'status/changed', // running
      'approval/request',
      'status/changed', // waiting_approval
      'request/resolved',
      'status/changed', // running
      'item/started', // agentMessage
      'item/delta',
      'item/completed',
      'turn/completed',
      'status/changed', // idle
    ]);
    expect((live[0]!.params as { session: { title: string } }).session.title).toBe('Create hello.txt');
    const user = live[2]!.params as { item: { type: string; clientMessageId: string } };
    expect(user.item).toMatchObject({ type: 'userMessage', clientMessageId });
    expect(live[7]!.params).toMatchObject({ requestId: req.requestId, kind: 'command', resolvedBy: 'dev_test', decision: 'accept' });
    expect(h.agent.last.calls.find((c) => c.method === 'resolveApproval')?.args).toEqual([req.requestId, 'accept']);

    // The session/open response came before the first live event on the stream.
    const responseIndex = phone.messages.findIndex((m) => (m.result as { mode?: string } | undefined)?.mode === 'snapshot');
    const firstEvent = phone.messages.findIndex((m) => m.method === 'turn/started');
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeLessThan(firstEvent);
  });

  it('reconnect with a cursor answers in events mode with exactly the missed events', async () => {
    const h = await setup({ agent: { script: [[{ reply: 'first' }], [{ reply: 'second', chunks: 3 }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    const opened = await rpc<{ cursor: number }>(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('one'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    const seen = eventsOf(phone, sessionId);
    expectDenseFrom(seen, opened.cursor);
    const lastSeen = seen[seen.length - 1]!.params.seq;
    phone.close();
    await phone.closed;

    // While the phone is away, another device drives a turn.
    const laptop = await h.connect('other-token');
    await rpc(laptop, 'turn/start', { sessionId, input: text('two'), clientMessageId: randomUUID() });
    const head = h.journal.head(sessionId);
    expect(head).toBeGreaterThan(lastSeen);

    const back = await h.connect();
    const reopened = await rpc<{ mode: string; events: JournalEvent[]; cursor: number; pending: unknown }>(back, 'session/open', {
      sessionId,
      cursor: lastSeen,
    });
    expect(reopened.mode).toBe('events');
    expect(reopened.cursor).toBe(head);
    expect(reopened.events).toEqual(h.journal.since(sessionId, lastSeen).events);
    expectDenseFrom(reopened.events, lastSeen);
    expect(reopened.pending).toEqual({ approvals: [], inputs: [] });

    // Live delivery continues right after the response's cursor, with nothing replayed.
    await rpc(back, 'session/rename', { sessionId, title: 'Renamed' });
    const changed = await waitEvent(back, 'session/changed');
    expect(changed.params.seq).toBe(head + 1);
    expect(eventsOf(back, sessionId)).toHaveLength(1);
  });

  it('no cursor, or an expired one, answers in snapshot mode', async () => {
    const h = await setup({ agent: { script: [[{ reply: 'hello' }], [{ approval: {} }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'turn/start', { sessionId, input: text('one'), clientMessageId: randomUUID() });
    await rpc(phone, 'turn/start', { sessionId, input: text('two'), clientMessageId: randomUUID() });

    const snapshot = await rpc<{
      mode: string;
      session: { sessionId: string; status: string; title: string };
      turns: { status: string; items: { type: string }[] }[];
      cursor: number;
      pending: { approvals: { requestId: string }[] };
    }>(phone, 'session/open', { sessionId });
    expect(snapshot.mode).toBe('snapshot');
    expect(snapshot.session).toMatchObject({ sessionId, status: 'waiting_approval', title: 'one' });
    expect(snapshot.turns.map((t) => t.status)).toEqual(['completed', 'inProgress']);
    expect(snapshot.turns[0]!.items.map((i) => i.type)).toEqual(['userMessage', 'agentMessage']);
    expect(snapshot.cursor).toBe(h.journal.head(sessionId));
    expect(snapshot.pending.approvals).toHaveLength(1);

    h.journal.compactForTesting(sessionId, 5);
    const expired = await rpc<{ mode: string; cursor: number }>(phone, 'session/open', { sessionId, cursor: 2 });
    expect(expired.mode).toBe('snapshot');
    expect(expired.cursor).toBe(h.journal.head(sessionId));
    const ahead = await rpc<{ mode: string }>(phone, 'session/open', { sessionId, cursor: 10_000 });
    expect(ahead.mode).toBe('snapshot');
    const limited = await rpc<{ turns: unknown[] }>(phone, 'session/open', { sessionId, turns: 1 });
    expect(limited.turns).toHaveLength(1);
  });

  it('two streams: one resolves, the other receives request/resolved and loses the race', async () => {
    const h = await setup({ agent: { script: [[{ approval: {} }, { reply: 'ok' }]] } });
    const phone = await h.connect();
    const laptop = await h.connect('other-token');
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(laptop, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const request = await waitEvent(laptop, 'approval/request');
    const requestId = (request.params as { request: { requestId: string } }).request.requestId;

    await rpc(laptop, 'approval/resolve', { sessionId, requestId, decision: 'decline' });
    const resolved = await waitEvent(phone, 'request/resolved');
    expect(resolved.params).toMatchObject({ requestId, resolvedBy: 'dev_other', decision: 'decline' });

    const late = await rpcError(phone, 'approval/resolve', { sessionId, requestId, decision: 'accept' });
    expect(late).toMatchObject({ code: 'already_resolved', data: { resolvedBy: 'dev_other' } });
    expect(h.agent.last.calls.filter((c) => c.method === 'resolveApproval')).toHaveLength(1);
    await waitEvent(phone, 'turn/completed');
    expect(eventsOf(phone, sessionId)).toEqual(eventsOf(laptop, sessionId));
  });

  it('session_busy while a turn runs, then steer into it', async () => {
    const h = await setup({ agent: { script: [[{ hold: true }, { reply: 'steered' }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('long task'),
      clientMessageId: randomUUID(),
    });

    const busy = await rpcError(phone, 'turn/start', { sessionId, input: text('another'), clientMessageId: randomUUID() });
    expect(busy).toEqual({ code: 'session_busy', message: expect.any(String), data: { turnId: turn.turnId } });

    const mismatch = await rpcError(phone, 'turn/steer', {
      sessionId,
      turnId: 'trn_other',
      input: text('x'),
      clientMessageId: randomUUID(),
    });
    expect(mismatch).toMatchObject({ code: 'turn_mismatch', data: { turnId: turn.turnId } });

    const steerId = randomUUID();
    const steered = await rpc<{ turn: { turnId: string; items: string[] } }>(phone, 'turn/steer', {
      sessionId,
      turnId: turn.turnId,
      input: text('also do this'),
      clientMessageId: steerId,
    });
    expect(steered.turn.turnId).toBe(turn.turnId);
    expect(steered.turn.items).toHaveLength(2);
    expect(h.agent.last.calls.find((c) => c.method === 'steer')?.args).toEqual([text('also do this'), steerId]);
    const steerItem = await waitEvent(phone, 'item/started', (p) => (p.item as { clientMessageId?: string }).clientMessageId === steerId);
    expect(steerItem.params).toMatchObject({ turnId: turn.turnId, item: { type: 'userMessage', content: text('also do this') } });

    h.agent.last.release();
    await waitEvent(phone, 'turn/completed');
    expect(h.core.sessions.runningTurnId(sessionId)).toBeUndefined();
  });

  it('interrupt withdraws a pending approval and ends the turn interrupted', async () => {
    const h = await setup({ agent: { script: [[{ approval: {} }, { reply: 'never' }]] } });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('go'),
      clientMessageId: randomUUID(),
    });
    const request = await waitEvent(phone, 'approval/request');
    const requestId = (request.params as { request: { requestId: string } }).request.requestId;

    expect(await rpc(phone, 'turn/interrupt', { sessionId, turnId: turn.turnId })).toEqual({ ok: true });
    const withdrawn = await waitEvent(phone, 'request/resolved');
    expect(withdrawn.params).toMatchObject({ requestId, kind: 'command', resolvedBy: 'agent', decision: 'cancel' });
    const completed = await waitEvent(phone, 'turn/completed');
    expect((completed.params as { turn: { status: string } }).turn.status).toBe('interrupted');
    expect(completed.params.seq).toBeGreaterThan(withdrawn.params.seq);
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    expect(h.journal.pending(sessionId)).toEqual({ approvals: [], inputs: [] });

    const late = await rpcError(phone, 'approval/resolve', { sessionId, requestId, decision: 'accept' });
    expect(late).toMatchObject({ code: 'already_resolved', data: { resolvedBy: 'agent' } });
    // Interrupting a finished turn is ok (idempotent).
    expect(await rpc(phone, 'turn/interrupt', { sessionId, turnId: turn.turnId })).toEqual({ ok: true });
  });

  it('session/start with input starts the first turn in one round trip', async () => {
    const h = await setup();
    const phone = await h.connect();
    const result = await rpc<{
      session: { sessionId: string; title: string; status: string };
      turn: { turnId: string; status: string };
    }>(phone, 'session/start', {
      agentId: 'fake',
      cwd: h.cwd,
      input: text('Create a file named hello.txt and then list every file in this folder, please'),
    });
    expect(result.session.sessionId).toMatch(/^ses_/);
    expect(result.session.title).toBe('Create a file named hello.txt and then list every file in t…');
    expect(result.turn.status).toBe('completed');
    const opened = await rpc<{ turns: { items: { type: string; text?: string }[] }[] }>(phone, 'session/open', {
      sessionId: result.session.sessionId,
    });
    expect(opened.turns[0]!.items[1]).toMatchObject({
      type: 'agentMessage',
      text: 'You said: Create a file named hello.txt and then list every file in this folder, please',
    });
  });
});
