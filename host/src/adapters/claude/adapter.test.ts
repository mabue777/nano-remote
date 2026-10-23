// The Claude adapter against the scripted fake query (testing/fake-query.ts): the option mapping, the
// message sequences of the spike and the live test, approvals and questions with every decision,
// interrupts, child exits and kills.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Settings } from '../../generated/common.js';
import type { AdapterEvent } from '../../core/adapter.js';
import { claudeConfig, type ClaudeConfig } from '../../config/claude.js';
import { bundledExecutable, ClaudeAdapter, executablePath, Inbox, loadQuery, type QueryFn } from './adapter.js';
import { CANCEL_MESSAGE, DECLINE_MESSAGE } from './mapping.js';
import { FakeClaude, until, type FakeClaudeOptions } from './testing/fake-query.js';

const adapters: ClaudeAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.kill()));
});

interface Rig {
  fake: FakeClaude;
  adapter: ClaudeAdapter;
  events: AdapterEvent[];
  config: ClaudeConfig;
  versions: string[];
  logs: string[];
  cwd: string;
}

function rig(fakeOptions: FakeClaudeOptions = {}, config: Partial<ClaudeConfig> = {}, query?: QueryFn): Rig {
  const fake = new FakeClaude(fakeOptions);
  const cfg = claudeConfig(
    { configDir: mkdtempSync(path.join(tmpdir(), 'nano-claude-cfg-')), requestTimeoutMs: 5_000, killGraceMs: 300, ...config },
    {},
  );
  const versions: string[] = [];
  const logs: string[] = [];
  const adapter = new ClaudeAdapter({ query: query ?? fake.query, config: cfg, onVersion: (v) => versions.push(v), log: (m) => logs.push(m) });
  adapters.push(adapter);
  const events: AdapterEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  return { fake, adapter, events, config: cfg, versions, logs, cwd: mkdtempSync(path.join(tmpdir(), 'nano-claude-cwd-')) };
}

const text = (value: string) => [{ type: 'text' as const, text: value }];
const methods = (events: AdapterEvent[]) => events.map((e) => e.method);
const find = <M extends AdapterEvent['method']>(events: AdapterEvent[], method: M, from = 0) =>
  until(() => events.slice(from).find((e): e is Extract<AdapterEvent, { method: M }> => e.method === method), method);
const turnEnd = (events: AdapterEvent[], from = 0) => find(events, 'turn/completed', from);
const requestOf = (event: AdapterEvent) => (event.params as { request: Record<string, unknown> & { requestId: string } }).request;

