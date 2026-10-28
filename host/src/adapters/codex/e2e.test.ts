// End to end with the Codex adapter: the session core's acceptance scenarios (core/e2e.test.ts) with a
// CodexAgent driving the fake app-server instead of the FakeAdapter, plus the Codex-only paths (file
// changes, permissions, questions, engine crash, host restart).
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Journal } from '../../journal/journal.js';
import type { JournalEvent } from '../../journal/types.js';
import type { TestClient } from '../../stream/testing/client.js';
import { SessionStore } from '../../core/store.js';
import { eventsOf, openAfterTurn, rpc, rpcError, startHarness, text, waitEvent, type Harness } from '../../core/testing/harness.js';
import { makeRepo } from '../../core/testing/git-repo.js';
import { CodexAgent } from './provider.js';
import { fakeCodex, type FakeCodex } from './testing/fake-codex.js';
import type { FakeFixture } from './testing/fixture.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Rig {
  h: Harness;
  fake: FakeCodex;
  agent: CodexAgent;
}

async function setup(fixture: FakeFixture = {}, options: { fake?: FakeCodex; journal?: Journal; store?: SessionStore } = {}): Promise<Rig> {
  const fake = options.fake ?? fakeCodex(fixture);
  const agent = new CodexAgent({ config: fake.config });
  harness = await startHarness({
    extraAgents: [agent],
    ...(options.journal ? { journal: options.journal } : {}),
    ...(options.store ? { core: { store: options.store } } : {}),
  });
  return { h: harness, fake, agent };
}

async function newSession(h: Harness, client: TestClient, settings?: Record<string, unknown>): Promise<string> {
  const { session } = await rpc<{ session: { sessionId: string } }>(client, 'session/start', {
    agentId: 'codex',
    cwd: h.cwd,
    ...(settings ? { settings } : {}),
  });
  return session.sessionId;
}

const seqs = (events: JournalEvent[]) => events.map((e) => e.params.seq);
function expectDenseFrom(events: JournalEvent[], after: number): void {
  expect(seqs(events)).toEqual(events.map((_, i) => after + 1 + i));
}
const requestOf = (event: JournalEvent) => (event.params as { request: Record<string, unknown> & { requestId: string } }).request;
const turnOf = (event: JournalEvent) => (event.params as { turn: { turnId: string; status: string; error: unknown } }).turn;

