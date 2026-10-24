// End to end with the Claude adapter: the session core's acceptance scenarios (core/e2e.test.ts) with a
// ClaudeAgent driving the fake query (testing/fake-query.ts) instead of the FakeAdapter, plus the
// Claude-only paths (questions, bypass, engine crash, host restart, models and version).
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
import { claudeConfig } from '../../config/claude.js';
import { ClaudeAgent } from './provider.js';
import { FakeClaude, until, type FakeClaudeOptions } from './testing/fake-query.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Rig {
  h: Harness;
  fake: FakeClaude;
  agent: ClaudeAgent;
}

async function setup(
  options: FakeClaudeOptions = {},
  extra: { fake?: FakeClaude; journal?: Journal; store?: SessionStore; configDir?: string; requestTimeoutMs?: number } = {},
): Promise<Rig> {
  const fake = extra.fake ?? new FakeClaude(options);
  const configDir = extra.configDir ?? mkdtempSync(path.join(tmpdir(), 'nano-claude-cfg-'));
  const agent = new ClaudeAgent({ config: claudeConfig({ configDir, requestTimeoutMs: extra.requestTimeoutMs ?? 15_000, killGraceMs: 300 }, {}), query: fake.query });
  harness = await startHarness({
    extraAgents: [agent],
    ...(extra.journal ? { journal: extra.journal } : {}),
    ...(extra.store ? { core: { store: extra.store } } : {}),
  });
  return { h: harness, fake, agent };
}