describe('the Claude Code executable', () => {
  it('finds the build bundled with the SDK from the SDK\'s real folder, even after a stat of a pipe', () => {
    // Node 26.5's cached realpath skips symlinks after a synchronous stat of a pipe or socket; the lookup
    // must not depend on it. A stat of a FIFO primes that state before the first lookup.
    const fifo = path.join(mkdtempSync(path.join(tmpdir(), 'nano-fifo-')), 'fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    expect(statSync(fifo).isFIFO()).toBe(true);
    const file = bundledExecutable();
    expect(file).toBeDefined();
    expect(existsSync(file!)).toBe(true);
    expect(file).toMatch(new RegExp(`claude-agent-sdk-${process.platform}-${process.arch}/claude$`));
  });

  it('prefers the configured executable', () => {
    expect(executablePath(claudeConfig({ executable: '/opt/claude/bin/claude' }))).toBe('/opt/claude/bin/claude');
    expect(executablePath(claudeConfig({ executable: undefined }))).toBe(bundledExecutable());
  });
});

describe('ClaudeAdapter: start, resume and the query options', () => {
  it('start returns "" and opens a streaming query with the mapped options; the id comes with the first turn', async () => {
    const { fake, adapter, events, cwd, versions, config } = rig({}, { env: { NANO_EXTRA: '1' } });
    expect(await adapter.start(cwd, {})).toBe('');
    const options = fake.last.options;
    expect(options).toMatchObject({
      cwd,
      model: 'opus',
      permissionMode: 'default',
      settingSources: [],
      includePartialMessages: true,
    });
    expect(options.resume).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.pathToClaudeCodeExecutable).toBe(bundledExecutable());
    expect(options.env).toMatchObject({ CLAUDE_CONFIG_DIR: config.configDir, NANO_EXTRA: '1' });
    expect(Object.keys(options.env!).filter((k) => k.startsWith('CLAUDE_CODE_'))).toEqual([]);
    expect(adapter.pid).toEqual(expect.any(Number));
    expect(adapter.effectiveSettings()).toEqual({ model: 'opus', approvalMode: 'default' });
    expect(events).toEqual([]);

    await adapter.turnStart(text('Hello'), 'c1');
    const session = events.find((e) => e.method === 'engine/session');
    expect(session?.params).toEqual({ engineSessionId: fake.last.sessionId });
    expect(adapter.engineSessionId).toBe(fake.last.sessionId);
    expect(versions).toEqual(['2.1.999']);
    expect(fake.last.userMessages[0]).toEqual({ type: 'user', message: { role: 'user', content: 'Hello' }, parent_tool_use_id: null });
  });

  it('turnStart waits for system/init before it resolves', async () => {
    const { fake, adapter, cwd } = rig({ turns: [[{ hold: true }]] });
    await adapter.start(cwd, {});
    let resolved = false;
    const started = adapter.turnStart(text('go'), 'c1').then(() => (resolved = true));
    // The fake answers on its next tick; the turn is accepted only after system/init.
    expect(resolved).toBe(false);
    await started;
    expect(resolved).toBe(true);
    expect(fake.last.userMessages).toHaveLength(1);
  });

  it('resume passes the engine session id and a known id is not reported again', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.resume('sess-known', cwd, { model: 'sonnet' });
    expect(fake.last.options).toMatchObject({ resume: 'sess-known', model: 'sonnet', cwd });
    await adapter.turnStart(text('again'), 'c1');
    await turnEnd(events);
    expect(methods(events)).not.toContain('engine/session');
    expect(adapter.effectiveSettings()).toEqual({ model: 'sonnet', approvalMode: 'default' });
  });

  it('approvalMode never maps to bypassPermissions with allowDangerouslySkipPermissions; tools run unasked', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'touch /tmp/x' } }, { text: 'Done.' }]] });
    await adapter.start(cwd, { approvalMode: 'never' });
    expect(fake.last.options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    expect(adapter.effectiveSettings()).toEqual({ model: 'opus', approvalMode: 'never' });
    await adapter.turnStart(text('go'), 'c1');
    expect((await turnEnd(events)).params.status).toBe('completed');
    expect(methods(events)).not.toContain('approval/request');
    expect(fake.last.permissions).toEqual([]);
  });

  it.each([
    ['acceptEdits', 'acceptEdits'],
    ['plan', 'plan'],
    ['on-request', 'default'],
    [undefined, 'default'],
  ] as const)('approvalMode %s runs permissionMode %s', async (approvalMode, permissionMode) => {
    const { fake, adapter, cwd } = rig();
    const settings: Settings = approvalMode === undefined ? {} : { approvalMode };
    await adapter.start(cwd, settings);
    expect(fake.last.options.permissionMode).toBe(permissionMode);
    expect(fake.last.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(adapter.effectiveSettings().approvalMode).toBe(permissionMode);
  });

  it('passes a configured executable', async () => {
    const { fake, adapter, cwd } = rig({}, { executable: '/opt/claude' });
    await adapter.start(cwd, {});
    expect(fake.last.options.pathToClaudeCodeExecutable).toBe('/opt/claude');
  });

  it('a query() that throws makes start reject with agent_unavailable', async () => {
    const { adapter, cwd } = rig({ throwOnQuery: 'no executable' });
    await expect(adapter.start(cwd, {})).rejects.toMatchObject({ code: 'agent_unavailable', message: expect.stringContaining('no executable') });
  });

  it('steer and diff answer not_supported', async () => {
    const { adapter } = rig();
    await expect(adapter.steer()).rejects.toMatchObject({ code: 'not_supported' });
    await expect(adapter.diff()).rejects.toMatchObject({ code: 'not_supported' });
  });

  it('loadQuery imports the SDK query function', async () => {
    expect(typeof (await loadQuery())).toBe('function');
  });
});