// Every test spawns fake engines (node processes); on a busy machine that alone can take seconds, so the
// tests get an explicit timeout well above the 5 s default. Passing tests take as long as before.
describe('session core end to end with the Codex adapter', { timeout: 30_000 }, () => {
  it('bypass approvals: approvalMode never reaches thread/start with full access; an outside command runs unasked', async () => {
    const outside = '/bin/zsh -lc "touch /tmp/nano-outside-folder"';
    const { h, fake } = await setup({ turns: [[{ command: { command: outside, cwd: '/tmp', output: '' } }, { reply: 'Done.' }]] });
    const phone = await h.connect();
    const { session } = await rpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/start', {
      agentId: 'codex',
      cwd: h.cwd,
      settings: { approvalMode: 'never' },
    });
    expect(fake.sent('thread/start')[0]).toMatchObject({ cwd: h.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    // Session.settings reports what is in effect, so the phone can mark the session.
    expect(session.settings).toMatchObject({ approvalMode: 'never', sandbox: 'danger-full-access' });

    const sessionId = session.sessionId;
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('Touch a file outside the folder'), clientMessageId: randomUUID() });
    const completed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(completed).status).toBe('completed');
    const events = eventsOf(phone, sessionId);
    expect(events.map((e) => e.method)).not.toContain('approval/request');
    expect(events.find((e) => e.method === 'item/completed' && (e.params as { item: { type: string } }).item.type === 'command')).toMatchObject({
      params: { item: { command: outside, status: 'completed' } },
    });

    // Without the switch nothing changes: on-request, workspace-write, reported as such.
    const plain = await rpc<{ session: { settings: Record<string, unknown> } }>(phone, 'session/start', { agentId: 'codex', cwd: h.cwd });
    expect(fake.sent('thread/start')[1]).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(plain.session.settings).toMatchObject({ approvalMode: 'on-request', sandbox: 'workspace-write' });
  });

  it('open, turn/start, approval/request, approval/resolve accept, turn/completed', async () => {
    const { h, fake } = await setup({ turns: [[{ command: { reason: 'May I create hello.txt?', output: 'ok\n' } }, { reply: 'Done.' }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    expect(fake.sent('thread/start')[0]).toMatchObject({ cwd: h.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'gpt-fake-luna' });

    const opened = await rpc<{ mode: string; cursor: number; turns: unknown[] }>(phone, 'session/open', { sessionId });
    expect(opened.mode).toBe('snapshot');

    const clientMessageId = randomUUID();
    const { turn } = await rpc<{ turn: { turnId: string; status: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('Create hello.txt'),
      clientMessageId,
    });
    expect(turn.status).toBe('inProgress');
    expect(fake.sent('turn/start')[0]).toMatchObject({ clientUserMessageId: clientMessageId });

    const request = await waitEvent(phone, 'approval/request');
    const req = requestOf(request);
    expect(req).toMatchObject({
      kind: 'command',
      sessionId,
      turnId: turn.turnId,
      reason: 'May I create hello.txt?',
      availableDecisions: ['accept', 'cancel'],
      expiresAt: null,
    });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'waiting_approval');
    expect(await rpc(phone, 'approval/resolve', { sessionId, requestId: req.requestId, decision: 'accept' })).toEqual({ ok: true });
    const completed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(completed).status).toBe('completed');
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');

    const live = eventsOf(phone, sessionId);
    expectDenseFrom(live, opened.cursor);
    expect(live.map((e) => e.method)).toEqual([
      'session/changed', // title from the first input
      'turn/started',
      'item/started', // userMessage (the core's, with the clientMessageId)
      'item/completed',
      'status/changed', // running
      'item/started', // command
      'status/changed', // waiting_approval (engine thread status)
      'approval/request',
      'request/resolved',
      'status/changed', // running
      'item/delta', // command output
      'item/completed',
      'item/started', // agentMessage
      'item/delta',
      'item/completed',
      'usage/updated',
      'turn/completed',
      'status/changed', // idle
    ]);
    const user = live[2]!.params as { item: { type: string; clientMessageId: string } };
    expect(user.item).toMatchObject({ type: 'userMessage', clientMessageId });
    expect(live.filter((e) => e.method === 'item/started' && (e.params as { item: { type: string } }).item.type === 'userMessage')).toHaveLength(1);
    expect(live[8]!.params).toMatchObject({ requestId: req.requestId, kind: 'command', resolvedBy: 'dev_test', decision: 'accept' });
    expect(live[15]!.params).toMatchObject({ usage: { inputTokens: 1200, outputTokens: 80, contextPercent: 1 } });
    expect(fake.replies()).toContainEqual({ id: 0, result: { decision: 'accept' } });
  });

  it('a decision the engine did not offer is invalid_params', async () => {
    const { h } = await setup({ turns: [[{ command: {} }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const req = requestOf(await waitEvent(phone, 'approval/request'));
    const error = await rpcError(phone, 'approval/resolve', { sessionId, requestId: req.requestId, decision: 'acceptForSession' });
    expect(error.code).toBe('invalid_params');
  });

  it('reconnect with a cursor answers in events mode with exactly the missed events', async () => {
    const { h } = await setup({ turns: [[{ reply: 'first' }], [{ reply: 'second', chunks: 3 }]] });
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

    const laptop = await h.connect('other-token');
    await rpc(laptop, 'session/open', { sessionId });
    await rpc(laptop, 'turn/start', { sessionId, input: text('two'), clientMessageId: randomUUID() });
    await waitEvent(laptop, 'status/changed', (p) => p.status === 'idle');
    const head = h.journal.head(sessionId);

    const back = await h.connect();
    const reopened = await rpc<{ mode: string; events: JournalEvent[]; cursor: number }>(back, 'session/open', { sessionId, cursor: lastSeen });
    expect(reopened.mode).toBe('events');
    expect(reopened.cursor).toBe(head);
    expect(reopened.events).toEqual(h.journal.since(sessionId, lastSeen).events);
    expect(reopened.events.filter((e) => e.method === 'item/delta')).toHaveLength(3);
  });

  it('snapshot mode returns the turns and the pending approval', async () => {
    const { h } = await setup({ turns: [[{ reply: 'hello' }], [{ command: {} }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('one'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'turn/completed');
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    await rpc(phone, 'turn/start', { sessionId, input: text('two'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'approval/request');

    const snapshot = await rpc<{
      session: { status: string };
      turns: { status: string; items: { type: string }[] }[];
      pending: { approvals: { requestId: string; kind: string }[] };
    }>(phone, 'session/open', { sessionId });
    expect(snapshot.session.status).toBe('waiting_approval');
    expect(snapshot.turns.map((t) => t.status)).toEqual(['completed', 'inProgress']);
    expect(snapshot.turns[0]!.items.map((i) => i.type)).toEqual(['userMessage', 'agentMessage']);
    expect(snapshot.turns[1]!.items.map((i) => i.type)).toEqual(['userMessage', 'command']);
    expect(snapshot.pending.approvals).toMatchObject([{ kind: 'command' }]);
  });

  it('two streams: one resolves, the other receives request/resolved and loses the race', async () => {
    const { h, fake } = await setup({ turns: [[{ command: { availableDecisions: ['accept', 'decline', 'cancel'] } }, { reply: 'ok' }]] });
    const phone = await h.connect();
    const laptop = await h.connect('other-token');
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(laptop, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const requestId = requestOf(await waitEvent(laptop, 'approval/request')).requestId;

    await rpc(laptop, 'approval/resolve', { sessionId, requestId, decision: 'decline' });
    const resolved = await waitEvent(phone, 'request/resolved');
    expect(resolved.params).toMatchObject({ requestId, resolvedBy: 'dev_other', decision: 'decline' });
    const late = await rpcError(phone, 'approval/resolve', { sessionId, requestId, decision: 'accept' });
    expect(late).toMatchObject({ code: 'already_resolved', data: { resolvedBy: 'dev_other' } });
    await waitEvent(phone, 'turn/completed');
    await waitEvent(laptop, 'status/changed', (p) => p.status === 'idle');
    expect(fake.replies()).toEqual([{ id: 0, result: { decision: 'decline' } }]);
    expect(eventsOf(phone, sessionId)).toEqual(eventsOf(laptop, sessionId));
  });

  it('session_busy while a turn runs, then steer into it with expectedTurnId', async () => {
    const { h, fake } = await setup({ turns: [[{ hold: true }, { reply: 'steered' }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('long task'), clientMessageId: randomUUID() });
    const busy = await rpcError(phone, 'turn/start', { sessionId, input: text('another'), clientMessageId: randomUUID() });
    expect(busy).toMatchObject({ code: 'session_busy', data: { turnId: turn.turnId } });

    const steerId = randomUUID();
    const steered = await rpc<{ turn: { turnId: string } }>(phone, 'turn/steer', {
      sessionId,
      turnId: turn.turnId,
      input: text('also do this'),
      clientMessageId: steerId,
    });
    expect(steered.turn.turnId).toBe(turn.turnId);
    expect(fake.sent('turn/steer')[0]).toMatchObject({
      expectedTurnId: expect.any(String),
      clientUserMessageId: steerId,
      input: [{ type: 'text', text: 'also do this' }],
    });
    const reply = await waitEvent(phone, 'item/completed', (p) => (p.item as { type: string }).type === 'agentMessage');
    expect(reply.params).toMatchObject({ turnId: turn.turnId, item: { text: 'steered' } });
    await waitEvent(phone, 'turn/completed');
    // The engine's echo of the steer message is not journaled twice.
    const users = eventsOf(phone, sessionId).filter((e) => e.method === 'item/started' && (e.params as { item: { type: string } }).item.type === 'userMessage');
    expect(users).toHaveLength(2);
  });

  it('interrupt withdraws a pending approval and ends the turn interrupted', async () => {
    const { h, fake } = await setup({ turns: [[{ command: {} }, { reply: 'never' }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const requestId = requestOf(await waitEvent(phone, 'approval/request')).requestId;

    expect(await rpc(phone, 'turn/interrupt', { sessionId, turnId: turn.turnId })).toEqual({ ok: true });
    const withdrawn = await waitEvent(phone, 'request/resolved');
    expect(withdrawn.params).toMatchObject({ requestId, resolvedBy: 'agent', decision: 'cancel' });
    const completed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(completed).status).toBe('interrupted');
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    expect(h.journal.pending(sessionId)).toEqual({ approvals: [], inputs: [] });
    expect(fake.sent('turn/interrupt')).toHaveLength(1);
    expect(fake.replies()).toEqual([]);
    expect(await rpc(phone, 'turn/interrupt', { sessionId, turnId: turn.turnId })).toEqual({ ok: true });
  });

  it('session/start with input starts the first turn in one round trip', async () => {
    const { h } = await setup();
    const phone = await h.connect();
    const result = await rpc<{ session: { sessionId: string; title: string }; turn: { turnId: string } }>(phone, 'session/start', {
      agentId: 'codex',
      cwd: h.cwd,
      input: text('Create a file named hello.txt'),
    });
    expect(result.session.title).toBe('Create a file named hello.txt');
    // The turn may finish before this client subscribes; openAfterTurn reads the snapshot first.
    const opened = await openAfterTurn(phone, result.session.sessionId, result.turn.turnId);
    expect(opened.turns[0]!.status).toBe('completed');
    expect(opened.turns[0]!.items[1]).toMatchObject({ type: 'agentMessage', text: 'You said: Create a file named hello.txt' });
  });

  it('file-change approval, permission approval and a question, through the protocol', async () => {
    const questions = [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'blue', description: '' }] }];
    const { h, fake } = await setup({
      turns: [[{ fileChange: { path: 'hello.txt', diff: '+hello' } }, { permissions: {} }, { input: { questions } }, { reply: 'all done' }]],
    });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone, { sandbox: 'read-only' });
    expect(fake.sent('thread/start')[0]).toMatchObject({ sandbox: 'read-only' });
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });

    const fileReq = requestOf(await waitEvent(phone, 'approval/request', (p) => (p.request as { kind: string }).kind === 'fileChange'));
    expect(fileReq).toMatchObject({ changes: [{ path: 'hello.txt', kind: 'add', diff: '+hello' }] });
    await rpc(phone, 'approval/resolve', { sessionId, requestId: fileReq.requestId, decision: 'acceptForSession' });

    const permReq = requestOf(await waitEvent(phone, 'approval/request', (p) => (p.request as { kind: string }).kind === 'permission'));
    expect(permReq).toMatchObject({ scope: 'turn', permissions: { network: { enabled: true } } });
    await rpc(phone, 'approval/resolve', { sessionId, requestId: permReq.requestId, decision: 'accept' });

    const input = await waitEvent(phone, 'input/request');
    const inputReq = requestOf(input);
    expect(inputReq).toMatchObject({ kind: 'input', sessionId, isBlocking: true, questions: [{ id: 'color', isOther: false, isSecret: false }] });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'waiting_input');
    expect(await rpc(phone, 'input/answer', { sessionId, requestId: inputReq.requestId, answers: { color: ['blue'] } })).toEqual({ ok: true });

    await waitEvent(phone, 'turn/completed');
    expect(fake.replies().map((m) => m.result)).toEqual([
      { decision: 'acceptForSession' },
      { permissions: { network: { enabled: true } }, scope: 'turn' },
      { answers: { color: { answers: ['blue'] } } },
    ]);
    const texts = eventsOf(phone, sessionId).flatMap((e) =>
      e.method === 'item/completed' && (e.params as { item: { type: string } }).item.type === 'agentMessage'
        ? [(e.params as { item: { text: string } }).item.text]
        : [],
    );
    expect(texts).toEqual(['granted for the turn', 'Answers: {"color":{"answers":["blue"]}}', 'all done']);
  });

  it('engine crash mid-turn fails the turn; the next turn restarts the engine and resumes the thread', async () => {
    const { h, fake } = await setup({ turns: [[{ command: {} }, { crash: 1 }], [{ reply: 'I remember' }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const requestId = requestOf(await waitEvent(phone, 'approval/request')).requestId;
    await rpc(phone, 'approval/resolve', { sessionId, requestId, decision: 'accept' });

    const failed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(failed)).toMatchObject({ status: 'failed', error: { code: 'agent_exited' } });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'error');

    const threadId = h.core.sessions.store.get(sessionId).engineSessionId;
    await rpc(phone, 'turn/start', { sessionId, input: text('what did you do?'), clientMessageId: randomUUID() });
    const reply = await waitEvent(phone, 'item/completed', (p) => (p.item as { text?: string }).text === 'I remember');
    expect(reply).toBeDefined();
    expect(fake.sent('thread/resume')).toMatchObject([{ threadId, initialTurnsPage: { limit: 5, itemsView: 'full' } }]);
    expect(fake.pids()).toHaveLength(2);
  });

  it('host restart: the next turn resumes the engine thread with thread/resume', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-codex-restart-'));
    const file = path.join(dir, 'journal.sqlite');
    const fake = fakeCodex({ turns: [[{ reply: 'first' }], [{ reply: 'after restart' }]] });
    const first = await setup({}, { fake, journal: new Journal({ path: file }), store: new SessionStore(file) });
    const phone = await first.h.connect();
    const sessionId = await newSession(first.h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('one'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    const threadId = first.h.core.sessions.store.get(sessionId).engineSessionId;
    expect(threadId).toBe(fake.sent('turn/start')[0]!.threadId);
    await first.h.close();
    harness = undefined;

    const second = await setup({}, { fake, journal: new Journal({ path: file }), store: new SessionStore(file) });
    const back = await second.h.connect();
    const opened = await rpc<{ turns: unknown[] }>(back, 'session/open', { sessionId });
    expect(opened.turns).toHaveLength(1);
    await rpc(back, 'turn/start', { sessionId, input: text('two'), clientMessageId: randomUUID() });
    await waitEvent(back, 'item/completed', (p) => (p.item as { text?: string }).text === 'after restart');
    expect(fake.sent('thread/resume')).toEqual([
      expect.objectContaining({ threadId, cwd: first.h.cwd, initialTurnsPage: { limit: 5, itemsView: 'full' } }),
    ]);
    expect(fake.sent('thread/start')).toHaveLength(1);
  });

  it('model/list and agent/list report the engine models and version', async () => {
    const { h, fake, agent } = await setup({
      userAgent: 'codex_cli_rs/0.163.0-alpha.10.2 (Mac OS 26.0; arm64)',
      modelPageSize: 1,
      models: [
        { id: 'gpt-a', displayName: 'A' },
        { id: 'gpt-b', displayName: 'B', isDefault: true },
        { id: 'gpt-hidden', hidden: true },
      ],
    });
    const changes: number[] = [];
    agent.onStateChange(() => changes.push(1));
    const phone = await h.connect();
    const { models } = await rpc<{ models: unknown[] }>(phone, 'model/list', { agentId: 'codex' });
    expect(models).toEqual([
      { id: 'gpt-a', displayName: 'A', default: false },
      { id: 'gpt-b', displayName: 'B', default: true },
    ]);
    const { agents } = await rpc<{ agents: { id: string; status: string; version?: string }[] }>(phone, 'agent/list');
    expect(agents.find((a) => a.id === 'codex')).toEqual({
      id: 'codex',
      name: 'Codex',
      status: 'ready',
      version: '0.163.0-alpha.10.2',
      capabilities: { steer: true, diff: true, approvalModes: ['untrusted', 'on-failure', 'on-request', 'never'], attachments: { images: true, files: true }, backgroundTasks: false, settingsUpdate: ['model', 'effort', 'approvalMode'] },
    });
    expect(changes).toEqual([1]);
    // Cached: no second engine for the list, and new sessions get the default without asking again.
    await rpc(phone, 'model/list', { agentId: 'codex' });
    await newSession(h, phone);
    expect(fake.sent('model/list')).toHaveLength(3);
    expect(fake.sent('thread/start')[0]).toMatchObject({ model: 'gpt-b' });
  });

  it('a missing engine binary makes the agent unavailable', async () => {
    const fake = fakeCodex();
    const agent = new CodexAgent({ config: { ...fake.config, binary: '/nonexistent/codex' } });
    harness = await startHarness({ extraAgents: [agent] });
    const phone = await harness.connect();
    const { agents } = await rpc<{ agents: { id: string; status: string; reason?: string }[] }>(phone, 'agent/list');
    expect(agents.find((a) => a.id === 'codex')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('/nonexistent/codex') });
    const error = await rpcError(phone, 'session/start', { agentId: 'codex', cwd: harness.cwd });
    expect(error.code).toBe('agent_unavailable');
  });

  it('an engine that cannot start makes session/start answer agent_unavailable', async () => {
    const { h } = await setup({ fail: { initialize: 'not logged in' } });
    const phone = await h.connect();
    const error = await rpcError(phone, 'session/start', { agentId: 'codex', cwd: h.cwd });
    expect(error).toMatchObject({ code: 'agent_unavailable', data: { agentId: 'codex', reason: expect.stringContaining('not logged in') } });
    const list = await rpcError(phone, 'model/list', { agentId: 'codex' });
    expect(list.code).toBe('agent_unavailable');
  });

  it('a delta whose text holds U+2028 and U+2029 reaches the Journal intact (LF-only framing)', async () => {
    const reply = 'one\u2028two\u2029three';
    const { h } = await setup({ turns: [[{ reply, chunks: 1 }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('Say it'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'turn/completed');
    const stored = h.journal.since(sessionId, 0).events;
    const deltas = stored.filter((e) => e.method === 'item/delta').map((e) => (e.params as { delta: string }).delta);
    expect(deltas).toEqual([reply]);
    const message = stored
      .filter((e) => e.method === 'item/completed')
      .map((e) => (e.params as { item: { type: string; text?: string } }).item)
      .find((i) => i.type === 'agentMessage');
    expect(message?.text).toBe(reply);
  });
});

describe('the Changes view with the Codex adapter', { timeout: 30_000 }, () => {
  it('turn/diff lists exactly what the engine wrote, edited and deleted during the turn', async () => {
    const repo = makeRepo({ '.gitignore': 'dist/\n', 'src/app.ts': 'export const a = 1;\n', 'stale.txt': 'stale\n' });
    repo.commit('initial');
    const files = { 'src/app.ts': 'export const a = 2;\n', 'hello.txt': 'hello\n', 'stale.txt': null, 'dist/bundle.js': 'ignored\n' };
    const fake = fakeCodex({ turns: [[{ run: { command: 'node build.js', output: 'built\n', files } }, { reply: 'Done.' }]] });
    harness = await startHarness({ extraAgents: [new CodexAgent({ config: fake.config })], core: { startSnapshotWaitMs: 30_000 } });
    try {
      const phone = await harness.connect();
      const { agents } = await rpc<{ agents: { id: string; capabilities?: { diff: boolean } }[] }>(phone, 'agent/list');
      expect(agents.find((a) => a.id === 'codex')?.capabilities?.diff).toBe(true);
      const { session } = await rpc<{ session: { sessionId: string } }>(phone, 'session/start', { agentId: 'codex', cwd: repo.root });
      const sessionId = session.sessionId;
      await rpc(phone, 'session/open', { sessionId });
      const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('Build it'), clientMessageId: randomUUID() });
      await waitEvent(phone, 'turn/completed');

      // Blob ids are git's (git hash-object) for the contents above.
      expect(await rpc(phone, 'turn/diff', { sessionId, turnId: turn.turnId })).toEqual({
        files: [
          {
            path: 'hello.txt',
            kind: 'add',
            diff: 'diff --git a/hello.txt b/hello.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hello\n',
          },
          {
            path: 'src/app.ts',
            kind: 'modify',
            diff: 'diff --git a/src/app.ts b/src/app.ts\nindex cc798ff..66d48fc 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n',
          },
          {
            path: 'stale.txt',
            kind: 'delete',
            diff: 'diff --git a/stale.txt b/stale.txt\ndeleted file mode 100644\nindex 8427fc2..0000000\n--- a/stale.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-stale\n',
          },
        ],
      });
    } finally {
      repo.remove();
    }
  });
});
