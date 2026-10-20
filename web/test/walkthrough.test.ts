// The phone session of spec 13 end to end: the real StreamClient and Replica over real WebSockets
// against the fake host. New chat with an approval, an optimistic second message, lock and reopen with
// catch-up (the socket is killed and the approval is answered elsewhere meanwhile), interrupt, a lost
// live event filled by events/since, an expired cursor, chunking both ways, and the close codes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Replica } from '../src/replica/replica';
import type { SessionView } from '../src/replica/types';
import { StreamClient, type StreamClientOptions } from '../src/stream/client';
import { ManualLifecycle } from './doubles';
import { FakeHost } from './fake-host';
import { exampleMessage } from './fixtures';
import { MemoryStorage } from './replica-doubles';

const AGENT_TEXT: string = exampleMessage('28').params.item.text;
const COMMAND_OUTPUT: string = exampleMessage('31').params.item.output;
const CWD = '/Users/me/Desktop/phone-test';

let host: FakeHost;
const clients: StreamClient[] = [];

beforeEach(async () => {
  host = new FakeHost({ deltas: 12 });
  await host.start();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await host.stop();
});

function phone(options: Partial<StreamClientOptions> = {}, storage = new MemoryStorage()) {
  const lifecycle = new ManualLifecycle();
  const client = new StreamClient({
    clientId: 'dev_8f3a9c21',
    url: host.url,
    lifecycle,
    timing: { backoffMinMs: 20, backoffMaxMs: 200, drainingDelayMs: 150, requestTimeoutMs: 3000 },
    ...options,
  });
  clients.push(client);
  const replica = new Replica({ client, storage, persistDelayMs: 10 });
  return { client, replica, lifecycle, storage };
}

async function until(check: () => void, timeout = 3000): Promise<void> {
  await vi.waitFor(check, { timeout, interval: 5 });
}

function hostTurns(view: SessionView) {
  return view.turns.filter((t) => t.optimistic === undefined);
}

/** P1 to P6: a new chat that ends waiting for the command approval. */
async function newChat(p: ReturnType<typeof phone>): Promise<string> {
  p.client.start();
  await until(() => expect(p.client.state).toBe('ready'));
  const started = await p.replica.startSession({
    agentId: 'codex',
    cwd: CWD,
    input: [{ type: 'text', text: 'Create a file named hello.txt in the current directory.' }],
  });
  const sessionId = started.session.sessionId;
  await until(() => expect(p.replica.session(sessionId)!.status).toBe('waiting_approval'));
  return sessionId;
}

describe('walkthrough: new chat from the phone (P1 to P7)', () => {
  it('ping, initialize, list, start, streamed turn, approval, completion', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    const stream = host.stream!;
    // P1 and P2: the first envelopes are a foreground ping, then initialize with protocolVersion 1.
    expect(stream.received[0]).toMatchObject({ type: 'ping', seq_id: 1, state: 'foreground', client_id: 'dev_8f3a9c21' });
    expect(stream.received[1]).toMatchObject({ type: 'client_message', seq_id: 2, message: { method: 'initialize', params: { protocolVersion: 1 } } });
    expect(stream.ready).toBe(true);
    // P3 and P5: the list was fetched, the session started and opened.
    expect(host.requestLog.map((r) => r.method)).toEqual(['initialize', 'session/list', 'session/start', 'session/open']);
    const view = p.replica.session(sessionId)!;
    // P6: the turn so far, with the approval pending (the open's snapshot returned it).
    const [turn] = hostTurns(view);
    expect(turn!.status).toBe('inProgress');
    const agent = Object.values(view.items).find((i) => i.type === 'agentMessage')!;
    expect(agent).toMatchObject({ text: AGENT_TEXT });
    const requests = Object.values(view.approvals);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'command', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
    expect(p.replica.sessions[0]).toMatchObject({ sessionId, pending: { approvals: 1, inputs: 0 } });

    // P7: the user taps Allow.
    await p.replica.resolveApproval(sessionId, requests[0]!.requestId, 'accept');
    await until(() => expect(view.status).toBe('idle'));
    expect(hostTurns(view)[0]).toMatchObject({ status: 'completed' });
    expect(Object.values(view.items).find((i) => i.type === 'command')).toMatchObject({ status: 'completed', output: COMMAND_OUTPUT, exitCode: 0 });
    expect(view.approvals).toEqual({});
    expect(view.usage).toMatchObject({ inputTokens: 1200 });
    expect(view.cursor).toBe(host.head(sessionId));
    expect(p.replica.sessions[0]).toMatchObject({ status: 'idle', lastTurnStatus: 'completed', lastSeq: host.head(sessionId) });

    // Acks: everything the host sent is acked, in batches (fewer acks than envelopes).
    await until(() => expect(stream.lastAck).toBe(stream.lastOut));
    expect(stream.ackCount).toBeLessThan(stream.lastOut);
  });

  it('a second message shows as sending at once and is reconciled by clientMessageId', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    const view = p.replica.session(sessionId)!;
    await p.replica.resolveApproval(sessionId, Object.keys(view.approvals)[0]!, 'decline');
    await until(() => expect(view.status).toBe('idle'));
    expect(Object.values(view.items).find((i) => i.type === 'command')).toMatchObject({ status: 'declined' });

    const clientMessageId = p.replica.sendMessage(sessionId, [{ type: 'text', text: 'Now list the files in this folder.' }]);
    expect(view.turns.at(-1)).toMatchObject({ status: 'sending', optimistic: { clientMessageId } });
    await until(() => expect(view.turns.some((t) => t.optimistic !== undefined)).toBe(false));
    const echoed = Object.values(view.items).find((i) => i.type === 'userMessage' && i.clientMessageId === clientMessageId);
    expect(echoed).toBeDefined();
    expect(hostTurns(view)).toHaveLength(2);
    await until(() => expect(view.status).toBe('waiting_approval'));
  });
});