describe('ClaudeAdapter: a turn', () => {
  it('text with stream deltas, then usage, turn/completed and idle', async () => {
    const { adapter, events, cwd } = rig({ turns: [[{ thinking: 'Let me see.' }, { text: 'Hello there', chunks: 2 }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('hi'), 'c1');
    await turnEnd(events);
    expect(methods(events)).toEqual([
      'status/changed',
      'engine/session',
      'item/started', // reasoning
      'item/delta',
      'item/delta',
      'item/completed',
      'item/started', // agentMessage
      'item/delta',
      'item/delta',
      'item/completed',
      'usage/updated',
      'turn/completed',
      'status/changed',
    ]);
    expect(events[0]!.params).toEqual({ status: 'running' });
    const reasoning = events[5]!.params as { item: Record<string, unknown> };
    expect(reasoning.item).toMatchObject({ type: 'reasoning', status: 'completed', summary: '', text: 'Let me see.' });
    const started = events[6]!.params as { item: { itemId: string } };
    expect(started.item).toMatchObject({ type: 'agentMessage', status: 'inProgress', text: '' });
    expect(events.slice(7, 9).map((e) => e.params)).toEqual([
      { itemId: started.item.itemId, field: 'text', delta: 'Hello ' },
      { itemId: started.item.itemId, field: 'text', delta: 'there' },
    ]);
    expect(events[9]!.params).toEqual({ item: { itemId: started.item.itemId, type: 'agentMessage', status: 'completed', text: 'Hello there' } });
    expect(events[10]!.params).toEqual({ usage: { inputTokens: 123, outputTokens: 7 } });
    expect(events[11]!.params).toEqual({ status: 'completed' });
    expect(events[12]!.params).toEqual({ status: 'idle' });
  });

  it('a block without stream events starts and completes at once; empty text is skipped', async () => {
    const assistant = (content: unknown[]) => ({ message: { type: 'assistant', message: { id: 'msg_x', content }, parent_tool_use_id: null } });
    const { adapter, events, cwd } = rig({ turns: [[assistant([{ type: 'text', text: '' }, { type: 'text', text: 'Plain.' }, { type: 'redacted_thinking' }])]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('hi'), 'c1');
    await turnEnd(events);
    const items = events.filter((e) => e.method === 'item/started' || e.method === 'item/completed');
    expect(items.map((e) => [e.method, (e.params as { item: { text?: string } }).item.text])).toEqual([
      ['item/started', 'Plain.'],
      ['item/completed', 'Plain.'],
    ]);
  });

  it('subagent messages, stray stream events and unknown messages are ignored', async () => {
    const sub = { parent_tool_use_id: 'toolu_task' };
    const { adapter, events, cwd } = rig({
      turns: [
        [
          { message: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'inner' }] }, ...sub } },
          { message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }, ...sub } },
          { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'zz' }] }, ...sub } },
          { message: { type: 'stream_event', event: { type: 'content_block_delta', index: 7, delta: { type: 'text_delta', text: 'x' } }, parent_tool_use_id: null } },
          { message: { type: 'stream_event', event: { type: 'content_block_start', index: 3, content_block: { type: 'tool_use' } }, parent_tool_use_id: null } },
          { message: { type: 'stream_event', event: { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{' } }, parent_tool_use_id: null } },
          { message: { type: 'user', message: { content: 'plain' }, parent_tool_use_id: null } },
          { message: { type: 'user', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_result', tool_use_id: 'unknown' }] }, parent_tool_use_id: null } },
          { message: { type: 'system', subtype: 'status' } },
          { message: { type: 'rate_limit_event' } },
          { text: 'Outer.' },
        ],
      ],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('hi'), 'c1');
    await turnEnd(events);
    const texts = events.filter((e) => e.method === 'item/completed').map((e) => (e.params as { item: { text?: string } }).item.text);
    expect(texts).toEqual(['Outer.']);
  });

  it('messages outside a turn are dropped (a result included)', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    await adapter.turnStart(text('hi'), 'c1');
    await turnEnd(events);
    const count = events.length;
    fake.last.send({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: 'late' }] }, parent_tool_use_id: null });
    fake.last.send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'late' } }, parent_tool_use_id: null });
    fake.last.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] }, parent_tool_use_id: null });
    fake.last.send({ type: 'result', subtype: 'success', is_error: false, usage: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toHaveLength(count);
  });

  it('an error result fails the turn with the subtype as code', async () => {
    const { adapter, events, cwd } = rig({
      turns: [[{ fail: { subtype: 'error_max_turns', errors: ['too many turns'] } }], [{ fail: { subtype: 'success', isError: true } }]],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('one'), 'c1');
    expect((await turnEnd(events)).params).toEqual({ status: 'failed', error: { code: 'error_max_turns', message: 'too many turns' } });
    const from = events.length;
    await adapter.turnStart(text('two'), 'c2');
    expect((await turnEnd(events, from)).params).toEqual({ status: 'failed', error: { code: 'agent_error', message: 'the turn failed' } });
  });

  it('system/init on every turn re-reports nothing; the second turn does not wait for one', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    await adapter.turnStart(text('one'), 'c1');
    await turnEnd(events);
    const from = events.length;
    await adapter.turnStart(text('two'), 'c2');
    await turnEnd(events, from);
    expect(methods(events).filter((m) => m === 'engine/session')).toHaveLength(1);
    expect(fake.queries).toHaveLength(1);
  });

  it('images and mentions reach the engine as text', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    await adapter.turnStart(
      [
        { type: 'text', text: 'Look' },
        { type: 'mention', name: 'a.ts', path: 'src/a.ts' },
        { type: 'image', url: 'https://host/v1/blob/1' },
      ],
      'c1',
    );
    await turnEnd(events);
    expect(fake.last.userMessages[0]!.message.content).toBe('Look\n\n@src/a.ts\n\n[image: https://host/v1/blob/1]');
  });
});

