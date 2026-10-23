// The pi adapter against the fake pi (scripted JSONL, Nano's real approval extension loaded with -e): the
// section 11 mapping, call by call.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AdapterEvent } from '../../core/adapter.js';
import { NANO_APPROVAL_EXTENSION } from '../../config/pi.js';
import { RpcError } from '../../stream/router.js';
import { PiAdapter } from './adapter.js';
import { fakePi, until, type FakePi } from './testing/fake-pi-config.js';
import type { FakePiFixture } from './testing/fixture.js';

const adapters: PiAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.kill()));
});

const text = (value: string) => [{ type: 'text' as const, text: value }];
type Of<M extends AdapterEvent['method']> = Extract<AdapterEvent, { method: M }>;

interface Rig {
  fake: FakePi;
  adapter: PiAdapter;
  events: AdapterEvent[];
  logs: string[];
  next<M extends AdapterEvent['method']>(method: M, match?: (e: Of<M>) => boolean): Promise<Of<M>>;
}

function rig(fixture: FakePiFixture = {}, fake = fakePi(fixture)): Rig {
  const logs: string[] = [];
  const adapter = new PiAdapter({ config: fake.config, log: (m) => logs.push(m) });
  adapters.push(adapter);
  const events: AdapterEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  return {
    fake,
    adapter,
    events,
    logs,
    next: <M extends AdapterEvent['method']>(method: M, match: (e: Of<M>) => boolean = () => true) =>
      until(() => events.find((e) => e.method === method && match(e as Of<M>)) as Of<M> | undefined, `adapter event ${method}`),
  };
}

const methods = (events: AdapterEvent[]) => events.map((e) => e.method);
const completedItems = (events: AdapterEvent[]) => events.flatMap((e) => (e.method === 'item/completed' ? [e.params.item] : []));

/** Starts a session and runs one turn to its end. */
async function turn(r: Rig, prompt: string): Promise<Of<'turn/completed'>> {
  const before = r.events.length;
  await r.adapter.turnStart(text(prompt), 'cm-1');
  return until(() => r.events.slice(before).find((e) => e.method === 'turn/completed') as Of<'turn/completed'> | undefined, 'turn/completed');
}