describe('walkthrough: lock and reopen (P8, N5)', () => {
  it('the socket dies, the approval is answered elsewhere, the phone reconnects and catches up in events mode', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    const view = p.replica.session(sessionId)!;
    const firstStream = host.stream!.streamId;
    const cursorBefore = view.cursor;

    host.kill(); // iOS closes the socket about 30 s after lock; no client_closed
    host.resolveElsewhere(sessionId, 'accept'); // journaled while the phone has no stream
    expect(host.head(sessionId)).toBeGreaterThan(cursorBefore);

    await until(() => expect(view.status).toBe('idle'));
    const reopened = host.stream!;
    expect(reopened.streamId).not.toBe(firstStream);
    expect(reopened.received[0]).toMatchObject({ type: 'ping', seq_id: 1 });
    expect(reopened.requests[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: 1 } });
    const open = host.requestLog.filter((r) => r.method === 'session/open').at(-1)!;
    expect(open).toMatchObject({ streamId: reopened.streamId, params: { sessionId, cursor: cursorBefore } });
    expect(view.cursor).toBe(host.head(sessionId));
    expect(view.approvals).toEqual({});
    expect(hostTurns(view)[0]).toMatchObject({ status: 'completed' });
  });

  it('after a reload the Replica renders from storage at once, then reopens with its cursor', async () => {
    const storage = new MemoryStorage();
    const first = phone({}, storage);
    const sessionId = await newChat(first);
    const cursor = first.replica.session(sessionId)!.cursor;
    first.lifecycle.pagehide();
    await until(() => expect(host.goodbyes).toEqual([expect.objectContaining({ reason: 'background' })]));
    host.resolveElsewhere(sessionId, 'accept');

    const second = phone({}, storage);
    const view = second.replica.session(sessionId)!;
    expect(view).toMatchObject({ loaded: true, cursor, status: 'waiting_approval' }); // instant render
    expect(second.replica.openSessionId).toBe(sessionId);
    second.client.start();
    await until(() => expect(view.status).toBe('idle'));
    const open = host.requestLog.filter((r) => r.method === 'session/open').at(-1)!;
    expect(open.params).toEqual({ sessionId, cursor });
  });

  it('pagehide says goodbye; pageshow reconnects on a new stream and catches up', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    p.lifecycle.setVisibility('background');
    await until(() => expect(host.pings.at(-1)).toMatchObject({ state: 'background' }));
    p.lifecycle.pagehide();
    expect(p.client.state).toBe('suspended');
    host.resolveElsewhere(sessionId, 'cancel');
    p.lifecycle.setVisibility('foreground');
    await until(() => expect(p.client.state).toBe('ready'));
    const view = p.replica.session(sessionId)!;
    await until(() => expect(view.status).toBe('idle'));
    expect(hostTurns(view)[0]).toMatchObject({ status: 'interrupted' });
  });
});

describe('walkthrough: interrupt (P9) and catch-up', () => {
  it('turn/interrupt ends the turn interrupted and withdraws the pending approval', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    const view = p.replica.session(sessionId)!;
    await p.replica.interrupt(sessionId, hostTurns(view)[0]!.turnId);
    await until(() => expect(hostTurns(view)[0]!.status).toBe('interrupted'));
    expect(view.approvals).toEqual({});
    await until(() => expect(view.status).toBe('idle'));
  });

  it('a lost live event leaves a gap that events/since fills', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    const view = p.replica.session(sessionId)!;
    host.dropLive(sessionId, host.head(sessionId) + 2);
    await p.replica.resolveApproval(sessionId, Object.keys(view.approvals)[0]!, 'accept');
    await until(() => expect(view.cursor).toBe(host.head(sessionId)));
    expect(host.requestLog.some((r) => r.method === 'events/since')).toBe(true);
    expect(view.status).toBe('idle');
    expect(Object.values(view.items).find((i) => i.type === 'command')).toMatchObject({ output: COMMAND_OUTPUT });
  });

  it('an expired cursor reopens in snapshot mode, from events/since and from session/open', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    const view = p.replica.session(sessionId)!;
    // events/since answers cursor_expired: the Replica reopens with a snapshot.
    host.dropLive(sessionId, host.head(sessionId) + 1);
    host.compact(sessionId, host.head(sessionId) + 5);
    await p.replica.resolveApproval(sessionId, Object.keys(view.approvals)[0]!, 'accept');
    await until(() => expect(view.status).toBe('idle'));
    const opens = host.requestLog.filter((r) => r.method === 'session/open');
    expect(opens.at(-1)!.params).toEqual({ sessionId });
    expect(view.cursor).toBe(host.head(sessionId));
    expect(hostTurns(view)[0]).toMatchObject({ status: 'completed' });

    // session/open with a cursor the host compacted away: snapshot mode, state replaced.
    host.kill();
    p.replica.sendMessage(sessionId, [{ type: 'text', text: 'again' }]);
    await until(() => expect(view.status).toBe('waiting_approval'));
    host.kill();
    host.resolveElsewhere(sessionId, 'accept');
    host.compact(sessionId, host.head(sessionId));
    await until(() => expect(view.status).toBe('idle'));
    expect(view.cursor).toBe(host.head(sessionId));
    expect(hostTurns(view).map((t) => t.status)).toEqual(['completed', 'completed']);
  });
});