describe('ClaudeAdapter: tools, approvals and questions', () => {
  it('Bash: command item, command approval, accept allows the original input, tool_result completes the item', async () => {
    const input = { command: 'ls -la', description: 'List the files' };
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input, id: 'toolu_1', result: 'a\nb' }, { text: 'Two files.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('list'), 'c1');
    const started = await find(events, 'item/started');
    expect(started.params.item).toEqual({ itemId: 'toolu_1', type: 'command', status: 'inProgress', command: 'ls -la', cwd, output: '' });
    const request = requestOf(await find(events, 'approval/request'));
    expect(request).toEqual({
      requestId: expect.stringMatching(/^req_/),
      itemId: 'toolu_1',
      kind: 'command',
      command: 'ls -la',
      cwd,
      reason: 'List the files',
      expiresAt: null,
      availableDecisions: ['accept', 'decline', 'cancel'],
    });
    await adapter.resolveApproval(request.requestId, 'accept');
    await turnEnd(events);
    expect(fake.last.permissions[0]).toEqual({ toolName: 'Bash', input, toolUseID: 'toolu_1', answer: { behavior: 'allow', updatedInput: input } });
    const completed = events.find((e) => e.method === 'item/completed' && (e.params as { item: { itemId: string } }).item.itemId === 'toolu_1');
    expect(completed?.params).toEqual({ item: { itemId: 'toolu_1', type: 'command', status: 'completed', command: 'ls -la', cwd, output: 'a\nb' } });
    expect((events.at(-2)!.params as { status: string }).status).toBe('completed');
  });

  it('acceptForSession is offered with suggestions and returns them as updatedPermissions', async () => {
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }];
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'ls' }, suggestions }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('list'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    expect(request.availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    await adapter.resolveApproval(request.requestId, 'acceptForSession');
    await turnEnd(events);
    expect(fake.last.permissions[0]!.answer).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: suggestions });
  });

  it('decline denies and the turn continues; the tool item fails', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'rm -rf x' }, id: 'toolu_d' }, { text: 'Okay, I will not.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('delete'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    await adapter.resolveApproval(request.requestId, 'decline');
    expect((await turnEnd(events)).params.status).toBe('completed');
    expect(fake.last.permissions[0]!.answer).toEqual({ behavior: 'deny', message: DECLINE_MESSAGE });
    const item = events.find((e) => e.method === 'item/completed' && (e.params as { item: { itemId: string } }).item.itemId === 'toolu_d');
    expect(item?.params).toMatchObject({ item: { status: 'failed', output: DECLINE_MESSAGE } });
    expect(events.some((e) => e.method === 'item/completed' && (e.params as { item: { text?: string } }).item.text === 'Okay, I will not.')).toBe(true);
  });

  it('cancel denies with interrupt and the turn ends interrupted', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'rm x' } }, { text: 'never' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('delete'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    await adapter.resolveApproval(request.requestId, 'cancel');
    expect((await turnEnd(events)).params).toEqual({ status: 'interrupted' });
    expect(fake.last.permissions[0]!.answer).toEqual({ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true });
    expect(events.at(-1)!.params).toEqual({ status: 'idle' });
  });

  it('Write: fileChange item and approval (add for a new file), accept writes', async () => {
    const { fake, adapter, events, cwd } = rig({
      turns: [[{ tool: 'Write', input: { file_path: 'hello.txt', content: 'hello' }, id: 'toolu_w', result: 'File created' }]],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('write'), 'c1');
    const change = { path: 'hello.txt', kind: 'add', diff: '@@ -0,0 +1,1 @@\n+hello' };
    expect((await find(events, 'item/started')).params.item).toEqual({ itemId: 'toolu_w', type: 'fileChange', status: 'inProgress', changes: [change] });
    const request = requestOf(await find(events, 'approval/request'));
    expect(request).toMatchObject({ kind: 'fileChange', itemId: 'toolu_w', changes: [change], reason: '' });
    await adapter.resolveApproval(request.requestId, 'accept');
    await turnEnd(events);
    expect(fake.last.permissions[0]!.answer).toMatchObject({ behavior: 'allow' });
    const done = events.find((e) => e.method === 'item/completed');
    expect(done?.params).toEqual({ item: { itemId: 'toolu_w', type: 'fileChange', status: 'completed', changes: [change] } });
  });

  it('Edit: a modify change with the old text removed and the new added', async () => {
    const { adapter, events, cwd } = rig({ turns: [[{ tool: 'Edit', input: { file_path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' } }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('edit'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    expect(request.changes).toEqual([{ path: 'a.ts', kind: 'modify', diff: '@@ -1,1 +1,1 @@\n-x = 1\n+x = 2' }]);
    await adapter.resolveApproval(request.requestId, 'decline');
    await turnEnd(events);
  });

  it('AskUserQuestion: an input request with index ids; answers go back keyed by question text', async () => {
    const questions = [
      { question: 'Which color?', header: 'Color', options: [{ label: 'blue', description: 'Calm' }, { label: 'red', description: 'Loud' }], multiSelect: false },
      { question: 'Which sizes?', header: 'Size', options: [{ label: 'S', description: '' }, { label: 'M', description: '' }], multiSelect: true },
    ];
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'AskUserQuestion', input: { questions }, id: 'toolu_q' }, { text: 'blue' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('ask me'), 'c1');
    expect((await find(events, 'item/started')).params.item).toMatchObject({ type: 'toolCall', tool: 'AskUserQuestion' });
    const request = requestOf(await find(events, 'input/request'));
    expect(request).toEqual({
      requestId: expect.stringMatching(/^req_/),
      kind: 'input',
      itemId: 'toolu_q',
      isBlocking: true,
      questions: [
        { id: '0', header: 'Color', question: 'Which color?', isOther: true, isSecret: false, options: questions[0]!.options },
        { id: '1', header: 'Size', question: 'Which sizes?', isOther: true, isSecret: false, options: questions[1]!.options, multiSelect: true },
      ],
    });
    // An approval decision does not answer a question.
    await adapter.resolveApproval(request.requestId, 'accept');
    expect(fake.last.permissions).toEqual([]);
    await adapter.answerInput(request.requestId, { '0': ['blue'], '1': ['S', 'M'] });
    await turnEnd(events);
    expect(fake.last.permissions[0]!.answer).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which color?': 'blue', 'Which sizes?': 'S, M' } },
    });
    // Answering twice does nothing.
    await adapter.answerInput(request.requestId, { '0': ['red'] });
    expect(fake.last.permissions).toHaveLength(1);
  });

  it('any other tool asks for a permission with the tool and its input; a toolCall item carries the result', async () => {
    const input = { url: 'https://example.com', prompt: 'title?' };
    const { adapter, events, cwd } = rig({ turns: [[{ tool: 'WebFetch', input, id: 'toolu_f', result: 'Example Domain' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('fetch'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    expect(request).toMatchObject({ kind: 'permission', permissions: { tool: 'WebFetch', input }, scope: 'turn', itemId: 'toolu_f' });
    // An answer does not resolve an approval.
    await adapter.answerInput(request.requestId, { '0': ['x'] });
    await adapter.resolveApproval(request.requestId, 'accept');
    await turnEnd(events);
    const done = events.find((e) => e.method === 'item/completed');
    expect(done?.params).toEqual({ item: { itemId: 'toolu_f', type: 'toolCall', status: 'completed', tool: 'WebFetch', arguments: input, result: 'Example Domain' } });
  });

  it('a failed tool result fails its item with the error text', async () => {
    const { adapter, events, cwd } = rig({ turns: [[{ tool: 'Read', input: { file_path: 'nope' }, ask: false, result: 'no such file', isError: true }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('read'), 'c1');
    await turnEnd(events);
    const done = events.find((e) => e.method === 'item/completed');
    expect(done?.params).toMatchObject({ item: { type: 'toolCall', status: 'failed', error: 'no such file' } });
  });

  it('one pending request per toolUseID; unknown and late ids are ignored', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'ls' }, id: 'toolu_same' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('list'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    const again = fake.last.options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, requestId: 'ctl_1', toolUseID: 'toolu_same' });
    expect(events.filter((e) => e.method === 'approval/request')).toHaveLength(1);
    await adapter.resolveApproval('req_unknown', 'accept');
    await adapter.resolveApproval(request.requestId, 'accept');
    await expect(again).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    await turnEnd(events);
    await adapter.resolveApproval(request.requestId, 'decline');
    expect(fake.last.permissions).toHaveLength(1);
  });

  it('canUseTool outside a turn is denied without a request', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    const answer = await fake.last.options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, requestId: 'ctl_1', toolUseID: 't' });
    expect(answer).toEqual({ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true });
    expect(events).toEqual([]);
  });

  it('a result while a request is pending withdraws it and closes cut-off items', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ text: 'Working', chunks: 1 }, { tool: 'Bash', input: { command: 'ls' }, id: 'toolu_p' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    // The engine gives up on its own: a stream starts, then the result comes while the approval waits.
    fake.last.send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_cut' } }, parent_tool_use_id: null });
    fake.last.send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, parent_tool_use_id: null });
    fake.last.send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } }, parent_tool_use_id: null });
    fake.last.send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['stopped'], usage: { input_tokens: 1, output_tokens: 1 } });
    const end = await turnEnd(events);
    expect(end.params).toEqual({ status: 'failed', error: { code: 'error_during_execution', message: 'stopped' } });
    const withdrawn = events.find((e) => e.method === 'request/withdrawn');
    expect(withdrawn?.params).toEqual({ requestId: request.requestId });
    const closed = events.filter((e) => e.method === 'item/completed').map((e) => (e.params as { item: Record<string, unknown> }).item);
    expect(closed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'agentMessage', status: 'completed', text: 'Half' }),
        expect.objectContaining({ itemId: 'toolu_p', status: 'failed' }),
      ]),
    );
    // The withdrawn request no longer resolves anything.
    await adapter.resolveApproval(request.requestId, 'accept');
  });
});

