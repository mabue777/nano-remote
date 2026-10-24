// The Codex adapter against the fake app-server: the section 11 mapping, call by call.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AdapterEvent } from '../../core/adapter.js';
import { codexConfig } from '../../config/codex.js';
import { CodexAdapter, RESUME_TURNS, sessionPolicy } from './adapter.js';
import { attachmentFixture } from '../shared/testing/attachments.js';
import { fakeCodex, until, type FakeCodex } from './testing/fake-codex.js';
import type { FakeFixture } from './testing/fixture.js';
import { FIELD_CHECK_MAPPED, FIELD_CHECK_USAGE } from './testing/token-usage-field-check.js';

const adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.kill()));
});

const text = (value: string) => [{ type: 'text' as const, text: value }];
const cwd = () => mkdtempSync(path.join(tmpdir(), 'nano-codex-cwd-'));

interface Rig {
  fake: FakeCodex;
  adapter: CodexAdapter;
  events: AdapterEvent[];
  /** Resolves with the first event of `method` (after `from` events) matching `match`. */
  next<M extends AdapterEvent['method']>(method: M, match?: (e: Extract<AdapterEvent, { method: M }>) => boolean): Promise<Extract<AdapterEvent, { method: M }>>;
}

function rig(fixture: FakeFixture = {}, options: { defaultModel?: () => string | undefined; fake?: FakeCodex } = {}): Rig {
  const fake = options.fake ?? fakeCodex(fixture);
  const logs: string[] = [];
  const adapter = new CodexAdapter({ config: fake.config, defaultModel: options.defaultModel, log: (m) => logs.push(m) });
  adapters.push(adapter);
  const events: AdapterEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  return {
    fake,
    adapter,
    events,
    next: <M extends AdapterEvent['method']>(method: M, match: (e: Extract<AdapterEvent, { method: M }>) => boolean = () => true) =>
      until(
        () => events.find((e) => e.method === method && match(e as Extract<AdapterEvent, { method: M }>)) as Extract<AdapterEvent, { method: M }> | undefined,
        `adapter event ${method}`,
      ),
  };
}

const methods = (events: AdapterEvent[]) => events.map((e) => e.method);