describe('envelope behaviour against the fake host', () => {
  it('chunks a large message both ways', async () => {
    const p = phone();
    const sessionId = await newChat(p);
    const view = p.replica.session(sessionId)!;
    await p.replica.resolveApproval(sessionId, Object.keys(view.approvals)[0]!, 'accept');
    await until(() => expect(view.status).toBe('idle'));
    const big = 'ü'.repeat(120_000); // 240 KB of UTF-8
    const id = p.replica.sendMessage(sessionId, [{ type: 'text', text: big }]);
    await until(() => expect(view.turns.some((t) => t.optimistic !== undefined)).toBe(false));
    const stream = host.stream!;
    expect(stream.received.filter((e) => e.type === 'client_message_chunk').length).toBeGreaterThanOrEqual(3);
    expect(stream.requests.find((r) => r.method === 'turn/start')!.params.input[0].text).toBe(big);
    const echoed = Object.values(view.items).find((i) => i.type === 'userMessage' && i.clientMessageId === id);
    expect(echoed).toMatchObject({ content: [{ type: 'text', text: big }] }); // arrived as server chunks
  });

  it('a request with no answer times out', async () => {
    const p = phone();
    p.client.start();
    await until(() => expect(p.client.state).toBe('ready'));
    host.onRequest = (method) => (method === 'host/status' ? 'drop' : undefined);
    await expect(p.client.request('host/status', {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
    host.onRequest = undefined;
    await expect(p.client.request('host/status')).resolves.toMatchObject({ sessionsActive: 1 });
    await expect(p.client.request('no/such/method')).rejects.toMatchObject({ code: 'method_not_found' });
  });

  it('a seq_id gap from the host makes the client close 4002 and start a new stream', async () => {
    const p = phone();
    p.client.start();
    await until(() => expect(p.client.state).toBe('ready'));
    const first = host.stream!;
    first.sendRaw(JSON.stringify({ type: 'server_message', client_id: first.clientId, stream_id: first.streamId, seq_id: first.lastOut + 5, message: {} }));
    await until(() => expect(host.stream?.streamId).not.toBe(first.streamId));
    await until(() => expect(p.client.state).toBe('ready'));
  });

  it.each([4002, 4008, 4010])('close %i: waits, then reconnects with a new stream', async (code) => {
    const p = phone();
    const states: string[] = [];
    p.client.on('state', (state) => states.push(state));
    p.client.start();
    await until(() => expect(p.client.state).toBe('ready'));
    const first = host.stream!.streamId;
    const closedAt = Date.now();
    host.closeAll(code, 'test');
    await until(() => expect(states.slice(-3)).toEqual(['waiting', 'connecting', 'ready']));
    expect(host.stream!.streamId).not.toBe(first);
    // 4010 (draining) waits the draining delay (150 ms here); the others the first backoff step (20 ms).
    if (code === 4010) expect(Date.now() - closedAt).toBeGreaterThanOrEqual(140);
  });

  it('close 4001: update_required; close 4003: unpaired; neither reconnects', async () => {
    const a = phone();
    a.client.start();
    await until(() => expect(a.client.state).toBe('ready'));
    host.closeAll(4001, 'accepted: 2');
    await until(() => expect(a.client.state).toBe('update_required'));

    host.refuse({ code: 4003, reason: 'unknown device' });
    const b = phone();
    b.client.start();
    await until(() => expect(b.client.state).toBe('unpaired'));
    const streams = host.streams.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.streams.length).toBe(streams);
  });

  it('a host that refuses the protocol version answers unsupported_protocol and closes 4001', async () => {
    const p = phone();
    // Simulate a host that does not accept version 1: it sees another version in initialize.
    const handle = host.handle.bind(host);
    host.handle = (stream, method, params) => handle(stream, method, method === 'initialize' ? { ...params, protocolVersion: 99 } : params);
    p.client.start();
    await until(() => expect(p.client.state).toBe('update_required'));
  });
});