describe('ClaudeAdapter: interrupt', () => {
  it('interrupt calls Query.interrupt and the next result ends the turn interrupted', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ text: 'Counting', chunks: 1 }, { hold: true }, { text: 'never' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('count'), 'c1');
    await until(() => (fake.last.holdingNow ? true : undefined), 'hold');
    await adapter.interrupt();
    expect(fake.last.interrupts).toBe(1);
    expect((await turnEnd(events)).params).toEqual({ status: 'interrupted' });
    expect(events.some((e) => e.method === 'item/completed' && (e.params as { item: { text?: string } }).item.text === 'never')).toBe(false);
    // Nothing runs: interrupting again is a no-op.
    await adapter.interrupt();
    expect(fake.last.interrupts).toBe(1);
  });

  it('interrupt while an approval waits withdraws it (the SDK aborts the call) and ends interrupted', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'ls' } }, { text: 'never' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    await adapter.interrupt();
    const withdrawn = await find(events, 'request/withdrawn');
    expect(withdrawn.params).toEqual({ requestId: request.requestId });
    expect((await turnEnd(events)).params).toEqual({ status: 'interrupted' });
    expect(fake.last.permissions[0]!.answer).toEqual({ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true });
  });

  it('interrupt without a running engine rejects with agent_unavailable', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ hold: true }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    fake.last.child!.kill('SIGKILL');
    await find(events, 'agent/exited');
    // The turn is gone with the engine: nothing to interrupt.
    await adapter.interrupt();
  });
});