// Every test spawns fake engines (node processes); on a busy machine that alone can take seconds, so the
// tests get an explicit timeout well above the 5 s default. Passing tests take as long as before.
describe('CodexAdapter', { timeout: 30_000 }, () => {
  it('start: initialize, initialized, model from model/list, thread/start with the session policy', async () => {
    const r = rig();
    const dir = cwd();
    const threadId = await r.adapter.start(dir, {});
    expect(threadId).toMatch(/[0-9a-f-]{36}/);
    expect(r.adapter.engineSessionId).toBe(threadId);
    expect(r.adapter.pid).toBeGreaterThan(0);
    const log = r.fake.log().map((e) => e.message.method);
    expect(log.slice(0, 4)).toEqual(['initialize', 'initialized', 'model/list', 'thread/start']);
    expect(r.fake.sent('initialize')[0]).toMatchObject({
      clientInfo: { name: 'nano-remote-host' },
      capabilities: { experimentalApi: true },
    });
    expect(r.fake.sent('thread/start')[0]).toEqual({
      cwd: dir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: 'gpt-fake-luna',
    });
  });

  it('start honours the settings: model and sandbox; a provider default skips model/list', async () => {
    const r = rig({}, { defaultModel: () => 'gpt-from-provider' });
    await r.adapter.start(cwd(), { model: 'gpt-fake-astra', sandbox: 'read-only' });
    expect(r.fake.sent('thread/start')[0]).toMatchObject({ model: 'gpt-fake-astra', sandbox: 'read-only' });
    const p = rig({}, { defaultModel: () => 'gpt-from-provider' });
    await p.adapter.start(cwd(), { sandbox: 'nonsense' });
    expect(p.fake.sent('thread/start')[0]).toMatchObject({ model: 'gpt-from-provider', sandbox: 'workspace-write' });
    expect(p.fake.sent('model/list')).toEqual([]);
  });

  describe('approval mode (settings.approvalMode)', () => {
    const config = codexConfig({}, {});
    it.each([
      ['default', {}, { approvalPolicy: 'on-request', sandbox: 'workspace-write' }],
      ['unknown value falls back to config', { approvalMode: 'onRequest' }, { approvalPolicy: 'on-request', sandbox: 'workspace-write' }],
      ['untrusted', { approvalMode: 'untrusted' }, { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
      ['on-failure', { approvalMode: 'on-failure' }, { approvalPolicy: 'on-failure', sandbox: 'workspace-write' }],
      ['never means full access', { approvalMode: 'never' }, { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
      ['never with an explicit sandbox keeps it', { approvalMode: 'never', sandbox: 'workspace-write' }, { approvalPolicy: 'never', sandbox: 'workspace-write' }],
      ['never with an unknown sandbox is full access', { approvalMode: 'never', sandbox: 'nonsense' }, { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
    ])('%s', (_name, settings, expected) => {
      expect(sessionPolicy(settings, config)).toEqual(expected);
    });

    it('thread/start carries never and full access; effective settings report them', async () => {
      const r = rig();
      const dir = cwd();
      await r.adapter.start(dir, { approvalMode: 'never' });
      expect(r.fake.sent('thread/start')[0]).toEqual({ cwd: dir, approvalPolicy: 'never', sandbox: 'danger-full-access', model: 'gpt-fake-luna' });
      expect(r.adapter.effectiveSettings()).toEqual({ approvalMode: 'never', sandbox: 'danger-full-access' });
      const d = rig();
      await d.adapter.start(cwd(), {});
      expect(d.adapter.effectiveSettings()).toEqual({ approvalMode: 'on-request', sandbox: 'workspace-write' });
    });

    it('a command under never runs without an approval request', async () => {
      const r = rig({ turns: [[{ command: { command: 'touch /tmp/outside', output: 'ok\n' } }, { reply: 'Done.' }]] });
      await r.adapter.start(cwd(), { approvalMode: 'never' });
      await r.adapter.turnStart(text('go'), 'cm');
      await r.next('turn/completed');
      expect(methods(r.events)).not.toContain('approval/request');
      expect(r.events.find((e) => e.method === 'item/completed' && e.params.item.type === 'command')).toMatchObject({
        params: { item: { command: 'touch /tmp/outside', status: 'completed' } },
      });
    });

    it('thread/resume carries the same policy', async () => {
      const fake = fakeCodex();
      const first = rig({}, { fake });
      const dir = cwd();
      const threadId = await first.adapter.start(dir, { approvalMode: 'never' });
      await first.adapter.kill();
      const second = rig({}, { fake });
      await second.adapter.resume(threadId, dir, { approvalMode: 'never' });
      expect(fake.sent('thread/resume')[0]).toMatchObject({ threadId, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    });
  });

  describe('effort (settings.effort)', () => {
    it('reaches thread/start as config and every turn/start as effort; the thread reply is reported', async () => {
      const r = rig({ turns: [[{ reply: 'one' }], [{ reply: 'two' }]] });
      await r.adapter.start(cwd(), { effort: 'low' });
      expect(r.fake.sent('thread/start')[0]).toMatchObject({ config: { model_reasoning_effort: 'low' } });
      expect(r.adapter.effectiveSettings()).toEqual({ approvalMode: 'on-request', sandbox: 'workspace-write', effort: 'low' });
      await r.adapter.turnStart(text('a'), 'cm-1');
      await r.next('turn/completed');
      await r.adapter.turnStart(text('b'), 'cm-2');
      await until(() => r.events.filter((e) => e.method === 'turn/completed').length === 2 || undefined, 'second turn');
      expect(r.fake.sent('turn/start').map((p) => p.effort)).toEqual(['low', 'low']);
    });

    it('is left out when unset; the engine default the thread reports is in effect', async () => {
      const r = rig({ threadEffort: 'high', turns: [[{ reply: 'ok' }]] });
      const dir = cwd();
      await r.adapter.start(dir, {});
      expect(r.fake.sent('thread/start')[0]).toEqual({ cwd: dir, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'gpt-fake-luna' });
      expect(r.adapter.effectiveSettings()).toMatchObject({ effort: 'high' });
      await r.adapter.turnStart(text('a'), 'cm-1');
      await r.next('turn/completed');
      expect(r.fake.sent('turn/start')[0]).not.toHaveProperty('effort');
      const none = rig();
      await none.adapter.start(cwd(), {});
      expect(none.adapter.effectiveSettings()).not.toHaveProperty('effort');
    });

    it('thread/resume carries it again and reports the resumed thread level', async () => {
      const fake = fakeCodex();
      const first = rig({}, { fake });
      const dir = cwd();
      const threadId = await first.adapter.start(dir, { effort: 'max' });
      await first.adapter.kill();
      const second = rig({}, { fake });
      await second.adapter.resume(threadId, dir, { effort: 'max' });
      expect(fake.sent('thread/resume')[0]).toMatchObject({ threadId, config: { model_reasoning_effort: 'max' } });
      expect(second.adapter.effectiveSettings()).toMatchObject({ effort: 'max' });
    });
  });

  it('a turn: turn/start with clientUserMessageId, items and deltas, usage, completed; user items skipped', async () => {
    const r = rig({ turns: [[{ reasoning: 'thinking' }, { run: { command: 'ls', output: 'a\n' } }, { reply: 'Hello there', chunks: 2 }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart([...text('hi'), { type: 'image', url: 'data:x' }, { type: 'mention', name: 'f', path: '/f' }], 'cm-1');
    await r.next('turn/completed');
    expect(r.fake.sent('turn/start')[0]).toMatchObject({
      input: [
        { type: 'text', text: 'hi', text_elements: [] },
        { type: 'image', url: 'data:x' },
        { type: 'mention', name: 'f', path: '/f' },
      ],
      clientUserMessageId: 'cm-1',
    });
    expect(methods(r.events)).toEqual([
      'status/changed', // active -> running
      'item/started', // reasoning
      'item/delta',
      'item/completed',
      'item/started', // command
      'item/delta',
      'item/completed',
      'item/started', // agentMessage
      'item/delta',
      'item/delta',
      'item/completed',
      'usage/updated',
      'turn/completed',
      'status/changed', // idle after the turn
    ]);
    expect(r.events[0]).toEqual({ method: 'status/changed', params: { status: 'running' } });
    expect(r.events[2]).toMatchObject({ params: { field: 'summary', delta: 'thinking' } });
    expect(r.events[3]).toMatchObject({ params: { item: { type: 'reasoning', summary: 'thinking', status: 'completed' } } });
    expect(r.events[5]).toMatchObject({ params: { field: 'output', delta: 'a\n' } });
    expect(r.events[6]).toMatchObject({
      params: { item: { type: 'command', command: 'ls', output: 'a\n', exitCode: 0, durationMs: 5, status: 'completed' } },
    });
    expect(r.events[10]).toMatchObject({ params: { item: { type: 'agentMessage', text: 'Hello there' } } });
    expect(r.events[11]).toEqual({
      method: 'usage/updated',
      params: { usage: { inputTokens: 1200, outputTokens: 80, contextPercent: 1 } },
    });
    expect(r.events[12]).toEqual({ method: 'turn/completed', params: { status: 'completed' } });
    expect(r.events[13]).toEqual({ method: 'status/changed', params: { status: 'idle' } });
  });

  it('command approval: engine decisions forwarded without object-valued ones; accept answers the engine', async () => {
    const r = rig({ turns: [[{ command: { output: 'done\n' } }, { reply: 'ok' }]] });
    const dir = cwd();
    await r.adapter.start(dir, {});
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    expect(params.request).toMatchObject({
      requestId: expect.stringMatching(/^req_/),
      kind: 'command',
      command: '/bin/zsh -lc "echo hello > hello.txt"',
      cwd: dir,
      reason: 'May I create hello.txt in the current directory?',
      availableDecisions: ['accept', 'cancel'],
      expiresAt: null,
    });
    expect(r.events).toContainEqual({ method: 'status/changed', params: { status: 'waiting_approval' } });
    await r.adapter.resolveApproval(params.request.requestId, 'accept');
    await r.next('turn/completed');
    expect(r.fake.replies()).toContainEqual({ id: 0, result: { decision: 'accept' } });
    expect(r.events.find((e) => e.method === 'item/completed' && e.params.item.type === 'command')).toMatchObject({
      params: { item: { status: 'completed', output: 'done\n' } },
    });
    // Resolving twice, or an unknown request, does nothing.
    await r.adapter.resolveApproval(params.request.requestId, 'accept');
    await r.adapter.answerInput('req_unknown', {});
    expect(r.fake.replies()).toHaveLength(1);
  });

  it('usage mid-turn: each engine notification is forwarded at once, around an approval (field check)', async () => {
    // Turn 2 of the field check: the previous request's numbers stand while the approval waits; the
    // engine reports the approved request's usage after its command, then the reply's, then the turn ends.
    const [, previous, approved, reply] = FIELD_CHECK_USAGE.map(({ method, params }) => {
      const { threadId: _drop, ...rest } = params;
      return { notify: { method, params: rest } };
    });
    const r = rig({ turns: [[previous!, { command: { output: '' } }, approved!, { reply: 'Created' }, reply!]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    const usages = () => r.events.flatMap((e) => (e.method === 'usage/updated' ? [e.params.usage] : []));
    expect(usages()).toEqual([FIELD_CHECK_MAPPED[1]]);
    await r.adapter.resolveApproval(params.request.requestId, 'accept');
    await r.next('turn/completed');
    // The fake engine adds its own usage at turn end; the field check ones came before, in order.
    expect(usages().slice(0, 3)).toEqual([FIELD_CHECK_MAPPED[1], FIELD_CHECK_MAPPED[2], FIELD_CHECK_MAPPED[3]]);
    const order = methods(r.events);
    expect(order.indexOf('usage/updated')).toBeLessThan(order.indexOf('approval/request'));
    expect(order.lastIndexOf('usage/updated')).toBeLessThan(order.indexOf('turn/completed'));
  });

  it('command approval without the engine list offers all four; decline lets the turn continue', async () => {
    const r = rig({ turns: [[{ command: { availableDecisions: null, command: 'rm x' } }, { reply: 'skipped' }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    expect(params.request.availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    await r.adapter.resolveApproval(params.request.requestId, 'decline');
    await r.next('turn/completed');
    expect(r.events.find((e) => e.method === 'item/completed' && e.params.item.type === 'command')).toMatchObject({
      params: { item: { status: 'declined' } },
    });
  });

  it('file-change approval carries the changes of its item; cancel interrupts the turn', async () => {
    const r = rig({
      turns: [[{ fileChange: { path: '/w/hello.txt', diff: '+hello', grantRoot: '/w', reason: 'write it' } }, { reply: 'never' }]],
    });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    expect(params.request).toMatchObject({
      kind: 'fileChange',
      changes: [{ path: '/w/hello.txt', kind: 'add', diff: '+hello' }],
      grantRoot: '/w',
      reason: 'write it',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    });
    await r.adapter.resolveApproval(params.request.requestId, 'cancel');
    expect((await r.next('turn/completed')).params).toEqual({ status: 'interrupted' });
    expect(r.fake.replies()).toContainEqual({ id: 0, result: { decision: 'cancel' } });
  });

  it('file-change accept streams the patch output', async () => {
    const r = rig({ turns: [[{ fileChange: { path: 'a.txt', diff: '-a\n+b', kind: 'update' } }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    expect(params.request).toMatchObject({ changes: [{ kind: 'modify' }], reason: '' });
    expect(params.request).not.toHaveProperty('grantRoot');
    await r.adapter.resolveApproval(params.request.requestId, 'acceptForSession');
    await r.next('turn/completed');
    expect(r.events).toContainEqual({ method: 'item/delta', params: expect.objectContaining({ field: 'patch' }) });
    expect(r.fake.replies()).toContainEqual({ id: 0, result: { decision: 'acceptForSession' } });
  });

  it('permission approval: accept grants for the turn, acceptForSession for the session, decline grants nothing', async () => {
    const r = rig({ turns: [[{ permissions: {} }, { permissions: {} }, { permissions: { permissions: { fileSystem: {} } } }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const first = await r.next('approval/request');
    expect(first.params.request).toMatchObject({
      kind: 'permission',
      permissions: { network: { enabled: true } },
      scope: 'turn',
      reason: 'Needs network access',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    });
    await r.adapter.resolveApproval(first.params.request.requestId, 'accept');
    const second = await r.next('approval/request', (e) => e.params.request.requestId !== first.params.request.requestId);
    await r.adapter.resolveApproval(second.params.request.requestId, 'acceptForSession');
    const third = await r.next(
      'approval/request',
      (e) => ![first, second].some((x) => x.params.request.requestId === e.params.request.requestId),
    );
    await r.adapter.resolveApproval(third.params.request.requestId, 'decline');
    await r.next('turn/completed');
    expect(r.fake.replies().map((m) => m.result)).toEqual([
      { permissions: { network: { enabled: true } }, scope: 'turn' },
      { permissions: { network: { enabled: true } }, scope: 'session' },
      { permissions: {}, scope: 'turn' },
    ]);
    const texts = r.events.flatMap((e) => (e.method === 'item/completed' && e.params.item.type === 'agentMessage' ? [e.params.item.text] : []));
    expect(texts).toEqual(['granted for the turn', 'granted for the session', 'not granted']);
  });

  it('permission cancel declines and interrupts the turn', async () => {
    const r = rig({ turns: [[{ permissions: {} }, { hold: true }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    await r.adapter.resolveApproval(params.request.requestId, 'cancel');
    expect((await r.next('turn/completed')).params.status).toBe('interrupted');
    expect(r.fake.replies()[0]?.result).toEqual({ permissions: {}, scope: 'turn' });
    expect(r.fake.sent('turn/interrupt')).toHaveLength(1);
  });

  it('user input: item/tool/requestUserInput becomes input/request; answers map back by question id', async () => {
    const questions = [
      { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'blue', description: 'cool' }], isOther: true },
      { id: 'token', header: 'Token', question: 'Your token?', isSecret: true },
    ];
    const r = rig({ turns: [[{ input: { questions, isBlocking: false } }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('ask me'), 'cm');
    const { params } = await r.next('input/request');
    expect(params.request).toMatchObject({
      requestId: expect.stringMatching(/^req_/),
      kind: 'input',
      isBlocking: false,
      questions: [
        { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'blue', description: 'cool' }], isOther: true, isSecret: false },
        { id: 'token', header: 'Token', question: 'Your token?', isOther: false, isSecret: true },
      ],
    });
    expect(r.events).toContainEqual({ method: 'status/changed', params: { status: 'waiting_input' } });
    // An approval decision for an input request is ignored.
    await r.adapter.resolveApproval(params.request.requestId, 'accept');
    expect(r.fake.replies()).toEqual([]);
    const fresh = rig({ turns: [[{ input: { questions } }]] });
    await fresh.adapter.start(cwd(), {});
    await fresh.adapter.turnStart(text('ask me'), 'cm');
    const asked = await fresh.next('input/request');
    expect(asked.params.request.isBlocking).toBe(true);
    await fresh.adapter.answerInput(asked.params.request.requestId, { color: ['blue'], token: ['s3cret'] });
    await fresh.next('turn/completed');
    expect(fresh.fake.replies()[0]?.result).toEqual({ answers: { color: { answers: ['blue'] }, token: { answers: ['s3cret'] } } });
  });

  it('an approval the engine withdraws on its own becomes request/withdrawn', async () => {
    const r = rig({ turns: [[{ withdrawn: true }, { reply: 'moved on' }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    expect(params.request).toMatchObject({ command: 'sleep 1', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
    expect((await r.next('request/withdrawn')).params).toEqual({ requestId: params.request.requestId });
    await r.next('turn/completed');
    // serverRequest/resolved after the host's own reply is not a withdrawal.
    expect(r.events.filter((e) => e.method === 'request/withdrawn')).toHaveLength(1);
  });

  it('attachments (spec 8.1): a stored image is a localImage, a file a text line, also when steering', async () => {
    const files = attachmentFixture();
    const r = rig({ turns: [[{ hold: true }, { reply: 'seen' }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(files.input, 'cm-1');
    expect(r.fake.sent('turn/start')[0]!.input).toEqual([
      { type: 'text', text: 'What is wrong here?', text_elements: [] },
      { type: 'localImage', path: files.pngPath },
      { type: 'localImage', path: files.heicPath },
      { type: 'text', text: `Attached file: ${files.logPath}`, text_elements: [] },
    ]);
    await r.adapter.steer([files.input[3]!], 'cm-2');
    expect(r.fake.sent('turn/steer')[0]!.input).toEqual([{ type: 'text', text: `Attached file: ${files.logPath}`, text_elements: [] }]);
    await r.next('turn/completed');
  });

  it('steer: turn/steer with expectedTurnId and clientUserMessageId', async () => {
    const r = rig({ turns: [[{ hold: true }, { reply: 'steered' }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('long'), 'cm-1');
    await r.adapter.steer(text('also this'), 'cm-2');
    await r.next('turn/completed');
    expect(r.fake.sent('turn/interrupt')).toEqual([]);
    const steer = r.fake.sent('turn/steer')[0]!;
    expect(steer).toMatchObject({ input: [{ type: 'text', text: 'also this' }], clientUserMessageId: 'cm-2' });
    expect(steer.expectedTurnId).toEqual(expect.any(String));
    // No turn running: steer is a mismatch, interrupt a no-op.
    await expect(r.adapter.steer(text('late'), 'cm-3')).rejects.toMatchObject({ code: 'turn_mismatch' });
    await r.adapter.interrupt();
    expect(r.fake.sent('turn/interrupt')).toEqual([]);
  });

  it('interrupt: turn/interrupt with the engine turn id; the turn ends interrupted', async () => {
    const r = rig({ turns: [[{ command: {} }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    await r.next('approval/request');
    await r.adapter.interrupt();
    expect((await r.next('turn/completed')).params).toEqual({ status: 'interrupted' });
    expect(r.events).toContainEqual(expect.objectContaining({ method: 'request/withdrawn' }));
    const interrupt = r.fake.sent('turn/interrupt')[0]!;
    expect(interrupt).toEqual({ threadId: r.adapter.engineSessionId, turnId: expect.any(String) });
  });

  it('a failed turn carries the engine error', async () => {
    const r = rig({ turns: [[{ fail: 'model not supported', info: { httpConnectionFailed: {} } }], [{ fail: 'plain', info: 'usageLimitExceeded' }], [{ fail: 'none' }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('one'), 'a');
    expect((await r.next('turn/completed')).params).toEqual({
      status: 'failed',
      error: { code: 'httpConnectionFailed', message: 'model not supported', details: 'from the fake' },
    });
    r.events.length = 0;
    await r.adapter.turnStart(text('two'), 'b');
    expect((await r.next('turn/completed')).params.error).toMatchObject({ code: 'usageLimitExceeded' });
    r.events.length = 0;
    await r.adapter.turnStart(text('three'), 'c');
    expect((await r.next('turn/completed')).params.error).toMatchObject({ code: 'agent_error', message: 'none' });
  });

  it('ignores other threads, unknown notifications, and answers unknown server requests with an error', async () => {
    const r = rig({
      noise: true,
      turns: [
        [
          { notify: { method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'x', delta: 'no' } } },
          { notify: { method: 'account/rateLimits/updated', params: {} } },
          { notify: { method: 'thread/status/changed', params: { status: { type: 'notLoaded' } } } },
          { notify: { method: 'thread/status/changed', params: { status: { type: 'idle' } } } },
          { notify: { method: 'item/started', params: { item: { type: 'contextCompaction', id: 'cc' } } } },
          { request: { method: 'item/tool/call', params: {} } },
          { request: { method: 'item/commandExecution/requestApproval', params: { threadId: 'other' } } },
          { reply: 'fine' },
        ],
      ],
    });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    await r.next('turn/completed');
    expect(r.events.filter((e) => e.method === 'item/delta').map((e) => e.params.delta)).toEqual(['fine']);
    expect(r.events).toContainEqual({
      method: 'item/started',
      params: { item: { itemId: 'cc', type: 'other', status: 'inProgress', raw: { type: 'contextCompaction', id: 'cc' } } },
    });
    // The engine's idle inside a running turn is held back: exactly one idle, after turn/completed.
    const statuses = r.events.flatMap((e) => (e.method === 'status/changed' ? [e.params.status] : []));
    expect(statuses).toEqual(['running', 'idle']);
    await until(() => (r.fake.replies().length === 2 ? true : undefined), 'two error replies');
    const errors = r.fake.replies().map((m) => (m.error as { code: number }).code);
    expect(errors).toEqual([-32601, -32602]);
  });

  it('turn/start failures reject and leave no turn running', async () => {
    const r = rig({ fail: { 'turn/start': 'quota exceeded' } });
    await r.adapter.start(cwd(), {});
    await expect(r.adapter.turnStart(text('go'), 'cm')).rejects.toThrow(/quota exceeded/);
    await r.adapter.interrupt();
    expect(r.fake.sent('turn/interrupt')).toEqual([]);
  });

  it('resume after a host restart: thread/resume with the newest turns page', async () => {
    const fake = fakeCodex();
    const first = rig({}, { fake });
    const dir = cwd();
    const threadId = await first.adapter.start(dir, { model: 'gpt-fake-astra' });
    await first.adapter.turnStart(text('one'), 'a');
    await first.next('turn/completed');
    await first.adapter.kill();

    const second = rig({}, { fake });
    await second.adapter.resume(threadId, dir, { model: 'gpt-fake-astra', sandbox: 'read-only' });
    expect(fake.sent('thread/resume')[0]).toEqual({
      threadId,
      cwd: dir,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      model: 'gpt-fake-astra',
      initialTurnsPage: { limit: RESUME_TURNS, itemsView: 'full' },
    });
    await second.adapter.turnStart(text('two'), 'b');
    expect((await second.next('item/completed')).params.item).toMatchObject({ text: 'You said: two' });
    expect(fake.pids()).toHaveLength(2);
  });

  it('a call made while the engine boots waits for the handshake and thread/resume', async () => {
    const fake = fakeCodex();
    const first = rig({}, { fake });
    const dir = cwd();
    const threadId = await first.adapter.start(dir, {});
    await first.adapter.kill();
    const second = rig({}, { fake });
    const resumed = second.adapter.resume(threadId, dir, {});
    await second.adapter.turnStart(text('early'), 'cm');
    await resumed;
    const methods = fake.log().filter((e) => e.pid === fake.pids()[1]).map((e) => e.message.method);
    expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('turn/start'));
    await second.next('turn/completed');
  });

  it('resume of an unknown thread rejects with agent_unavailable', async () => {
    const r = rig();
    await expect(r.adapter.resume('nope', cwd(), {})).rejects.toMatchObject({
      code: 'agent_unavailable',
      message: expect.stringContaining('no thread nope'),
    });
    expect(r.adapter.pid).toBeUndefined();
  });

  it('engine crash mid-turn: status/changed error, agent/exited, then the next call restarts and resumes', async () => {
    const r = rig({ turns: [[{ command: {} }, { crash: 9 }], [{ reply: 'back' }]] });
    await r.adapter.start(cwd(), {});
    const firstPid = r.adapter.pid;
    await r.adapter.turnStart(text('go'), 'cm');
    const { params } = await r.next('approval/request');
    await r.adapter.resolveApproval(params.request.requestId, 'accept');
    const exited = await r.next('agent/exited');
    expect(exited.params.reason).toMatch(/code 9|closed its stdout/);
    const errorAt = r.events.findIndex((e) => e.method === 'status/changed' && e.params.status === 'error');
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeLessThan(r.events.indexOf(exited));
    expect(r.adapter.pid).toBeUndefined();
    // Requests of the dead engine are gone.
    await r.adapter.resolveApproval(params.request.requestId, 'accept');
    await r.adapter.interrupt();

    await r.adapter.turnStart(text('again'), 'cm2');
    expect((await r.next('item/completed', (e) => e.params.item.type === 'agentMessage')).params.item).toMatchObject({ text: 'back' });
    expect(r.adapter.pid).not.toBe(firstPid);
    expect(r.fake.sent('thread/resume')).toHaveLength(1);
  });

  it('stdout closed by the engine counts as a crash', async () => {
    const r = rig({ turns: [[{ closeStdout: true }]] });
    await r.adapter.start(cwd(), {});
    const pid = r.adapter.pid!;
    await r.adapter.turnStart(text('go'), 'cm');
    expect((await r.next('agent/exited')).params.reason).toBe('engine closed its stdout');
    // The lingering process is killed with its group.
    await until(() => (alive(pid) ? undefined : true), 'engine gone');
  });

  it('calls in flight reject with agent_unavailable when the engine dies', async () => {
    const r = rig({ exitOn: 'turn/start' });
    await r.adapter.start(cwd(), {});
    await expect(r.adapter.turnStart(text('go'), 'cm')).rejects.toMatchObject({ code: 'agent_unavailable' });
    await r.next('agent/exited');
  });

  it('a call before any thread is attached is agent_unavailable', async () => {
    const r = rig();
    await expect(r.adapter.turnStart(text('go'), 'cm')).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it('a missing binary or a failing initialize rejects start', async () => {
    const missing = new CodexAdapter({ config: { ...fakeCodex().config, binary: '/nonexistent/codex' } });
    adapters.push(missing);
    await expect(missing.start(cwd(), {})).rejects.toMatchObject({ code: 'agent_unavailable', message: expect.stringContaining('cannot run') });
    const failing = rig({ fail: { initialize: 'not logged in' } });
    await expect(failing.adapter.start(cwd(), {})).rejects.toMatchObject({ code: 'agent_unavailable', message: expect.stringContaining('not logged in') });
    const noThread = rig({ fail: { 'thread/start': 'nope' } });
    await expect(noThread.adapter.start(cwd(), {})).rejects.toThrow(/nope/);
  });

  it('kill ends the process group and silences the adapter; later calls are unavailable', async () => {
    const r = rig({ turns: [[{ hold: true }]] });
    await r.adapter.start(cwd(), {});
    const pid = r.adapter.pid!;
    await r.adapter.turnStart(text('go'), 'cm');
    const before = r.events.length;
    await r.adapter.kill();
    expect(alive(pid)).toBe(false);
    expect(r.events.length).toBe(before);
    await expect(r.adapter.turnStart(text('x'), 'y')).rejects.toMatchObject({ code: 'agent_unavailable' });
    await expect(r.adapter.start(cwd(), {})).rejects.toMatchObject({ code: 'agent_unavailable' });
    await r.adapter.kill();
  });
  it('defaults to the host configuration', () => {
    const adapter = new CodexAdapter();
    expect(adapter.pid).toBeUndefined();
  });

  it('thread/start without a thread id is agent_unavailable', async () => {
    const r = rig({ results: { 'thread/start': { thread: {} } } });
    await expect(r.adapter.start(cwd(), {})).rejects.toMatchObject({ code: 'agent_unavailable', message: expect.stringContaining('no thread id') });
  });

  it('a turn/start answer without a turn id leaves nothing to steer or interrupt', async () => {
    const r = rig({ results: { 'turn/start': {} }, turns: [[{ hold: true }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    await expect(r.adapter.steer(text('more'), 'cm2')).rejects.toMatchObject({ code: 'turn_mismatch' });
    await r.adapter.interrupt();
    expect(r.fake.sent('turn/interrupt')).toEqual([]);
  });

  it('steer and interrupt wait for a pending turn/start; when it fails they have nothing to act on', async () => {
    const r = rig({ ignore: ['turn/start'] });
    await r.adapter.start(cwd(), {});
    // The test is about ordering, not timing: the engine boots under the generous test timeout (a busy
    // machine can take seconds to spawn it), and only the ignored turn/start gets a short one. The engine
    // reads the timeout per call from this shared config object.
    r.fake.config.requestTimeoutMs = 300;
    const turn = r.adapter.turnStart(text('go'), 'cm');
    const steer = r.adapter.steer(text('more'), 'cm2');
    const interrupt = r.adapter.interrupt();
    await expect(turn).rejects.toMatchObject({ code: 'agent_unavailable' });
    await expect(steer).rejects.toMatchObject({ code: 'turn_mismatch' });
    await interrupt;
    expect(r.fake.sent('turn/interrupt')).toEqual([]);
  });

  it('interrupt after kill with a turn running is agent_unavailable', async () => {
    const r = rig({ turns: [[{ hold: true }]] });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    await r.adapter.kill();
    await expect(r.adapter.interrupt()).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it('events outside the running turn are dropped; a turn/completed of another turn is ignored', async () => {
    const r = rig({
      turns: [
        [
          { notify: { method: 'turn/completed', params: { turn: { id: 'another-turn', status: 'failed' } } } },
          { reply: 'still running' },
          { notify: { method: 'turn/completed', params: { turn: { status: 'completed' } } } },
          { notify: { method: 'item/started', params: { item: { type: 'agentMessage', id: 'late', text: '' } } } },
          { notify: { method: 'item/agentMessage/delta', params: { itemId: 'late', delta: 'late' } } },
          { notify: { method: 'thread/status/changed', params: { status: { type: 'active', activeFlags: [] } } } },
        ],
      ],
    });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    await until(() => (r.events.filter((e) => e.method === 'status/changed').length >= 2 ? true : undefined), 'idle');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.events.filter((e) => e.method === 'turn/completed')).toEqual([{ method: 'turn/completed', params: { status: 'completed' } }]);
    expect(r.events.some((e) => e.method === 'item/started' && e.params.item.itemId === 'late')).toBe(false);
    expect(r.events.some((e) => e.method === 'item/delta' && e.params.delta === 'late')).toBe(false);
    expect(r.events.filter((e) => e.method === 'status/changed').map((e) => e.params.status)).toEqual(['running', 'idle']);
  });

  it('a turn/completed of another turn in the same chunk as the turn/start reply is ignored', async () => {
    // The reply resolves turn/start, but the lines after it in the chunk are read before turnStart learns
    // the turn id: the adapter holds them until it does.
    const r = rig({
      oneChunkTurnStart: true,
      turns: [
        [
          { notify: { method: 'turn/completed', params: { turn: { id: 'another-turn', status: 'failed' } } } },
          { reply: 'still running' },
        ],
      ],
    });
    await r.adapter.start(cwd(), {});
    await r.adapter.turnStart(text('go'), 'cm');
    const done = await r.next('turn/completed');
    expect(done.params).toEqual({ status: 'completed' });
    expect(r.events.filter((e) => e.method === 'turn/completed')).toHaveLength(1);
    const texts = r.events.flatMap((e) => (e.method === 'item/completed' && e.params.item.type === 'agentMessage' ? [e.params.item.text] : []));
    expect(texts).toEqual(['still running']);
    expect(r.events.filter((e) => e.method === 'status/changed').map((e) => e.params.status)).toEqual(['running', 'idle']);
  });

  it('several pending requests: the engine withdraws one, the others stay answerable', async () => {
    const r = rig({
      turns: [
        [
          { request: { method: 'item/commandExecution/requestApproval', params: { itemId: 'nowhere' } } },
          { request: { method: 'item/permissions/requestApproval', params: {} } },
          { request: { method: 'item/tool/requestUserInput', params: { questions: [null] } } },
          { request: { method: 'item/tool/requestUserInput', params: {} } },
          { withdrawn: true },
          { command: { bare: true, command: 'make', cwd: '/from/item' } },
        ],
      ],
    });
    const dir = cwd();
    await r.adapter.start(dir, {});
    await r.adapter.turnStart(text('go'), 'cm');
    await r.next('request/withdrawn');
    const approvals = r.events.flatMap((e) => (e.method === 'approval/request' ? [e.params.request] : []));
    expect(approvals[0]).toMatchObject({ kind: 'command', command: '', cwd: dir });
    expect(approvals[1]).toMatchObject({ kind: 'permission', permissions: {} });
    const inputs = r.events.flatMap((e) => (e.method === 'input/request' ? [e.params.request] : []));
    expect(inputs.map((i) => i.questions)).toEqual([[{ id: '', header: '', question: '', isOther: false, isSecret: false }], []]);
    const bare = await r.next('approval/request', (e) => e.params.request.kind === 'command' && e.params.request.command === 'make');
    expect(bare.params.request).toMatchObject({ cwd: '/from/item' });
    const withdrawn = r.events.find((e) => e.method === 'request/withdrawn')!;
    expect(approvals.map((a) => a.requestId)).toContain((withdrawn.params as { requestId: string }).requestId);
    await r.adapter.answerInput(inputs[1]!.requestId, {});
    await r.adapter.resolveApproval(approvals[0]!.requestId, 'accept');
    await until(() => (r.fake.replies().filter((m) => m.result !== undefined).length === 2 ? true : undefined), 'two replies');
  });

  it('an engine that dies during the boot rejects the call without agent/exited', async () => {
    const r = rig({ exitOn: 'initialize' });
    await expect(r.adapter.start(cwd(), {})).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(r.events).toEqual([]);
  });

});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