describe('PiAdapter start and resume', () => {
  it('session/start: pi --mode rpc --no-extensions -e <Nano extension> --session-id <new id> in the session folder', async () => {
    const r = rig();
    const id = await r.adapter.start(r.fake.cwd, {});
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.adapter.engineSessionId).toBe(id);
    expect(r.adapter.pid).toBeGreaterThan(0);
    expect(r.fake.argvs()).toEqual([['--mode', 'rpc', '--no-extensions', '-e', NANO_APPROVAL_EXTENSION, '--session-id', id]]);
    expect(r.fake.log()[0]!.cwd).toBe(realpathSync(r.fake.cwd));
    // No set_model without settings.model: pi's own default model, reported back as provider/id.
    expect(r.fake.log().flatMap((e) => (e.record ? [e.record.type] : []))).toEqual(['get_state']);
    expect(r.adapter.effectiveSettings()).toEqual({ model: 'llamacpp/bonsai-27b' });
    expect(r.adapter.capabilities).toEqual({ steer: true, diff: false });
  });

  it('settings.model provider/id selects the model with set_model (the id may hold slashes)', async () => {
    const r = rig();
    await r.adapter.start(r.fake.cwd, { model: 'openrouter/~deepseek/deepseek-v4-flash-latest' });
    expect(r.fake.sent('set_model')).toEqual([
      { id: 'nano-1', type: 'set_model', provider: 'openrouter', modelId: '~deepseek/deepseek-v4-flash-latest' },
    ]);
    expect(r.adapter.effectiveSettings()).toEqual({ model: 'openrouter/~deepseek/deepseek-v4-flash-latest' });
  });

  it('an unknown or malformed model fails the start with agent_unavailable and stops pi', async () => {
    const r = rig();
    const unknown = await r.adapter.start(r.fake.cwd, { model: 'nowhere/nothing' }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(RpcError);
    expect((unknown as RpcError).code).toBe('agent_unavailable');
    expect((unknown as RpcError).message).toContain('set_model failed: Model not found: nowhere/nothing');
    expect(r.adapter.pid).toBeUndefined();
    const s = rig();
    await expect(s.adapter.start(s.fake.cwd, { model: 'bonsai' })).rejects.toThrow(/not of the form provider\/id/);
  });

  it('a pi that exits at startup rejects with its stderr line', async () => {
    const r = rig({ exitAtBoot: "No session found matching 'x'" });
    await expect(r.adapter.start(r.fake.cwd, {})).rejects.toThrow(/pi exited with code 1: No session found matching 'x'/);
  });

  it('resume: the stored session id, the same folder, and the session continues', async () => {
    const fake = fakePi({ turns: [[{ reply: 'first' }], [{ reply: 'second' }]] });
    const a = rig({}, fake);
    const id = await a.adapter.start(fake.cwd, {});
    await turn(a, 'one');
    await a.adapter.kill();
    const b = rig({}, fake);
    await b.adapter.resume(id, fake.cwd, { model: 'llamacpp/bonsai-27b' });
    expect(fake.argvs()[1]).toEqual(['--mode', 'rpc', '--no-extensions', '-e', NANO_APPROVAL_EXTENSION, '--session-id', id]);
    expect(fake.argvs().flat()).not.toContain('--no-session');
    expect(fake.sent('set_model').at(-1)).toMatchObject({ provider: 'llamacpp', modelId: 'bonsai-27b' });
    await turn(b, 'two');
    expect(completedItems(b.events)).toEqual([expect.objectContaining({ type: 'agentMessage', text: 'second' })]);
    // pi kept the first turn in its session (get_messages after the restart).
    const state = JSON.parse(readFileSync(path.join(fake.dir, 'state.json'), 'utf8')) as { sessions: Record<string, { messages: { role: string }[] }> };
    expect(state.sessions[id]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('PiAdapter turns', () => {
  it('turn/start streams text: item/started, item/delta text, item/completed, usage, turn/completed', async () => {
    const r = rig({ turns: [[{ reply: 'Hello there', chunks: 2 }]] });
    await r.adapter.start(r.fake.cwd, {});
    const done = await turn(r, 'hi');
    expect(r.fake.sent('prompt')).toEqual([{ id: 'nano-2', type: 'prompt', message: 'hi' }]);
    const itemId = (r.events[0] as Of<'item/started'>).params.item.itemId;
    expect(itemId).toMatch(/^itm_/);
    expect(r.events).toEqual([
      { method: 'item/started', params: { item: { itemId, status: 'inProgress', type: 'agentMessage', text: '' } } },
      { method: 'item/delta', params: { itemId, field: 'text', delta: 'Hello ' } },
      { method: 'item/delta', params: { itemId, field: 'text', delta: 'there' } },
      { method: 'item/completed', params: { item: { itemId, status: 'completed', type: 'agentMessage', text: 'Hello there' } } },
      { method: 'usage/updated', params: { usage: { inputTokens: 150, outputTokens: 10, contextPercent: 3.8 } } },
      { method: 'turn/completed', params: { status: 'completed' } },
    ]);
    expect(done.params).toEqual({ status: 'completed' });
  });

  it('thinking is a reasoning item streamed in field text', async () => {
    const r = rig({ turns: [[{ thinking: 'plan it' }, { reply: 'ok', chunks: 1 }]] });
    await r.adapter.start(r.fake.cwd, {});
    await turn(r, 'think');
    const [reasoning] = completedItems(r.events);
    expect(reasoning).toEqual({ itemId: expect.stringMatching(/^itm_/), status: 'completed', type: 'reasoning', summary: '', text: 'plan it' });
    expect(r.events).toContainEqual({ method: 'item/delta', params: { itemId: reasoning!.itemId, field: 'text', delta: 'plan it' } });
  });

  it('images in data URLs and mentions reach the prompt', async () => {
    const r = rig();
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(
      [
        { type: 'text', text: 'look' },
        { type: 'mention', name: 'a.ts', path: '/w/a.ts' },
        { type: 'image', url: 'data:image/png;base64,AAAA' },
        { type: 'image', url: '/v1/blob/b1' },
      ],
      'cm',
    );
    await r.next('turn/completed');
    expect(r.fake.sent('prompt')[0]).toEqual({
      id: 'nano-2',
      type: 'prompt',
      message: 'look\n/w/a.ts',
      images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    });
  });

  it('a failed assistant message fails the turn with its error', async () => {
    const r = rig({ turns: [[{ fail: '500 upstream down' }]] });
    await r.adapter.start(r.fake.cwd, {});
    const done = await turn(r, 'x');
    expect(done.params).toEqual({ status: 'failed', error: { code: 'agent_error', message: '500 upstream down' } });
  });

  it('a prompt pi handles itself ends the turn at once', async () => {
    const r = rig({ disposition: 'handled' });
    await r.adapter.start(r.fake.cwd, {});
    const done = await turn(r, '/command');
    expect(done.params).toEqual({ status: 'completed' });
    expect(methods(r.events)).toEqual(['usage/updated', 'turn/completed']);
  });

  it('a refused prompt rejects turnStart and leaves no turn running', async () => {
    const r = rig({ fail: { prompt: 'no model selected' } });
    await r.adapter.start(r.fake.cwd, {});
    await expect(r.adapter.turnStart(text('x'), 'cm')).rejects.toThrow(/prompt failed: no model selected/);
    await expect(r.adapter.steer(text('y'), 'cm2')).rejects.toMatchObject({ code: 'turn_mismatch' });
  });

  it('usage that pi cannot report does not hold up the end of the turn', async () => {
    const r = rig({ fail: { get_session_stats: 'stats broke' } });
    await r.adapter.start(r.fake.cwd, {});
    const done = await turn(r, 'x');
    expect(done.params.status).toBe('completed');
    expect(methods(r.events)).not.toContain('usage/updated');
    expect(r.logs.some((l) => l.includes('no session stats'))).toBe(true);
  });

  it('a tool that never ends fails with the turn; dialogs after the turn are refused; stray failures are logged', async () => {
    const r = rig({
      turns: [
        [
          { raw: { type: 'tool_execution_start', toolCallId: 'call_open', toolName: 'ls', args: {} } },
          { raw: { type: 'tool_execution_update', toolCallId: 'call_open', partialResult: {} } },
          { raw: { type: 'tool_execution_start', toolCallId: '', toolName: 'ls', args: {} } },
          { raw: { type: 'tool_execution_end', toolCallId: '', toolName: 'ls' } },
          { raw: { type: 'response', command: 'bash', success: false, error: 'no shell' } },
          { raw: { type: 'extension_ui_request', id: 'n1', method: 'setStatus', statusKey: 'k' } },
          { late: { type: 'extension_ui_request', id: 'late-1', method: 'confirm', title: 'nano-approval', message: '{"toolCallId":"c","toolName":"bash","input":{}}' } },
          { late: { type: 'extension_ui_request', id: 'late-2', method: 'select', title: 'Pick', options: ['a'] } },
          { late: { type: 'tool_execution_start', toolCallId: 'call_late', toolName: 'ls', args: {} } },
        ],
      ],
    });
    await r.adapter.start(r.fake.cwd, {});
    await turn(r, 'x');
    expect(completedItems(r.events)).toEqual([{ itemId: 'call_open', status: 'failed', type: 'toolCall', tool: 'ls', arguments: {} }]);
    expect(r.logs).toContain('pi: bash failed: no shell');
    await until(() => (r.fake.sent('extension_ui_response').length === 2 ? true : undefined), 'late answers');
    expect(r.fake.sent('extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'late-1', confirmed: false },
      { type: 'extension_ui_response', id: 'late-2', cancelled: true },
    ]);
    expect(methods(r.events)).toEqual(['item/started', 'item/completed', 'usage/updated', 'turn/completed']);
  });

  it('notifications and lines that are not JSON are dropped', async () => {
    const r = rig({ turns: [[{ notify: 'hello' }, { junk: true }, { raw: { type: 'queue_update', steering: [] } }, { reply: 'ok', chunks: 1 }]] });
    await r.adapter.start(r.fake.cwd, {});
    await turn(r, 'x');
    expect(methods(r.events)).toEqual(['item/started', 'item/delta', 'item/completed', 'usage/updated', 'turn/completed']);
    expect(r.logs).toContain('pi: unparsable line of 16 characters dropped');
  });
});

const bash = { tool: { name: 'bash', args: { command: 'echo hi' }, output: 'hi\nthere\n' } };

describe('PiAdapter approvals (Nano extension, ruling R3)', () => {

  it('bash asks as a command approval; accepted, the command runs and streams its output', async () => {
    const r = rig({ turns: [[bash, { reply: 'done', chunks: 1 }]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('run it'), 'cm');
    const approval = await r.next('approval/request');
    const started = r.events.find((e) => e.method === 'item/started') as Of<'item/started'>;
    const callId = started.params.item.itemId;
    expect(callId).toMatch(/^call_/);
    expect(started.params.item).toEqual({ itemId: callId, status: 'inProgress', type: 'command', command: 'echo hi', cwd: r.fake.cwd, output: '' });
    expect(approval.params.request).toEqual({
      requestId: expect.stringMatching(/^req_/),
      itemId: callId,
      kind: 'command',
      command: 'echo hi',
      cwd: r.fake.cwd,
      reason: 'pi wants to run a shell command',
      availableDecisions: ['accept', 'decline', 'cancel'],
      expiresAt: null,
    });
    await r.adapter.resolveApproval(approval.params.request.requestId, 'accept');
    await r.next('turn/completed');
    expect(r.events).toContainEqual({ method: 'item/delta', params: { itemId: callId, field: 'output', delta: 'hi\nth' } });
    expect(completedItems(r.events)[0]).toEqual({
      itemId: callId,
      status: 'completed',
      type: 'command',
      command: 'echo hi',
      cwd: r.fake.cwd,
      output: 'hi\nthere\n',
      exitCode: 0,
      durationMs: 5,
    });
    expect(r.fake.sent('extension_ui_response')).toEqual([{ type: 'extension_ui_response', id: expect.any(String), confirmed: true }]);
  });

  it('bash declined: the tool is blocked, the item is declined, the turn goes on', async () => {
    const r = rig({ turns: [[bash, { reply: 'blocked', chunks: 1 }]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('run it'), 'cm');
    const approval = await r.next('approval/request');
    await r.adapter.resolveApproval(approval.params.request.requestId, 'decline');
    const done = await r.next('turn/completed');
    expect(done.params.status).toBe('completed');
    const [command, reply] = completedItems(r.events);
    expect(command).toMatchObject({ type: 'command', status: 'declined', output: 'bash was not approved in Nano' });
    expect(reply).toMatchObject({ type: 'agentMessage', text: 'blocked' });
    expect(r.events.some((e) => e.method === 'item/delta' && e.params.field === 'output')).toBe(false);
    expect(r.fake.sent('extension_ui_response')).toEqual([{ type: 'extension_ui_response', id: expect.any(String), confirmed: false }]);
  });

  it('write asks as a fileChange approval; accepted the file exists, declined it does not', async () => {
    const write = { tool: { name: 'write', args: { path: 'hello.txt', content: 'hi\n' }, output: 'Successfully wrote to hello.txt' } };
    const r = rig({ turns: [[write], [write]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('write'), 'cm');
    const first = await r.next('approval/request');
    expect(first.params.request).toMatchObject({
      kind: 'fileChange',
      changes: [{ path: 'hello.txt', kind: 'add', diff: '+hi' }],
      reason: 'pi wants to write a file',
      availableDecisions: ['accept', 'decline', 'cancel'],
    });
    await r.adapter.resolveApproval(first.params.request.requestId, 'accept');
    await r.next('turn/completed');
    expect(readFileSync(path.join(r.fake.cwd, 'hello.txt'), 'utf8')).toBe('hi\n');
    expect(completedItems(r.events)[0]).toMatchObject({ type: 'fileChange', status: 'completed', changes: [{ path: 'hello.txt', kind: 'add', diff: '+hi' }] });

    // The second write overwrites: a modify. Declined, the file keeps its content.
    writeFileSync(path.join(r.fake.cwd, 'hello.txt'), 'old\n');
    r.events.length = 0;
    await r.adapter.turnStart(text('again'), 'cm2');
    const second = await r.next('approval/request');
    expect(second.params.request).toMatchObject({ kind: 'fileChange', changes: [{ path: 'hello.txt', kind: 'modify' }] });
    await r.adapter.resolveApproval(second.params.request.requestId, 'decline');
    await r.next('turn/completed');
    expect(readFileSync(path.join(r.fake.cwd, 'hello.txt'), 'utf8')).toBe('old\n');
    expect(completedItems(r.events)[0]).toMatchObject({ type: 'fileChange', status: 'declined' });
  });

  it('edit asks with the replacements and completes with pi patch', async () => {
    const edit = { tool: { name: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] }, patch: '@@ -1 +1 @@\n-a\n+b' } };
    const r = rig({ turns: [[edit]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('edit'), 'cm');
    const approval = await r.next('approval/request');
    expect(approval.params.request).toMatchObject({ kind: 'fileChange', changes: [{ path: 'a.txt', kind: 'modify', diff: '-a\n+b' }], reason: 'pi wants to edit a file' });
    await r.adapter.resolveApproval(approval.params.request.requestId, 'acceptForSession');
    await r.next('turn/completed');
    expect(completedItems(r.events)[0]).toEqual({
      itemId: expect.stringMatching(/^call_/),
      status: 'completed',
      type: 'fileChange',
      changes: [{ path: 'a.txt', kind: 'modify', diff: '@@ -1 +1 @@\n-a\n+b' }],
    });
  });

  it('read-only tools run unasked; other tools ask as a permission', async () => {
    const r = rig({
      turns: [
        [
          { tool: { name: 'read', args: { path: 'a.txt' }, output: 'content' } },
          { tool: { name: 'webfetch', args: { url: 'https://example.org' }, output: 'page', isError: true } },
        ],
      ],
    });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('go'), 'cm');
    const approval = await r.next('approval/request');
    expect(approval.params.request).toMatchObject({
      kind: 'permission',
      permissions: { tool: 'webfetch', arguments: { url: 'https://example.org' } },
      scope: 'turn',
      reason: 'pi wants to use the webfetch tool',
    });
    await r.adapter.resolveApproval(approval.params.request.requestId, 'accept');
    await r.next('turn/completed');
    const [read, fetch] = completedItems(r.events);
    expect(read).toEqual({ itemId: expect.any(String), status: 'completed', type: 'toolCall', tool: 'read', arguments: { path: 'a.txt' }, result: 'content' });
    expect(fetch).toMatchObject({ status: 'failed', type: 'toolCall', tool: 'webfetch', error: 'page' });
    expect(r.fake.sent('extension_ui_response')).toHaveLength(1);
  });

  it('cancel declines the call and interrupts the turn', async () => {
    const r = rig({ turns: [[bash, { reply: 'never', chunks: 1 }]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('run'), 'cm');
    const approval = await r.next('approval/request');
    await r.adapter.resolveApproval(approval.params.request.requestId, 'cancel');
    const done = await r.next('turn/completed');
    expect(done.params).toEqual({ status: 'interrupted' });
    expect(completedItems(r.events).map((i) => [i.type, i.status])).toEqual([['command', 'declined']]);
    // An answered request is gone: a second answer does nothing.
    await r.adapter.resolveApproval(approval.params.request.requestId, 'accept');
    expect(r.fake.sent('extension_ui_response')).toHaveLength(1);
  });
});

describe('PiAdapter interrupt and steer', () => {
  it('turn/interrupt: clear_queue, abort, turn/completed interrupted', async () => {
    const r = rig({ turns: [[{ hold: true }, { reply: 'never' }]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('wait'), 'cm');
    await until(() => (r.fake.sent('prompt').length > 0 ? true : undefined), 'prompt');
    await r.adapter.interrupt();
    const done = await r.next('turn/completed');
    expect(done.params).toEqual({ status: 'interrupted' });
    expect(r.fake.log().flatMap((e) => (e.record ? [e.record.type] : []))).toEqual([
      'get_state',
      'prompt',
      'clear_queue',
      'abort',
      'get_session_stats',
    ]);
    // Interrupting a finished turn is a no-op.
    await r.adapter.interrupt();
  });

  it('interrupt while an approval is open declines it first, so the abort is not stuck', async () => {
    const r = rig({ turns: [[bash]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('run'), 'cm');
    const approval = await r.next('approval/request');
    await r.adapter.interrupt();
    const done = await r.next('turn/completed');
    expect(done.params.status).toBe('interrupted');
    expect(completedItems(r.events)).toEqual([expect.objectContaining({ type: 'command', status: 'declined' })]);
    expect(r.fake.sent('extension_ui_response')).toEqual([{ type: 'extension_ui_response', id: expect.any(String), confirmed: false }]);
    await r.adapter.resolveApproval(approval.params.request.requestId, 'accept');
    expect(r.fake.sent('extension_ui_response')).toHaveLength(1);
  });

  it('turn/steer sends steer; the steered message is not reported as an item (the core journals it)', async () => {
    const r = rig({ turns: [[{ hold: true }, { reply: 'after', chunks: 1 }]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('start'), 'cm');
    await r.adapter.steer(text('also this'), 'cm2');
    await r.next('turn/completed');
    expect(r.fake.sent('steer')).toEqual([{ id: 'nano-3', type: 'steer', message: 'also this' }]);
    expect(completedItems(r.events).map((i) => (i.type === 'agentMessage' ? i.text : i.type))).toEqual(['You steered: also this', 'after']);
  });
});

describe('PiAdapter questions (other dialogs)', () => {
  it('select becomes an input/request with options; the answer is the picked label', async () => {
    const r = rig({ turns: [[{ dialog: { method: 'select', title: 'Pick one', options: ['A', 'B'] } }]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('ask'), 'cm');
    const question = await r.next('input/request');
    expect(question.params.request).toEqual({
      requestId: expect.stringMatching(/^req_/),
      kind: 'input',
      itemId: question.params.request.requestId,
      isBlocking: true,
      questions: [{ id: 'answer', header: 'Pick one', question: 'Pick one', isSecret: false, isOther: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
    });
    await r.adapter.answerInput(question.params.request.requestId, { answer: ['B'] });
    await r.next('turn/completed');
    expect(r.fake.sent('extension_ui_response')).toEqual([{ type: 'extension_ui_response', id: expect.any(String), value: 'B' }]);
  });

  it('input is free text; no answer cancels; a foreign confirm is Yes or No', async () => {
    const r = rig({
      turns: [
        [
          { dialog: { method: 'input', title: 'Name?' } },
          { dialog: { method: 'editor', title: 'Edit' } },
          { dialog: { method: 'confirm', title: 'Sure?', message: 'Really?' } },
        ],
      ],
    });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('ask'), 'cm');
    const first = await r.next('input/request');
    expect(first.params.request.questions).toEqual([{ id: 'answer', header: 'Name?', question: 'Name?', isSecret: false, isOther: true }]);
    await r.adapter.answerInput(first.params.request.requestId, { answer: ['Ada'] });
    const second = await r.next('input/request', (e) => e.params.request.requestId !== first.params.request.requestId);
    await r.adapter.answerInput(second.params.request.requestId, {});
    const third = await r.next('input/request', (e) => e.params.request.questions[0]!.header === 'Sure?');
    expect(third.params.request.questions[0]).toMatchObject({ question: 'Really?', options: [{ label: 'Yes' }, { label: 'No' }] });
    await r.adapter.answerInput(third.params.request.requestId, { answer: ['Yes'] });
    await r.next('turn/completed');
    expect(r.fake.sent('extension_ui_response').map(({ id: _id, ...rest }) => rest)).toEqual([
      { type: 'extension_ui_response', value: 'Ada' },
      { type: 'extension_ui_response', cancelled: true },
      { type: 'extension_ui_response', confirmed: true },
    ]);
    // An approval answer for a question does nothing.
    await r.adapter.answerInput('req_unknown', { answer: ['x'] });
  });

  it('a dialog with a timeout is withdrawn when pi answers it itself', async () => {
    const r = rig({ turns: [[{ dialog: { method: 'select', title: 'Quick', options: ['A'], timeout: 150 } }]] });
    await r.adapter.start(r.fake.cwd, {});
    await r.adapter.turnStart(text('ask'), 'cm');
    const question = await r.next('input/request');
    const withdrawn = await r.next('request/withdrawn');
    expect(withdrawn.params).toEqual({ requestId: question.params.request.requestId });
    await r.next('turn/completed');
    await r.adapter.answerInput(question.params.request.requestId, { answer: ['A'] });
    expect(r.fake.sent('extension_ui_response')).toEqual([]);
  });
});

describe('PiAdapter supervision', () => {
  it('pi dying mid-turn: status error and agent/exited; the next turn starts pi again on the same session', async () => {
    const r = rig({ turns: [[{ crash: 7 }], [{ reply: 'back', chunks: 1 }]] });
    const id = await r.adapter.start(r.fake.cwd, {});
    const firstPid = r.adapter.pid;
    await r.adapter.turnStart(text('crash'), 'cm');
    const exited = await r.next('agent/exited');
    expect(exited.params.reason).toBe('pi exited with code 7');
    expect(r.events).toContainEqual({ method: 'status/changed', params: { status: 'error' } });
    expect(r.adapter.pid).toBeUndefined();
    await expect(r.adapter.interrupt()).resolves.toBeUndefined();
    await turn(r, 'again');
    expect(r.adapter.pid).not.toBe(firstPid);
    expect(r.fake.argvs().map((a) => a.at(-1))).toEqual([id, id]);
  });

  it('after kill() the adapter is silent and refuses calls; diff is not supported', async () => {
    const r = rig();
    await r.adapter.start(r.fake.cwd, {});
    await expect(r.adapter.diff()).rejects.toMatchObject({ code: 'not_supported' });
    await r.adapter.kill();
    expect(existsSync(r.fake.cwd)).toBe(true);
    await expect(r.adapter.turnStart(text('x'), 'cm')).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(r.events).toEqual([]);
  });

  it('turnStart without a session is unavailable', async () => {
    const r = rig();
    await expect(r.adapter.turnStart(text('x'), 'cm')).rejects.toThrow(/no pi session is attached/);
  });
});
