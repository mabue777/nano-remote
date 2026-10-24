// The Claude adapter against the scripted fake query (testing/fake-query.ts): the option mapping, the
// message sequences of the spike and the live test, approvals and questions with every decision,
// interrupts, child exits and kills.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '../../generated/common.js';
import type { AdapterEvent } from '../../core/adapter.js';
import { claudeConfig, type ClaudeConfig } from '../../config/claude.js';
import { attachmentFixture, PNG_BYTES } from '../shared/testing/attachments.js';
import { bundledExecutable, ClaudeAdapter, executablePath, HUNG, Inbox, loadQuery, type QueryFn } from './adapter.js';
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

function rig(
  fakeOptions: FakeClaudeOptions = {},
  config: Partial<ClaudeConfig> = {},
  query?: QueryFn,
  efforts?: (model: string) => readonly string[] | undefined,
): Rig {
  const fake = new FakeClaude(fakeOptions);
  const cfg = claudeConfig(
    { configDir: mkdtempSync(path.join(tmpdir(), 'nano-claude-cfg-')), requestTimeoutMs: 15_000, killGraceMs: 300, ...config },
    {},
  );
  const versions: string[] = [];
  const logs: string[] = [];
  const adapter = new ClaudeAdapter({ query: query ?? fake.query, config: cfg, onVersion: (v) => versions.push(v), log: (m) => logs.push(m), efforts });
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

  describe('effort (settings.effort)', () => {
    // As supportedModels() listed them on 2026-10-24: Opus 4.6 lacks xhigh, Haiku 4.5 has no effort control.
    const levels: Record<string, readonly string[]> = {
      opus: ['low', 'medium', 'high', 'xhigh', 'max'],
      'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
      'claude-haiku-4-5-20251001': [],
    };
    const efforts = (model: string) => levels[model];

    it('reaches the query options and comes back in the effective settings', async () => {
      const { fake, adapter, cwd } = rig({}, {}, undefined, efforts);
      await adapter.start(cwd, { effort: 'xhigh' });
      expect(fake.last.options.effort).toBe('xhigh');
      expect(adapter.effectiveSettings()).toEqual({ model: 'opus', approvalMode: 'default', effort: 'xhigh' });
    });

    it('is left out when unset, and then no level is reported', async () => {
      const { fake, adapter, cwd } = rig({}, {}, undefined, efforts);
      await adapter.start(cwd, {});
      expect(fake.last.options).not.toHaveProperty('effort');
      expect(adapter.effectiveSettings()).not.toHaveProperty('effort');
    });

    it('is downgraded for the model as Claude Code does, and left out for a model without effort', async () => {
      const older = rig({}, {}, undefined, efforts);
      await older.adapter.start(older.cwd, { model: 'claude-opus-4-6', effort: 'xhigh' });
      expect(older.fake.last.options.effort).toBe('high');
      expect(older.adapter.effectiveSettings()).toMatchObject({ effort: 'high' });
      const none = rig({}, {}, undefined, efforts);
      await none.adapter.start(none.cwd, { model: 'claude-haiku-4-5-20251001', effort: 'low' });
      expect(none.fake.last.options).not.toHaveProperty('effort');
      expect(none.adapter.effectiveSettings()).not.toHaveProperty('effort');
    });

    it('resume sends it again', async () => {
      const { fake, adapter, cwd } = rig({}, {}, undefined, efforts);
      await adapter.resume('sess-known', cwd, { effort: 'low' });
      expect(fake.last.options).toMatchObject({ resume: 'sess-known', effort: 'low' });
    });
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

  it('steer answers not_supported', async () => {
    const { adapter } = rig();
    await expect(adapter.steer()).rejects.toMatchObject({ code: 'not_supported' });
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

  it('a result with no output and no turn emits nothing', async () => {
    const { fake, adapter, events, cwd, logs } = rig();
    await adapter.start(cwd, {});
    await adapter.turnStart(text('hi'), 'c1');
    await turnEnd(events);
    const count = events.length;
    fake.last.send({ type: 'result', subtype: 'success', is_error: false, usage: {} });
    fake.last.send({ type: 'user', message: { content: [{ type: 'text', text: 'not a tool result' }] }, parent_tool_use_id: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toHaveLength(count);
    expect(logs.filter((l) => l.startsWith('claude result'))).toEqual([
      'claude result subtype=success is_error=false turn=host',
      'claude result subtype=success is_error=false turn=empty',
    ]);
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

  it('attachments (spec 8.1): stored and data-URL images as base64 image blocks, the rest as path lines', async () => {
    const files = attachmentFixture();
    const { fake, adapter, events, cwd } = rig({}, { attachmentsDir: files.dir });
    await adapter.start(cwd, {});
    expect(fake.last.options.additionalDirectories).toEqual([files.dir]);
    await adapter.turnStart([...files.input, { type: 'image', url: 'data:image/gif;base64,R0lG' }], 'c1');
    await turnEnd(events);
    expect(fake.last.userMessages[0]!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES.toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lG' } },
      { type: 'text', text: `What is wrong here?\n\nAttached file: ${files.heicPath}\n\nAttached file: ${files.logPath}` },
    ]);
  });

  it('an image alone is image blocks only; without an attachments folder no additional directory', async () => {
    const files = attachmentFixture();
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    expect(fake.last.options.additionalDirectories).toBeUndefined();
    await adapter.turnStart([files.input[1]!], 'c1');
    await turnEnd(events);
    expect(fake.last.userMessages[0]!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]);
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

  it('canUseTool outside a turn opens an engine-initiated turn and asks', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    const asked = fake.last.options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, requestId: 'ctl_1', toolUseID: 't' });
    const request = requestOf(await find(events, 'approval/request'));
    expect(methods(events)).toEqual(['turn/started', 'status/changed', 'approval/request']);
    await adapter.resolveApproval(request.requestId, 'accept');
    expect(await asked).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('canUseTool after kill() is denied without a request', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    const canUseTool = fake.last.options.canUseTool!;
    await adapter.kill();
    const answer = await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, requestId: 'ctl_1', toolUseID: 't' });
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

describe('ClaudeAdapter: engine-initiated turns (a background task reports in)', () => {
  const toolUse = (id: string, command: string) => ({
    message: { type: 'assistant', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }, parent_tool_use_id: null },
  });
  const toolResult = (id: string, output: string) => ({
    message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] }, parent_tool_use_id: null },
  });

  it('init, text, tool_use, tool_result and result with no host turn: turn/started ... turn/completed', async () => {
    const { fake, adapter, events, cwd, logs } = rig();
    await adapter.start(cwd, {});
    await fake.last.engineTurn(
      [{ text: 'Checking the tree.', chunks: 1 }, toolUse('toolu_git', 'git status'), toolResult('toolu_git', 'clean'), { text: 'All clean.', chunks: 1 }],
      { summary: 'Monitor  "ci"\n finished', status: 'completed' },
    );
    await turnEnd(events);
    expect(methods(events)).toEqual([
      'engine/session',
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
    expect(events[2]!.params).toEqual({ status: 'running' });
    expect((events[4]!.params as { item: unknown }).item).toMatchObject({
      type: 'toolCall',
      status: 'completed',
      tool: 'background task: Monitor "ci" finished',
      arguments: { taskId: 'task_fake', status: 'completed', summary: 'Monitor "ci" finished' },
    });
    expect((events[8]!.params as { item: unknown }).item).toMatchObject({ itemId: 'toolu_git', type: 'command', status: 'inProgress', command: 'git status' });
    expect((events[9]!.params as { item: unknown }).item).toMatchObject({ itemId: 'toolu_git', type: 'command', status: 'completed', output: 'clean' });
    expect(events[14]!.params).toEqual({ status: 'completed' });
    expect(logs).toContain('claude result subtype=success is_error=false turn=engine');
    expect(logs.some((l) => l.includes('turn=none') || l.includes('turn=empty'))).toBe(false);
  });

  it('a second engine turn after the first ends opens a new turn; ambient notifications are not shown', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    await fake.last.engineTurn([{ text: 'One.' }], null);
    await turnEnd(events);
    const from = events.length;
    await fake.last.engineTurn([{ text: 'Two.' }], { summary: 'watcher', ambient: true });
    await turnEnd(events, from);
    expect(methods(events).filter((m) => m === 'turn/started' || m === 'turn/completed')).toEqual([
      'turn/started',
      'turn/completed',
      'turn/started',
      'turn/completed',
    ]);
    const tools = events.filter((e) => e.method === 'item/started' && (e.params as { item: { type: string } }).item.type === 'toolCall');
    expect(tools).toEqual([]);
  });

  it('a failed background task is a failed item; a notification during a running turn shows in that turn', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ hold: true }, { text: 'Done.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    await until(() => (fake.last.holdingNow ? true : undefined), 'the hold');
    fake.last.send({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'failed', summary: 'build failed', output_file: '/tmp/x' });
    fake.last.release();
    await turnEnd(events);
    expect(methods(events).filter((m) => m === 'turn/started')).toEqual([]);
    const item = events.find((e) => e.method === 'item/completed' && (e.params as { item: { type: string } }).item.type === 'toolCall');
    expect((item!.params as { item: unknown }).item).toMatchObject({ status: 'failed', tool: 'background task: build failed', error: 'build failed' });
  });

  it('turnStart during an engine turn with a long tool running joins it: no second turn, the tool stays visible', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    const played = fake.last.engineTurn([
      toolUse('toolu_cov', 'pnpm test:coverage'),
      { hold: true },
      toolResult('toolu_cov', 'all tests passed'),
      { text: 'Tests pass. Status: done.', chunks: 1 },
    ]);
    const running = await until(
      () => events.find((e) => e.method === 'item/started' && (e.params as { item: { type: string } }).item.type === 'command'),
      'the long tool',
    );
    expect((running!.params as { item: unknown }).item).toMatchObject({ itemId: 'toolu_cov', status: 'inProgress', command: 'pnpm test:coverage' });
    const before = events.length;

    await adapter.turnStart(text('status?'), 'c1');
    await until(() => (fake.last.midTurn.length > 0 ? true : undefined), 'the mid-turn message');
    expect(fake.last.midTurn.map((m) => m.message.content)).toEqual(['status?']);
    expect(methods(events.slice(before))).toEqual(['status/changed']); // running, already so in the core

    fake.last.release();
    await played;
    await turnEnd(events);
    expect(methods(events).filter((m) => m === 'turn/started' || m === 'turn/completed')).toEqual(['turn/started', 'turn/completed']);
    const completed = events.filter((e) => e.method === 'item/completed').map((e) => (e.params as { item: { itemId: string; type: string } }).item);
    expect(completed.map((i) => i.type)).toEqual(['toolCall', 'command', 'agentMessage']);
    expect(methods(events).at(-1)).toBe('status/changed');
    expect(events.at(-1)!.params).toEqual({ status: 'idle' });
  });

  it('an engine turn can be interrupted', async () => {
    const { fake, adapter, events, cwd } = rig();
    await adapter.start(cwd, {});
    const played = fake.last.engineTurn([toolUse('toolu_long', 'sleep 100'), { hold: true }, { text: 'never' }]);
    await find(events, 'item/started');
    await adapter.interrupt();
    await played;
    expect((await turnEnd(events)).params).toEqual({ status: 'interrupted' });
    expect(fake.last.interrupts).toBe(1);
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

describe('ClaudeAdapter: background tasks for the phone (background/changed, input/taken)', () => {
  const assistant = (content: unknown[], parent: string | null = null) => ({
    message: { type: 'assistant', message: { id: `msg_${Math.random()}`, content }, parent_tool_use_id: parent },
  });
  const launch = (id: string, name: string, input: Record<string, unknown>, toolUseResult: unknown) => [
    assistant([{ type: 'tool_use', id, name, input }]),
    { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] }, parent_tool_use_id: null, tool_use_result: toolUseResult } },
  ];
  const agent = (id: string, description: string, agentId: string) =>
    launch(id, 'Agent', { description, prompt: 'do it', run_in_background: true }, { isAsync: true, status: 'async_launched', agentId });
  const changes = (events: AdapterEvent[]) =>
    events.filter((e): e is Extract<AdapterEvent, { method: 'background/changed' }> => e.method === 'background/changed').map((e) => e.params.tasks);
  const latest = (events: AdapterEvent[]) => changes(events).at(-1);
  const system = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, uuid: randomUUID(), session_id: 's', ...fields });
  const notification = (fields: Record<string, unknown>) => system('task_notification', { output_file: '/tmp/x', summary: '', ...fields });

  it('launch: published once the result confirms it, titled by the description, with the start time', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { adapter, events, cwd } = rig({ turns: [[...agent('toolu_a', 'Review   the parser', 'agent_1'), { text: 'Launched.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('review'), 'c1');
    await turnEnd(events);
    expect(changes(events)).toHaveLength(1);
    const [task] = latest(events)!;
    expect(task).toEqual({ id: 'toolu_a', title: 'Review the parser', status: 'running', startedAt: expect.any(Number) });
    expect(task!.startedAt).toBeGreaterThanOrEqual(before);
    // The launch is reported before the turn's end.
    expect(methods(events).indexOf('background/changed')).toBeLessThan(methods(events).indexOf('turn/completed'));
  });

  it('progress: the latest task_progress line of its tool_use id is the activity; repeats and strangers change nothing', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[...agent('toolu_a', 'Review the parser', 'agent_1'), { text: 'Launched.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('review'), 'c1');
    await turnEnd(events);
    fake.last.send(system('task_progress', { task_id: 'agent_1', tool_use_id: 'toolu_a', description: 'Running Read parser.ts', last_tool_name: 'Read', usage: {} }));
    await until(() => latest(events)?.[0]?.lastActivity, 'the activity');
    expect(latest(events)).toEqual([{ id: 'toolu_a', title: 'Review the parser', status: 'running', startedAt: expect.any(Number), lastActivity: 'Running Read parser.ts' }]);
    const count = changes(events).length;
    fake.last.send(system('task_progress', { task_id: 'agent_1', tool_use_id: 'toolu_a', description: 'Running Read parser.ts', usage: {} }));
    fake.last.send(system('task_progress', { task_id: 'agent_9', tool_use_id: 'toolu_other', description: 'Running elsewhere', usage: {} }));
    // A summary (agentProgressSummaries) wins over the description; matched by the task id alone.
    fake.last.send(system('task_progress', { task_id: 'agent_1', description: 'Running Grep', summary: 'Checking the  error paths', usage: {} }));
    await until(() => (latest(events)?.[0]?.lastActivity === 'Checking the error paths' ? true : undefined), 'the summary');
    expect(changes(events)).toHaveLength(count + 1);
  });

  it('end: the notification marks it finished, failed or cancelled with endedAt; ended tasks go when the next turn starts', async () => {
    const { fake, adapter, events, cwd } = rig({
      turns: [
        [
          ...agent('toolu_a', 'Review the parser', 'agent_1'),
          ...launch('toolu_b', 'Bash', { command: 'npm test   --watch', run_in_background: true }, { stdout: '', backgroundTaskId: 'bash_2' }),
          ...launch('toolu_m', 'Monitor', { command: 'tail -f log', description: 'watch the log' }, { taskId: 'mon_3', timeoutMs: 180000, persistent: false }),
          { text: 'Started three.' },
        ],
        [{ text: 'Next.' }],
      ],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    await turnEnd(events);
    expect(latest(events)!.map((t) => [t.id, t.title, t.status])).toEqual([
      ['toolu_a', 'Review the parser', 'running'],
      ['toolu_b', 'npm test --watch', 'running'],
      ['toolu_m', 'watch the log', 'running'],
    ]);
    // A subagent's own background launch is not a task of the session.
    fake.last.send(assistant([{ type: 'tool_use', id: 'toolu_inner', name: 'Bash', input: { command: 'x', run_in_background: true } }], 'toolu_a').message);
    fake.last.send(notification({ task_id: 'agent_1', tool_use_id: 'toolu_a', status: 'completed', summary: 'DONE' }));
    fake.last.send(notification({ task_id: 'bash_2', status: 'failed', summary: 'exit 1' }));
    fake.last.send(notification({ task_id: 'mon_3', tool_use_id: 'toolu_m', status: 'stopped' }));
    await until(() => (latest(events)!.every((t) => t.status !== 'running') ? true : undefined), 'all ended');
    const ended = latest(events)!;
    expect(ended.map((t) => [t.id, t.status])).toEqual([
      ['toolu_a', 'finished'],
      ['toolu_b', 'failed'],
      ['toolu_m', 'cancelled'],
    ]);
    for (const task of ended) expect(task.endedAt).toBeGreaterThanOrEqual(task.startedAt);
    const from = events.length;
    await adapter.turnStart(text('next'), 'c2');
    await turnEnd(events, from);
    expect(latest(events)).toEqual([]);
  });

  it('an engine-initiated turn also starts a new list: the task that woke the engine is dropped from it', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[...agent('toolu_a', 'Review the parser', 'agent_1'), { text: 'Launched.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('review'), 'c1');
    await turnEnd(events);
    const from = events.length;
    await fake.last.engineTurn([{ text: 'The review is done.' }], { task_id: 'agent_1', tool_use_id: 'toolu_a', status: 'completed', summary: 'found 2 bugs' });
    await turnEnd(events, from);
    expect(changes(events.slice(from)).map((tasks) => tasks.map((t) => t.status))).toEqual([['finished'], []]);
  });

  it('cancel by interrupt: Stop ends the turn and the engine reports the background subagent stopped: cancelled', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[...agent('toolu_a', 'Review the parser', 'agent_1'), { text: 'Launched.' }], [{ hold: true }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('review'), 'c1');
    await turnEnd(events);
    const from = events.length;
    await adapter.turnStart(text('status?'), 'c2');
    await until(() => (fake.last.holdingNow ? true : undefined), 'the hold');
    await adapter.interrupt();
    expect((await turnEnd(events, from)).params).toEqual({ status: 'interrupted' });
    expect(latest(events)).toEqual([expect.objectContaining({ id: 'toolu_a', status: 'cancelled', endedAt: expect.any(Number) })]);
  });

  it('a run that dies takes its running tasks with it: failed, reported before agent/exited', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[...agent('toolu_a', 'Review the parser', 'agent_1'), { text: 'Launched.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('review'), 'c1');
    await turnEnd(events);
    fake.last.child!.kill('SIGKILL');
    await find(events, 'agent/exited');
    expect(latest(events)).toEqual([expect.objectContaining({ id: 'toolu_a', status: 'failed' })]);
    expect(methods(events).lastIndexOf('background/changed')).toBeLessThan(methods(events).indexOf('agent/exited'));
  });

  it('queued flag: a message carries its clientMessageId as the SDK uuid; the first reply stamped with it is input/taken', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[{ text: 'one' }], [{ text: 'two' }]] });
    await adapter.start(cwd, {});
    const id = randomUUID();
    await adapter.turnStart(text('hello'), id);
    await turnEnd(events);
    expect(fake.last.userMessages[0]!.uuid).toBe(id);
    expect(events.filter((e) => e.method === 'input/taken').map((e) => e.params)).toEqual([{ clientMessageId: id }]);
    // Taken before the reply text is shown.
    expect(methods(events).indexOf('input/taken')).toBeLessThan(methods(events).indexOf('item/completed'));
    // An id that is not a UUID is not sent as one, and nothing is reported for it.
    const from = events.length;
    await adapter.turnStart(text('again'), 'not-a-uuid');
    await turnEnd(events, from);
    expect(fake.last.userMessages[1]!.uuid).toBeUndefined();
    expect(events.slice(from).some((e) => e.method === 'input/taken')).toBe(false);
  });

  it('queued flag: a message held behind background tasks is taken when the engine answers it, not when it is pushed', async () => {
    const { fake, adapter, events, cwd } = rig({ turns: [[...agent('toolu_a', 'Review the parser', 'agent_1'), { text: 'Launched.' }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('review'), 'c1');
    await turnEnd(events);
    const played = fake.last.engineTurn([{ hold: true }, { text: 'Still reviewing.' }], null);
    await until(() => (fake.last.holdingNow ? true : undefined), 'the engine turn');
    const id = randomUUID();
    await adapter.turnStart(text('how is it going?'), id);
    await until(() => (fake.last.midTurn.length > 0 ? true : undefined), 'the message taken mid-turn');
    // A subagent's reply carrying the uuid does not count.
    fake.last.send({ ...assistant([{ type: 'text', text: 'sub' }], 'toolu_a').message, user_message_uuid: id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((e) => e.method === 'input/taken')).toBe(false);
    fake.last.release();
    await played;
    await find(events, 'input/taken');
    expect(events.filter((e) => e.method === 'input/taken').map((e) => e.params)).toEqual([{ clientMessageId: id }]);
  });
});

describe('ClaudeAdapter: a hung engine (fake timers)', () => {
  // Only setTimeout is faked: the fake query and the real child run on setImmediate and I/O.
  const TIMEOUT = 120_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Lets the fake and the child run (real I/O, no timers) until `check` holds; at most a few real seconds. */
  async function settle<T>(check: () => T | undefined, what: string): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = check();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const quiet = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const has = (events: AdapterEvent[], method: AdapterEvent['method'], from = 0) =>
    events.slice(from).find((e) => e.method === method);
  const exitedOf = (events: AdapterEvent[]) => has(events, 'agent/exited') as Extract<AdapterEvent, { method: 'agent/exited' }> | undefined;
  const watch = (fakeOptions: FakeClaudeOptions) => rig(fakeOptions, { requestTimeoutMs: TIMEOUT });
  const assistant = (content: unknown[]) => ({ message: { type: 'assistant', message: { id: `msg_${Math.random()}`, content }, parent_tool_use_id: null } });
  const toolResult = (id: string, toolUseResult?: unknown) => ({
    message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, parent_tool_use_id: null, tool_use_result: toolUseResult },
  });

  it('after a completed turn, a message the engine never answers ends the run: group signalled, error, agent/exited; the next turn resumes', async () => {
    const { fake, adapter, events, cwd, logs } = watch({ hang: [1] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('one'), 'c1');
    await settle(() => has(events, 'turn/completed'), 'the first turn');
    const sessionId = adapter.engineSessionId;
    const pid = adapter.pid!;
    const kill = vi.spyOn(process, 'kill');

    const from = events.length;
    await adapter.turnStart(text('status?'), 'c2');
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const exited = await settle(() => exitedOf(events), 'agent/exited');
    expect(exited.params.reason).toBe('Claude stopped responding (restarted): no output for 120 s after a message');
    expect(methods(events.slice(from))).toEqual(['status/changed', 'status/changed', 'agent/exited']);
    expect(events.at(-2)!.params).toEqual({ status: 'error' });
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGTERM');
    await settle(() => (fake.last.closed ? true : undefined), 'the query closed');
    await settle(() => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, 'the child gone');
    expect(logs).toContain('claude Claude stopped responding (restarted): no output for 120 s after a message');

    const next = events.length;
    await adapter.turnStart(text('again'), 'c3');
    expect(fake.queries).toHaveLength(2);
    expect(fake.last.options.resume).toBe(sessionId);
    expect((await settle(() => has(events, 'turn/completed', next), 'the resumed turn')).params).toEqual({ status: 'completed' });
  });

  it('a tool in progress keeps a silent engine alive; once the tool ends, silence fires the watchdog', async () => {
    const { fake, adapter, events, cwd, logs } = watch({
      turns: [[assistant([{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'pnpm test' } }]), { hold: true }, toolResult('toolu_long'), { hold: true }]],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('run the tests'), 'c1');
    await settle(() => (fake.last.holdingNow ? true : undefined), 'the long tool');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    expect(logs).toContain('claude silent for 120 s while a tool is in progress; still waiting');

    fake.last.release();
    await settle(() => has(events, 'item/completed'), 'the tool result');
    await settle(() => (fake.last.holdingNow ? true : undefined), 'the silence after the tool');
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect((await settle(() => exitedOf(events), 'agent/exited')).params.reason).toMatch(/^Claude stopped responding \(restarted\)/);
  });

  it('a waiting approval keeps a silent engine alive; after the answer, silence fires the watchdog', async () => {
    const { fake, adapter, events, cwd } = watch({ turns: [[{ tool: 'Bash', input: { command: 'ls' } }, { hold: true }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('list'), 'c1');
    const request = await settle(() => has(events, 'approval/request'), 'the approval');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();

    await adapter.resolveApproval(requestOf(request).requestId, 'accept');
    await settle(() => (fake.last.holdingNow ? true : undefined), 'the silence after the tool');
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await settle(() => exitedOf(events), 'agent/exited');
  });

  it('a waiting question counts like an approval', async () => {
    const questions = [{ question: 'Which?', header: 'Q', options: [{ label: 'a', description: '' }], multiSelect: false }];
    const { adapter, events, cwd } = watch({ turns: [[{ tool: 'AskUserQuestion', input: { questions } }]] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('ask'), 'c1');
    await settle(() => has(events, 'input/request'), 'the question');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
  });

  const BACKGROUND_QUIET = 600_000;
  const backgroundAgent = () => [
    assistant([{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'find downloads', prompt: 'find', run_in_background: true } }]),
    toolResult('toolu_agent', { status: 'async_launched', agentId: 'agent_7', description: 'find downloads' }),
    { text: 'Launched.' },
  ];

  it('a background task running: a message unanswered for backgroundQuietMs ends the run with the hang reason; shorter silence does not', async () => {
    const { adapter, events, cwd, logs } = watch({ hang: [1], turns: [backgroundAgent()] });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('look around'), 'c1');
    await settle(() => has(events, 'turn/completed'), 'the first turn');

    await adapter.turnStart(text('status?'), 'c2');
    await vi.advanceTimersByTimeAsync(BACKGROUND_QUIET - 1);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const exited = await settle(() => exitedOf(events), 'agent/exited');
    expect(exited.params.reason).toBe('Claude stopped responding (restarted): no output for 600 s after a message while 1 background task(s) run');
    expect(exited.params.reason.startsWith(HUNG)).toBe(true);
    expect(logs).toContain(`claude ${exited.params.reason}`);
  });

  it('backgroundQuietMs is configurable; a task-notification resets the silence and, the task settled, requestTimeoutMs applies again', async () => {
    const { fake, adapter, events, cwd } = rig({ hang: [1], turns: [backgroundAgent()] }, { requestTimeoutMs: TIMEOUT, backgroundQuietMs: 3 * TIMEOUT });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('look around'), 'c1');
    await settle(() => has(events, 'turn/completed'), 'the first turn');

    await adapter.turnStart(text('status?'), 'c2');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT - 1);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();

    // Matched by the agent id alone (no tool_use_id on the notification).
    fake.last.send({ type: 'system', subtype: 'task_notification', task_id: 'agent_7', status: 'completed', summary: 'found nothing', output_file: '/tmp/a' });
    await settle(() => has(events, 'item/completed', events.length - 1), 'the notification item');
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect((await settle(() => exitedOf(events), 'agent/exited')).params.reason).toBe('Claude stopped responding (restarted): no output for 120 s after a message');
  });

  it('a foreground tool in progress beside a background task keeps the engine alive past backgroundQuietMs', async () => {
    const { fake, adapter, events, cwd, logs } = watch({
      turns: [[...backgroundAgent().slice(0, 2), assistant([{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'pnpm test' } }]), { hold: true }]],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    await settle(() => (fake.last.holdingNow ? true : undefined), 'the long tool');
    await vi.advanceTimersByTimeAsync(2 * BACKGROUND_QUIET);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    expect(logs).toContain('claude silent for 120 s while a tool is in progress; still waiting');
  });

  it('a background Bash is tracked by its tool_use id; a foreground Agent and a failed launch are not', async () => {
    const { fake, adapter, events, cwd } = watch({
      hang: [1],
      turns: [
        [
          assistant([{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'inline', prompt: 'x' } }]),
          toolResult('toolu_fg', { status: 'completed', prompt: 'x' }),
          assistant([{ type: 'tool_use', id: 'toolu_bad', name: 'Bash', input: { command: 'nope', run_in_background: true } }]),
          { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bad', content: 'denied', is_error: true }] }, parent_tool_use_id: null } },
          // Auto-backgrounded: the input did not ask, the result says so.
          assistant([{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 600' } }]),
          toolResult('toolu_bg', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash_3' }),
          { text: 'Started.' },
        ],
      ],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    await settle(() => has(events, 'turn/completed'), 'the first turn');
    await adapter.turnStart(text('status?'), 'c2');
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    // An unrelated notification changes nothing; the matching tool_use id ends the hold.
    fake.last.send({ type: 'system', subtype: 'task_notification', task_id: 'other', status: 'completed', summary: '', output_file: '/tmp/o' });
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    fake.last.send({ type: 'system', subtype: 'task_notification', task_id: '', tool_use_id: 'toolu_bg', status: 'completed', summary: '', output_file: '/tmp/b' });
    await quiet();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await settle(() => exitedOf(events), 'agent/exited');
  });

  it('a message delivered mid-turn (no new system/init) with ongoing stream output is not killed; an idle engine is never watched', async () => {
    const { fake, adapter, events, cwd } = watch({});
    await adapter.start(cwd, {});
    const played = fake.last.engineTurn([{ hold: true }, { text: 'Done.' }]);
    await settle(() => (fake.last.holdingNow ? true : undefined), 'the engine turn');
    await adapter.turnStart(text('status?'), 'c1');
    await settle(() => (fake.last.midTurn.length > 0 ? true : undefined), 'the mid-turn message');
    for (let i = 0; i < 6; i += 1) {
      fake.last.send({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg_s${i}` } }, parent_tool_use_id: null });
      await quiet();
      await vi.advanceTimersByTimeAsync(TIMEOUT - 1_000);
    }
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
    fake.last.release();
    await played;
    await settle(() => has(events, 'turn/completed'), 'the turn end');
    await vi.advanceTimersByTimeAsync(10 * TIMEOUT);
    await quiet();
    expect(exitedOf(events)).toBeUndefined();
  });

  it('interrupt() on an engine that never answers settles within the timeout: the turn ends interrupted, then the run', async () => {
    const { fake, adapter, events, cwd } = watch({
      interruptHangs: true,
      // A tool in progress keeps the watchdog off: only the interrupt timeout can end this.
      turns: [[assistant([{ type: 'tool_use', id: 'toolu_find', name: 'Bash', input: { command: 'find ~/Downloads' } }]), { hold: true }]],
    });
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    await settle(() => (fake.last.holdingNow ? true : undefined), 'the hold');
    const pid = adapter.pid!;
    let outcome: unknown;
    const stopping = adapter.interrupt().then(
      () => (outcome = 'resolved'),
      (error: unknown) => (outcome = error),
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    await quiet();
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(outcome).toMatchObject({ code: 'agent_unavailable', message: expect.stringContaining('Claude stopped responding (restarted): Stop was not answered within 120 s') });
    const end = events.findIndex((e) => e.method === 'turn/completed');
    expect(events[end]!.params).toEqual({ status: 'interrupted' });
    expect(methods(events.slice(end))).toEqual(['turn/completed', 'status/changed', 'agent/exited']);
    await settle(() => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, 'the child gone');
  });
});

describe('ClaudeAdapter: background tasks when Stop is not answered (fake timers)', () => {
  const TIMEOUT = 120_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the run Stop ends takes its running tasks with it as cancelled', async () => {
    const { fake, adapter, events, cwd } = rig(
      {
        interruptHangs: true,
        turns: [
          [
            { message: { type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Review', prompt: 'x', run_in_background: true } }] }, parent_tool_use_id: null } },
            { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] }, parent_tool_use_id: null, tool_use_result: { status: 'async_launched', agentId: 'agent_1' } } },
            { hold: true },
          ],
        ],
      },
      { requestTimeoutMs: TIMEOUT },
    );
    await adapter.start(cwd, {});
    await adapter.turnStart(text('go'), 'c1');
    for (let i = 0; i < 500 && !fake.last.holdingNow; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const stopping = adapter.interrupt().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(await stopping).toMatchObject({ code: 'agent_unavailable' });
    const tasks = events.filter((e) => e.method === 'background/changed').map((e) => (e.params as { tasks: { status: string }[] }).tasks);
    expect(tasks.map((list) => list.map((t) => t.status))).toEqual([['running'], ['cancelled']]);
    expect(methods(events).lastIndexOf('background/changed')).toBeLessThan(methods(events).indexOf('agent/exited'));
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