async function newSession(h: Harness, client: TestClient, settings?: Record<string, unknown>): Promise<string> {
  const { session } = await rpc<{ session: { sessionId: string } }>(client, 'session/start', {
    agentId: 'claude',
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

const bash = (command: string, description = 'May I create hello.txt?') => ({ tool: 'Bash', input: { command, description } });

describe('session core end to end with the Claude adapter', () => {
  it('open, turn/start, approval/request, approval/resolve accept, turn/completed', async () => {
    const { h, fake } = await setup({ turns: [[{ ...bash('echo hello > hello.txt'), id: 'toolu_1' }, { text: 'Done.', chunks: 1 }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    expect(h.core.sessions.store.get(sessionId).engineSessionId).toBe('');

    const opened = await rpc<{ mode: string; cursor: number; turns: unknown[]; session: { settings: unknown } }>(phone, 'session/open', { sessionId });
    expect(opened.mode).toBe('snapshot');
    expect(opened.turns).toEqual([]);
    expect(opened.session.settings).toEqual({ model: 'opus', approvalMode: 'default' });

    const clientMessageId = randomUUID();
    const { turn } = await rpc<{ turn: { turnId: string; status: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('Create hello.txt'),
      clientMessageId,
    });
    expect(turn.turnId).toMatch(/^trn_/);
    expect(turn.status).toBe('inProgress');
    // The engine reported its session id with the first turn.
    expect(h.core.sessions.store.get(sessionId).engineSessionId).toBe(fake.last.sessionId);

    const request = await waitEvent(phone, 'approval/request');
    const req = requestOf(request);
    expect(req).toMatchObject({
      kind: 'command',
      sessionId,
      turnId: turn.turnId,
      itemId: 'toolu_1',
      command: 'echo hello > hello.txt',
      cwd: h.cwd,
      reason: 'May I create hello.txt?',
      expiresAt: null,
      availableDecisions: ['accept', 'decline', 'cancel'],
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
      'item/started', // userMessage
      'item/completed',
      'status/changed', // running
      'item/started', // command (tool_use)
      'approval/request',
      'status/changed', // waiting_approval
      'request/resolved',
      'status/changed', // running
      'item/completed', // command (tool_result)
      'item/started', // agentMessage
      'item/delta',
      'item/completed',
      'usage/updated',
      'turn/completed',
      'status/changed', // idle
    ]);
    expect((live[0]!.params as { session: { title: string } }).session.title).toBe('Create hello.txt');
    expect((live[2]!.params as { item: unknown }).item).toMatchObject({ type: 'userMessage', clientMessageId });
    expect(live[8]!.params).toMatchObject({ requestId: req.requestId, kind: 'command', resolvedBy: 'dev_test', decision: 'accept' });
    expect(fake.last.permissions.map((p) => p.answer)).toEqual([
      { behavior: 'allow', updatedInput: { command: 'echo hello > hello.txt', description: 'May I create hello.txt?' } },
    ]);
    expect((live[14]!.params as { usage: unknown }).usage).toEqual({ inputTokens: 123, outputTokens: 7 });
  });

  it('a decision the adapter did not offer is invalid_params', async () => {
    const { h } = await setup({ turns: [[bash('ls')]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const req = requestOf(await waitEvent(phone, 'approval/request'));
    const error = await rpcError(phone, 'approval/resolve', { sessionId, requestId: req.requestId, decision: 'acceptForSession' });
    expect(error.code).toBe('invalid_params');
    await rpc(phone, 'approval/resolve', { sessionId, requestId: req.requestId, decision: 'accept' });
    await waitEvent(phone, 'turn/completed');
  });

  it('reconnect with a cursor answers in events mode with exactly the missed events', async () => {
    const { h } = await setup({ turns: [[{ text: 'first' }], [{ text: 'second', chunks: 3 }]] });
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
    const deltas = reopened.events.filter((e) => e.method === 'item/delta').map((e) => (e.params as { delta: string }).delta);
    expect(deltas.join('')).toBe('second');
    expect(deltas).toHaveLength(3);
  });

  it('snapshot mode returns the turns and the pending approval', async () => {
    const { h } = await setup({ turns: [[{ text: 'hello' }], [bash('rm x')]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('one'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    await rpc(phone, 'turn/start', { sessionId, input: text('two'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'approval/request');

    const snapshot = await rpc<{
      mode: string;
      session: { status: string; title: string };
      turns: { status: string; items: { type: string }[] }[];
      pending: { approvals: { requestId: string }[] };
    }>(phone, 'session/open', { sessionId });
    expect(snapshot.mode).toBe('snapshot');
    expect(snapshot.session).toMatchObject({ status: 'waiting_approval', title: 'one' });
    expect(snapshot.turns.map((t) => t.status)).toEqual(['completed', 'inProgress']);
    expect(snapshot.turns[0]!.items.map((i) => i.type)).toEqual(['userMessage', 'agentMessage']);
    expect(snapshot.turns[1]!.items.map((i) => i.type)).toEqual(['userMessage', 'command']);
    expect(snapshot.pending.approvals).toHaveLength(1);
  });

  it('two streams: one resolves, the other receives request/resolved and loses the race', async () => {
    const { h, fake } = await setup({ turns: [[bash('ls'), { text: 'ok' }]] });
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
    expect(fake.last.permissions).toHaveLength(1);
    expect(fake.last.permissions[0]!.answer).toMatchObject({ behavior: 'deny' });
    expect(eventsOf(phone, sessionId)).toEqual(eventsOf(laptop, sessionId));
  });

  it('session_busy while a turn runs; steering answers not_supported', async () => {
    const { h, fake } = await setup({ turns: [[{ hold: true }, { text: 'finished' }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('long task'), clientMessageId: randomUUID() });

    const busy = await rpcError(phone, 'turn/start', { sessionId, input: text('another'), clientMessageId: randomUUID() });
    expect(busy).toEqual({ code: 'session_busy', message: expect.any(String), data: { turnId: turn.turnId } });
    const steer = await rpcError(phone, 'turn/steer', { sessionId, turnId: turn.turnId, input: text('also this'), clientMessageId: randomUUID() });
    expect(steer).toMatchObject({ code: 'not_supported', data: { agentId: 'claude' } });
    expect(fake.last.userMessages).toHaveLength(1);

    fake.last.release();
    expect(turnOf(await waitEvent(phone, 'turn/completed')).status).toBe('completed');
    expect(h.core.sessions.runningTurnId(sessionId)).toBeUndefined();
  });

  it('interrupt withdraws a pending approval and ends the turn interrupted', async () => {
    const { h, fake } = await setup({ turns: [[bash('ls'), { text: 'never' }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const requestId = requestOf(await waitEvent(phone, 'approval/request')).requestId;

    expect(await rpc(phone, 'turn/interrupt', { sessionId, turnId: turn.turnId })).toEqual({ ok: true });
    const withdrawn = await waitEvent(phone, 'request/resolved');
    expect(withdrawn.params).toMatchObject({ requestId, kind: 'command', resolvedBy: 'agent', decision: 'cancel' });
    const completed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(completed).status).toBe('interrupted');
    expect(completed.params.seq).toBeGreaterThan(withdrawn.params.seq);
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    expect(h.journal.pending(sessionId)).toEqual({ approvals: [], inputs: [] });
    expect(fake.last.interrupts).toBe(1);

    const late = await rpcError(phone, 'approval/resolve', { sessionId, requestId, decision: 'accept' });
    expect(late).toMatchObject({ code: 'already_resolved', data: { resolvedBy: 'agent' } });
    expect(await rpc(phone, 'turn/interrupt', { sessionId, turnId: turn.turnId })).toEqual({ ok: true });
  });

  it('Stop on an engine that never answers settles: the turn ends interrupted, and the next turn resumes', async () => {
    // A short real timeout (the adapter tests cover the full 120 s with fake timers).
    const tool = { message: { type: 'assistant', message: { id: 'msg_find', content: [{ type: 'tool_use', id: 'toolu_find', name: 'Bash', input: { command: 'find ~/Downloads' } }] }, parent_tool_use_id: null } };
    const { h, fake } = await setup({ interruptHangs: true, turns: [[tool, { hold: true }], [{ text: 'Back.' }]] }, { requestTimeoutMs: 150 });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    const { turn } = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    await until(() => (fake.last.holdingNow ? true : undefined), 'the hold');
    const engineSessionId = h.core.sessions.store.get(sessionId).engineSessionId;

    expect(await rpc(phone, 'turn/interrupt', { sessionId, turnId: turn.turnId })).toEqual({ ok: true });
    const completed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(completed).status).toBe('interrupted');
    await waitEvent(phone, 'status/changed', (p) => p.status === 'error');
    expect(h.core.sessions.runningTurnId(sessionId)).toBeUndefined();

    await rpc(phone, 'turn/start', { sessionId, input: text('again'), clientMessageId: randomUUID() });
    expect(fake.queries).toHaveLength(2);
    expect(fake.last.options.resume).toBe(engineSessionId);
    await until(
      () => eventsOf(phone, sessionId).find((e) => e.method === 'turn/completed' && turnOf(e).status === 'completed'),
      'the resumed turn',
    );
  });

  it('session/start with input starts the first turn in one round trip', async () => {
    const { h } = await setup();
    const phone = await h.connect();
    const result = await rpc<{ session: { sessionId: string }; turn: { turnId: string } }>(phone, 'session/start', {
      agentId: 'claude',
      cwd: h.cwd,
      input: text('Create a file named hello.txt and then list every file in this folder, please'),
    });
    const opened = await openAfterTurn(phone, result.session.sessionId, result.turn.turnId);
    expect(opened.turns[0]!.status).toBe('completed');
    expect(opened.turns[0]!.items[1]).toMatchObject({
      type: 'agentMessage',
      text: 'You said: Create a file named hello.txt and then list every file in this folder, please',
    });
  });

  it('a file change, a permission and a question, through the protocol', async () => {
    const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'blue', description: 'Calm' }], multiSelect: false }];
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }];
    const { h, fake } = await setup({
      turns: [
        [
          { tool: 'Write', input: { file_path: 'hello.txt', content: 'hello' }, suggestions },
          { tool: 'WebFetch', input: { url: 'https://example.com' } },
          { tool: 'AskUserQuestion', input: { questions } },
          { text: 'all done' },
        ],
      ],
    });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });

    const fileReq = requestOf(await waitEvent(phone, 'approval/request', (p) => (p.request as { kind: string }).kind === 'fileChange'));
    expect(fileReq).toMatchObject({ changes: [{ path: 'hello.txt', kind: 'add', diff: '@@ -0,0 +1,1 @@\n+hello' }] });
    expect(fileReq.availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    await rpc(phone, 'approval/resolve', { sessionId, requestId: fileReq.requestId, decision: 'acceptForSession' });

    const permReq = requestOf(await waitEvent(phone, 'approval/request', (p) => (p.request as { kind: string }).kind === 'permission'));
    expect(permReq).toMatchObject({ scope: 'turn', permissions: { tool: 'WebFetch', input: { url: 'https://example.com' } } });
    await rpc(phone, 'approval/resolve', { sessionId, requestId: permReq.requestId, decision: 'accept' });

    const inputReq = requestOf(await waitEvent(phone, 'input/request'));
    expect(inputReq).toMatchObject({ kind: 'input', sessionId, isBlocking: true, questions: [{ id: '0', question: 'Which color?', isOther: true, isSecret: false }] });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'waiting_input');
    expect(await rpc(phone, 'input/answer', { sessionId, requestId: inputReq.requestId, answers: { '0': ['blue'] } })).toEqual({ ok: true });

    await waitEvent(phone, 'turn/completed');
    expect(fake.last.permissions.map((p) => p.answer)).toEqual([
      { behavior: 'allow', updatedInput: { file_path: 'hello.txt', content: 'hello' }, updatedPermissions: suggestions },
      { behavior: 'allow', updatedInput: { url: 'https://example.com' } },
      { behavior: 'allow', updatedInput: { questions, answers: { 'Which color?': 'blue' } } },
    ]);
    const types = eventsOf(phone, sessionId)
      .filter((e) => e.method === 'item/completed')
      .map((e) => (e.params as { item: { type: string } }).item.type);
    expect(types).toEqual(['userMessage', 'fileChange', 'toolCall', 'toolCall', 'agentMessage']);
  });

  it('bypass approvals: approvalMode never runs bypassPermissions and tools run unasked', async () => {
    const { h, fake } = await setup({ turns: [[bash('touch /tmp/nano-outside-folder'), { text: 'Done.' }]] });
    const phone = await h.connect();
    const { session } = await rpc<{ session: { sessionId: string; settings: Record<string, unknown> } }>(phone, 'session/start', {
      agentId: 'claude',
      cwd: h.cwd,
      settings: { approvalMode: 'never' },
    });
    expect(fake.last.options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    expect(session.settings).toEqual({ approvalMode: 'never', model: 'opus' });
    const sessionId = session.sessionId;
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('touch it'), clientMessageId: randomUUID() });
    expect(turnOf(await waitEvent(phone, 'turn/completed')).status).toBe('completed');
    expect(eventsOf(phone, sessionId).map((e) => e.method)).not.toContain('approval/request');
  });

  it('engine crash mid-turn fails the turn; the next turn resumes the session on a new query', async () => {
    const { h, fake } = await setup({ turns: [[bash('ls'), { exit: true }], [{ text: 'I remember' }]] });
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('go'), clientMessageId: randomUUID() });
    const requestId = requestOf(await waitEvent(phone, 'approval/request')).requestId;
    await rpc(phone, 'approval/resolve', { sessionId, requestId, decision: 'accept' });

    const failed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(failed)).toMatchObject({ status: 'failed', error: { code: 'agent_exited', message: 'Claude Code killed by SIGKILL' } });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'error');

    const engineSessionId = h.core.sessions.store.get(sessionId).engineSessionId;
    expect(engineSessionId).toBe(fake.queries[0]!.sessionId);
    await rpc(phone, 'turn/start', { sessionId, input: text('what did you do?'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'item/completed', (p) => (p.item as { text?: string }).text === 'I remember');
    expect(fake.queries).toHaveLength(2);
    expect(fake.last.options.resume).toBe(engineSessionId);
  });

  it('host restart: the next turn resumes the engine session with query({resume})', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-claude-restart-'));
    const file = path.join(dir, 'journal.sqlite');
    const fake = new FakeClaude({ turns: [[{ text: 'first' }], [{ text: 'after restart' }]] });
    const first = await setup({}, { fake, journal: new Journal({ path: file }), store: new SessionStore(file) });
    const phone = await first.h.connect();
    const sessionId = await newSession(first.h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('one'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');
    const engineSessionId = first.h.core.sessions.store.get(sessionId).engineSessionId;
    expect(engineSessionId).toBe(fake.queries[0]!.sessionId);
    await first.h.close();
    harness = undefined;
    expect(fake.queries[0]!.closed).toBe(true);

    const second = await setup({}, { fake, journal: new Journal({ path: file }), store: new SessionStore(file) });
    const back = await second.h.connect();
    const opened = await rpc<{ turns: unknown[] }>(back, 'session/open', { sessionId });
    expect(opened.turns).toHaveLength(1);
    await rpc(back, 'turn/start', { sessionId, input: text('two'), clientMessageId: randomUUID() });
    await waitEvent(back, 'item/completed', (p) => (p.item as { text?: string }).text === 'after restart');
    expect(fake.queries).toHaveLength(2);
    expect(fake.last.options).toMatchObject({ resume: engineSessionId, cwd: first.h.cwd });
  });

  it('model/list and agent/list report the engine models and version', async () => {
    const { h, agent } = await setup();
    const changes: number[] = [];
    agent.onStateChange(() => changes.push(1));
    const phone = await h.connect();
    const { models } = await rpc<{ models: unknown[] }>(phone, 'model/list', { agentId: 'claude' });
    expect(models).toEqual([
      { id: 'opus', displayName: 'Opus 5.5', default: true },
      { id: 'sonnet', displayName: 'Sonnet 5.5', default: false },
      { id: 'haiku', displayName: 'Haiku 5.5', default: false },
    ]);
    const before = await rpc<{ agents: { id: string; version?: string }[] }>(phone, 'agent/list');
    expect(before.agents.find((a) => a.id === 'claude')).toEqual({
      id: 'claude',
      name: 'Claude Code',
      status: 'ready',
      version: '0.3.308',
      capabilities: { steer: false, diff: true, approvalModes: ['default', 'acceptEdits', 'plan', 'never'], attachments: { images: true, files: true } },
    });
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });
    await rpc(phone, 'turn/start', { sessionId, input: text('hi'), clientMessageId: randomUUID() });
    await waitEvent(phone, 'turn/completed');
    const after = await rpc<{ agents: { id: string; version?: string }[] }>(phone, 'agent/list');
    expect(after.agents.find((a) => a.id === 'claude')?.version).toBe('2.1.999');
    expect(changes).toEqual([1]);
  });

  it('a missing Claude config folder makes the agent unavailable', async () => {
    const { h } = await setup({}, { configDir: '/nonexistent/claude-config' });
    const phone = await h.connect();
    const { agents } = await rpc<{ agents: { id: string; status: string; reason?: string }[] }>(phone, 'agent/list');
    expect(agents.find((a) => a.id === 'claude')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('/nonexistent/claude-config') });
    const error = await rpcError(phone, 'session/start', { agentId: 'claude', cwd: h.cwd });
    expect(error.code).toBe('agent_unavailable');
  });

  it('an engine that cannot start makes session/start answer agent_unavailable', async () => {
    const { h } = await setup({ throwOnQuery: 'Claude Code executable not found' });
    const phone = await h.connect();
    const error = await rpcError(phone, 'session/start', { agentId: 'claude', cwd: h.cwd });
    expect(error).toMatchObject({ code: 'agent_unavailable', data: { agentId: 'claude', reason: expect.stringContaining('executable not found') } });
  });
});

describe('engine-initiated turns end to end (a background task reports in)', () => {
  const toolUse = (id: string, command: string) => ({
    message: { type: 'assistant', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }, parent_tool_use_id: null },
  });
  const toolResult = (id: string, output: string) => ({
    message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] }, parent_tool_use_id: null },
  });
  type SnapshotTurn = { turnId: string; status: string; items: { type: string; status: string; text?: string; command?: string; tool?: string }[] };

  it('a turn the engine starts by itself is journaled with its items, without a user message', async () => {
    const { h, fake } = await setup();
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    const opened = await rpc<{ cursor: number }>(phone, 'session/open', { sessionId });

    await fake.last.engineTurn(
      [{ text: 'Checking.', chunks: 1 }, toolUse('toolu_git', 'git status'), toolResult('toolu_git', 'clean'), { text: 'All clean.', chunks: 1 }],
      { summary: 'Monitor event: CI finished' },
    );
    const completed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(completed).status).toBe('completed');
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');

    const live = eventsOf(phone, sessionId);
    expectDenseFrom(live, opened.cursor);
    expect(live.map((e) => e.method)).toEqual([
      'turn/started',
      'status/changed', // running
      'item/started', // background task
      'item/completed',
      'item/started', // agentMessage
      'item/delta',
      'item/completed',
      'item/started', // command
      'item/completed',
      'item/started', // agentMessage
      'item/delta',
      'item/completed',
      'usage/updated',
      'turn/completed',
      'status/changed', // idle
    ]);
    const { turns } = await rpc<{ turns: SnapshotTurn[] }>(phone, 'session/open', { sessionId });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe('completed');
    expect(turns[0]!.items.map((i) => [i.type, i.status])).toEqual([
      ['toolCall', 'completed'],
      ['agentMessage', 'completed'],
      ['command', 'completed'],
      ['agentMessage', 'completed'],
    ]);
    expect(turns[0]!.items[0]!.tool).toBe('background task: Monitor event: CI finished');
    expect(h.core.sessions.journal.summary(sessionId)?.status).toBe('idle');
  });

  it('turn/start during an engine turn with a long tool joins it: the running tool, then the reply, no orphan turn', async () => {
    const { h, fake } = await setup();
    const phone = await h.connect();
    const sessionId = await newSession(h, phone);
    await rpc(phone, 'session/open', { sessionId });

    const played = fake.last.engineTurn([
      toolUse('toolu_cov', 'pnpm test:coverage'),
      { hold: true },
      toolResult('toolu_cov', 'all tests passed'),
      { text: 'Tests pass. Status: done.', chunks: 1 },
    ]);
    const started = await waitEvent(phone, 'turn/started');
    const engineTurnId = turnOf(started).turnId;
    await waitEvent(phone, 'item/started', (p) => (p.item as { type: string }).type === 'command');

    const clientMessageId = randomUUID();
    const { turn } = await rpc<{ turn: { turnId: string; status: string } }>(phone, 'turn/start', {
      sessionId,
      input: text('status?'),
      clientMessageId,
    });
    expect(turn).toMatchObject({ turnId: engineTurnId, status: 'inProgress' });
    expect(h.core.sessions.journal.summary(sessionId)?.status).toBe('running');

    // While the tool runs the phone sees it running, with the user's message in the same turn.
    const during = await rpc<{ turns: SnapshotTurn[] }>(phone, 'session/open', { sessionId });
    expect(during.turns).toHaveLength(1);
    expect(during.turns[0]!.items.map((i) => [i.type, i.status])).toEqual([
      ['toolCall', 'completed'],
      ['command', 'inProgress'],
      ['userMessage', 'completed'],
    ]);
    expect(during.turns[0]!.items[1]!.command).toBe('pnpm test:coverage');
    await until(() => (fake.last.midTurn.length > 0 ? true : undefined), 'the mid-turn message');

    // A retry of the same message returns the same turn.
    const again = await rpc<{ turn: { turnId: string } }>(phone, 'turn/start', { sessionId, input: text('status?'), clientMessageId });
    expect(again.turn.turnId).toBe(engineTurnId);

    fake.last.release();
    await played;
    const completed = await waitEvent(phone, 'turn/completed');
    expect(turnOf(completed)).toMatchObject({ turnId: engineTurnId, status: 'completed' });
    await waitEvent(phone, 'status/changed', (p) => p.status === 'idle');

    const after = await rpc<{ turns: SnapshotTurn[] }>(phone, 'session/open', { sessionId });
    expect(after.turns.map((t) => t.status)).toEqual(['completed']);
    expect(after.turns[0]!.items.map((i) => [i.type, i.status])).toEqual([
      ['toolCall', 'completed'],
      ['command', 'completed'],
      ['userMessage', 'completed'],
      ['agentMessage', 'completed'],
    ]);
    expect(after.turns[0]!.items[3]!.text).toBe('Tests pass. Status: done.');
    expect(eventsOf(phone, sessionId).filter((e) => e.method === 'turn/started')).toHaveLength(1);
    expect(h.core.sessions.activeCount()).toBe(0);
  });
});