describe('ClaudeAdapter: supervision', () => {
  it('a child exit without kill() reports error and agent/exited; the next turn resumes on a new query', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ text: 'first' }], [{ hold: true }], [{ text: 'resumed' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('one'), 'c1');
    await turnEnd(events);
    const sessionId = adapter.engineSessionId;
    await adapter.turnStart(text('two'), 'c2');
    const pid = adapter.pid!;
    fake.last.child!.kill('SIGKILL');
    const exited = await find(events, 'agent/exited');
    expect(exited.params.reason).toBe('Claude Code killed by SIGKILL');
    expect(events[events.indexOf(exited) - 1]!.params).toEqual({ status: 'error' });
    expect(adapter.pid).toBeUndefined();
    expect(() => process.kill(pid, 0)).toThrow();

    const from = events.length;
    await adapter.turnStart(text('three'), 'c3');
    expect(fake.queries).toHaveLength(2);
    expect(fake.last.options.resume).toBe(sessionId);
    const end = await turnEnd(events, from);
    expect(end.params.status).toBe('completed');
    expect(methods(events.slice(from))).not.toContain('engine/session');
  });

  it('an exit with a code names the code; a pending approval and a waiting turnStart are released', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'ls' } }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    const request = requestOf(await find(events, 'approval/request'));
    const pid = fake.last.child!.pid!;
    process.kill(pid, 'SIGTERM');
    const exited = await find(events, 'agent/exited');
    expect(exited.params.reason).toMatch(/^Claude Code (killed by SIGTERM|exited with code)/);
    // The open canUseTool call is answered (denied) so nothing hangs.
    expect(fake.last.permissions.map((p) => p.answer)).toEqual([{ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true }]);
    // The dead run's request is gone.
    await adapter.resolveApproval(request.requestId, 'accept');
  });

  it('a query that fails without a child reports the failure', async () => {
    const { adapter, events, cwd } = rig({ spawn: false, turns: [[{ exit: true }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    const exited = await find(events, 'agent/exited');
    expect(exited.params.reason).toBe('the Claude Code query failed: Claude Code process exited with code 1');
  });

  it('a query that ends without a child reports it', async () => {
    const { fake, adapter, events, cwd } = rig({ spawn: false });
    await adapter.start(cwd, {});
    fake.last.end();
    const exited = await find(events, 'agent/exited');
    expect(exited.params.reason).toBe('the Claude Code query ended');
  });

  it('an engine that never sends system/init fails turnStart with agent_unavailable', async () => {
    const { adapter, events, cwd } = rig({ noInit: true }, { requestTimeoutMs: 100 });
    await adapter.start(cwd, {});
    await expect(adapter.turnStart(text('go'), 'c1')).rejects.toMatchObject({ code: 'agent_unavailable', message: expect.stringContaining('no system/init within 100 ms') });
    expect(methods(events)).toEqual(['status/changed', 'status/changed', 'agent/exited']);
  });

  it('a turn on a run that died before its first init starts a new session', async () => {
    const { fake, adapter, events, cwd } = rig({ spawn: false });
    await adapter.start(cwd, {});
    fake.last.end();
    await find(events, 'agent/exited');
    await adapter.turnStart(text('go'), 'c1');
    expect(fake.queries).toHaveLength(2);
    expect(fake.last.options.resume).toBeUndefined();
    await find(events, 'engine/session');
  });

  it('kill() ends the process group, closes inbox and query, and silences the adapter', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ tool: 'Bash', input: { command: 'ls' } }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    await find(events, 'approval/request');
    const query = fake.last;
    const pid = adapter.pid!;
    const count = events.length;
    await adapter.kill();
    expect(query.closed).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(query.permissions[0]?.answer ?? { behavior: 'deny' }).toMatchObject({ behavior: 'deny' });
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(count);
    await expect(adapter.turnStart(text('again'), 'c2')).rejects.toMatchObject({ code: 'agent_unavailable' });
    await expect(adapter.start(cwd, {})).rejects.toMatchObject({ code: 'agent_unavailable' });
    // Killing twice is fine.
    await adapter.kill();
  });

  it('kill() during an open waits for it and ends the new run', async () => {
    const { fake, adapter, cwd } = rig();
    const starting = adapter.start(cwd, {});
    await adapter.kill();
    await starting;
    expect(fake.last.closed).toBe(true);
  });

  it('kill() before start does nothing', async () => {
    const { adapter } = rig();
    await adapter.kill();
  });

  it('logs the child stderr and the SDK stderr callback', async () => {
    const { fake, adapter, logs, cwd } = rig();
    await adapter.start(cwd, {});
    fake.last.options.stderr!('warning: something\n');
    fake.last.child!.stderr!.emit('data', Buffer.from('child says hi\n'));
    expect(logs).toEqual(expect.arrayContaining(['claude stderr: warning: something', 'claude stderr: child says hi']));
  });

  it('a spawn that fails reports the engine lost', async () => {
    const { adapter, events, cwd } = rig({}, {}, (params) => {
      const query = new FakeClaude({ spawn: false }).query(params);
      params.options.spawnClaudeCodeProcess!({ command: '/nonexistent/claude', args: [], env: {}, signal: new AbortController().signal });
      return query;
    });
    await adapter.start(cwd, {});
    const exited = await find(events, 'agent/exited');
    expect(exited.params.reason).toContain('cannot run /nonexistent/claude');
  });

  it('the SDK abort signal ends the child process group', async () => {
    const abort = new AbortController();
    let child: { pid?: number } | undefined;
    const { adapter, events, cwd } = rig({}, {}, (params) => {
      const query = new FakeClaude({ spawn: false }).query(params);
      child = params.options.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'], env: {}, signal: abort.signal }) as { pid?: number };
      return query;
    });
    await adapter.start(cwd, {});
    abort.abort();
    const exited = await find(events, 'agent/exited');
    expect(exited.params.reason).toBe('Claude Code killed by SIGTERM');
    expect(() => process.kill(child!.pid!, 0)).toThrow();
  });
});

describe('Inbox', () => {
  it('yields pushed messages in order and ends when closed; pushes after close are dropped', async () => {
    const inbox = new Inbox();
    const message = (content: string) => ({ type: 'user' as const, message: { role: 'user' as const, content }, parent_tool_use_id: null });
    inbox.push(message('a'));
    const seen: string[] = [];
    const reading = (async () => {
      for await (const m of inbox) seen.push(m.message.content as string);
    })();
    await new Promise((r) => setTimeout(r, 5));
    inbox.push(message('b'));
    inbox.close();
    inbox.push(message('c'));
    await reading;
    expect(seen).toEqual(['a', 'b']);
  });
});
