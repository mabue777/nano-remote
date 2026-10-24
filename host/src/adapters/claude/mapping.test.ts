import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STATIC_MODELS,
  childEnv,
  completeToolItem,
  decisionsFor,
  fileChangesFor,
  itemKind,
  permissionAnswer,
  questionAnswer,
  resultText,
  sessionModel,
  sessionPolicy,
  fitEffort,
  staticModels,
  toModels,
  toRequest,
  toTurnEnd,
  toUsage,
  toUserText,
  toolItem,
} from './mapping.js';

describe('childEnv', () => {
  it('strips the variables of a parent Claude Code session, keeps the rest and sets CLAUDE_CONFIG_DIR', () => {
    const env = childEnv(
      { configDir: '/Users/me/.config/claude', env: { EXTRA: '1' } },
      {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        CLAUDECODE: '1',
        CLAUDE_PID: '42',
        CLAUDE_EFFORT: 'high',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SSE_PORT: '1234',
        CLAUDE_CODE_OAUTH_TOKEN: 'token',
        CLAUDE_CONFIG_DIR: '/somewhere/else',
        ANTHROPIC_MODEL: 'x',
        UNSET: undefined,
      },
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      CLAUDE_CODE_OAUTH_TOKEN: 'token',
      CLAUDE_CONFIG_DIR: '/Users/me/.config/claude',
      ANTHROPIC_MODEL: 'x',
      EXTRA: '1',
    });
  });

  it('defaults to the host environment', () => {
    expect(childEnv({ configDir: '/c', env: {} }).PATH).toBe(process.env.PATH);
  });
});

describe('settings', () => {
  it('maps approvalMode onto a permission mode and reports what is in effect', () => {
    expect(sessionPolicy({ approvalMode: 'never' })).toEqual({ permissionMode: 'bypassPermissions', approvalMode: 'never' });
    expect(sessionPolicy({ approvalMode: 'acceptEdits' })).toEqual({ permissionMode: 'acceptEdits', approvalMode: 'acceptEdits' });
    expect(sessionPolicy({ approvalMode: 'plan' })).toEqual({ permissionMode: 'plan', approvalMode: 'plan' });
    expect(sessionPolicy({ approvalMode: 'untrusted' })).toEqual({ permissionMode: 'default', approvalMode: 'default' });
    expect(sessionPolicy({})).toEqual({ permissionMode: 'default', approvalMode: 'default' });
  });

  it('takes the model from the settings, else the configured default', () => {
    expect(sessionModel({ model: 'haiku' }, { defaultModel: 'opus' })).toBe('haiku');
    expect(sessionModel({ model: '' }, { defaultModel: 'opus' })).toBe('opus');
    expect(sessionModel({}, { defaultModel: 'opus' })).toBe('opus');
  });
});

describe('toUserText', () => {
  it('joins text, mentions as @path, images as their URL; data URLs are left out', () => {
    expect(
      toUserText([
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
        { type: 'mention', name: 'x', path: '/a/x.ts' },
        { type: 'image', url: '/v1/blob/abc' },
        { type: 'image', url: 'data:image/png;base64,AAAA' },
      ]),
    ).toBe('one\n\ntwo\n\n@/a/x.ts\n\n[image: /v1/blob/abc]\n\n[an image was attached, but this agent cannot receive images]');
  });
});

describe('file changes', () => {
  it('Write is add for a new file and modify for an existing one', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'nano-claude-map-'));
    writeFileSync(path.join(cwd, 'there.txt'), 'old');
    expect(fileChangesFor('Write', { file_path: 'new.txt', content: 'a\nb\n' }, cwd)).toEqual([
      { path: 'new.txt', kind: 'add', diff: '@@ -0,0 +1,2 @@\n+a\n+b' },
    ]);
    expect(fileChangesFor('Write', { file_path: path.join(cwd, 'there.txt'), content: '' }, cwd)).toEqual([
      { path: path.join(cwd, 'there.txt'), kind: 'modify', diff: '@@ -0,0 +0,0 @@' },
    ]);
    expect(fileChangesFor('Write', {}, cwd)[0]).toMatchObject({ path: '', kind: 'add' });
  });

  it('Edit, MultiEdit and NotebookEdit are modifies with their texts as hunks', () => {
    expect(fileChangesFor('Edit', { file_path: 'a', old_string: 'x\ny', new_string: 'z' }, '/')).toEqual([
      { path: 'a', kind: 'modify', diff: '@@ -1,2 +1,1 @@\n-x\n-y\n+z' },
    ]);
    expect(
      fileChangesFor('MultiEdit', { file_path: 'b', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '' }] }, '/'),
    ).toEqual([{ path: 'b', kind: 'modify', diff: '@@ -1,1 +1,1 @@\n-1\n+2\n@@ -1,1 +0,0 @@\n-3' }]);
    expect(fileChangesFor('MultiEdit', { file_path: 'b' }, '/')).toEqual([{ path: 'b', kind: 'modify', diff: '' }]);
    expect(fileChangesFor('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'print(1)' }, '/')).toEqual([
      { path: 'n.ipynb', kind: 'modify', diff: '@@ -0,0 +1,1 @@\n+print(1)' },
    ]);
  });
});

describe('items', () => {
  it('tool kinds', () => {
    expect(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'AskUserQuestion'].map(itemKind)).toEqual([
      'command',
      'fileChange',
      'fileChange',
      'fileChange',
      'fileChange',
      'toolCall',
      'toolCall',
    ]);
  });

  it('tool_use blocks start items; MCP tools name their server', () => {
    expect(toolItem({ id: 't1', name: 'Bash', input: { command: 'ls' } }, '/w')).toEqual({
      itemId: 't1',
      type: 'command',
      status: 'inProgress',
      command: 'ls',
      cwd: '/w',
      output: '',
    });
    expect(toolItem({ id: 't2', name: 'mcp__github__search', input: { q: 'x' } }, '/w')).toEqual({
      itemId: 't2',
      type: 'toolCall',
      status: 'inProgress',
      tool: 'mcp__github__search',
      server: 'github',
      arguments: { q: 'x' },
    });
    expect(toolItem({}, '/w')).toEqual({ itemId: '', type: 'toolCall', status: 'inProgress', tool: '', arguments: {} });
  });

  it('tool_result content is a string or text blocks', () => {
    expect(resultText('plain')).toBe('plain');
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(resultText(undefined)).toBe('');
  });

  it('tool results complete items; is_error fails them', () => {
    const command = toolItem({ id: 't', name: 'Bash', input: { command: 'ls' } }, '/w');
    expect(completeToolItem(command, { content: 'out', is_error: true })).toMatchObject({ status: 'failed', output: 'out' });
    const file = toolItem({ id: 't', name: 'Write', input: { file_path: 'x', content: 'y' } }, '/w');
    expect(completeToolItem(file, { content: 'done' })).toMatchObject({ type: 'fileChange', status: 'completed' });
    const call = toolItem({ id: 't', name: 'Read', input: {} }, '/w');
    expect(completeToolItem(call, { content: 'text' })).toMatchObject({ status: 'completed', result: 'text' });
    expect(completeToolItem(call, { content: 'boom', is_error: true })).toMatchObject({ status: 'failed', error: 'boom' });
  });
});

describe('requests and answers', () => {
  it('offers acceptForSession only with suggestions', () => {
    expect(decisionsFor([{ type: 'addRules' }])).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    expect(decisionsFor([])).toEqual(['accept', 'decline', 'cancel']);
    expect(decisionsFor(undefined)).toEqual(['accept', 'decline', 'cancel']);
  });

  it('a command without a description takes the SDK title as reason', () => {
    const { event } = toRequest('req_1', 'Bash', { command: 'ls' }, { toolUseID: 't', title: 'Claude wants to run ls', cwd: '/w' });
    expect(event.request).toMatchObject({ kind: 'command', reason: 'Claude wants to run ls' });
    const other = toRequest('req_2', 'Glob', {}, { toolUseID: 't', decisionReason: 'outside the folder', cwd: '/w' });
    expect(other.event.request).toMatchObject({ kind: 'permission', reason: 'outside the folder' });
  });

  it('questions without options or with odd input still map', () => {
    const mapped = toRequest('req_3', 'AskUserQuestion', { questions: [{}, 'junk'] }, { toolUseID: 't', cwd: '/w' });
    expect(mapped.event.request).toMatchObject({
      kind: 'input',
      questions: [
        { id: '0', header: '', question: '', isOther: true, isSecret: false },
        { id: '1', header: '', question: '', isOther: true, isSecret: false },
      ],
    });
    expect(mapped.questions).toEqual(['', '']);
    expect(toRequest('req_4', 'AskUserQuestion', {}, { toolUseID: 't', cwd: '/w' }).questions).toEqual([]);
  });

  it('decisions as permission answers', () => {
    const input = { command: 'ls' };
    expect(permissionAnswer('accept', input, [1])).toEqual({ behavior: 'allow', updatedInput: input });
    expect(permissionAnswer('acceptForSession', input, [1])).toEqual({ behavior: 'allow', updatedInput: input, updatedPermissions: [1] });
    expect(permissionAnswer('acceptForSession', input, undefined)).toEqual({ behavior: 'allow', updatedInput: input, updatedPermissions: [] });
    expect(permissionAnswer('decline', input, [])).toMatchObject({ behavior: 'deny' });
    expect(permissionAnswer('cancel', input, [])).toMatchObject({ behavior: 'deny', interrupt: true });
  });

  it('answers by index id become answers by question text; unknown ids are dropped', () => {
    expect(questionAnswer({ questions: [] }, ['Q one', 'Q two'], { '1': ['b'], '7': ['x'], other: ['y'], '0': [] })).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [], answers: { 'Q two': 'b', 'Q one': '' } },
    });
  });
});

describe('turn end, usage and models', () => {
  it('usage counts cached input; missing numbers are 0', () => {
    expect(toUsage({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 })).toEqual({
      inputTokens: 113,
      outputTokens: 5,
    });
    expect(toUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('result subtypes', () => {
    expect(toTurnEnd({ subtype: 'success', is_error: false }, false)).toEqual({ status: 'completed' });
    expect(toTurnEnd({ subtype: 'error_during_execution', is_error: true }, true)).toEqual({ status: 'interrupted' });
    expect(toTurnEnd({ subtype: 'error_max_budget_usd', errors: ['a', '', 'b'] }, false)).toEqual({
      status: 'failed',
      error: { code: 'error_max_budget_usd', message: 'a\nb' },
    });
    expect(toTurnEnd({ subtype: 'success', is_error: true, result: 'API Error: 500' }, false)).toEqual({
      status: 'failed',
      error: { code: 'agent_error', message: 'API Error: 500' },
    });
    expect(toTurnEnd({}, false)).toEqual({ status: 'failed', error: { code: 'error', message: 'the turn failed' } });
  });

  it('models: the default alias row is dropped and the configured default is marked', () => {
    const raw = [
      { value: 'default', displayName: 'Default' },
      { value: 'opus', displayName: 'Opus 5.5' },
      { value: 'sonnet' },
      { displayName: 'no value' },
    ];
    expect(toModels(raw, 'opus')).toEqual([
      { id: 'opus', displayName: 'Opus 5.5', default: true },
      { id: 'sonnet', displayName: 'sonnet', default: false },
    ]);
    expect(toModels(raw, 'nothing-matches').map((m) => m.default)).toEqual([true, false]);
    expect(toModels(undefined, 'opus')).toEqual([]);
  });

  it('models: supportedEffortLevels become efforts in Claude order, without a defaultEffort', () => {
    const raw = [
      { value: 'opus', supportsEffort: true, supportedEffortLevels: ['max', 'low', 'medium', 'high', 'xhigh'] },
      { value: 'claude-opus-4-6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max', 'turbo'] },
      { value: 'claude-haiku-4-5-20251001' },
      { value: 'off', supportsEffort: false, supportedEffortLevels: ['low'] },
    ];
    expect(toModels(raw, 'opus')).toEqual([
      { id: 'opus', displayName: 'opus', default: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-4-6', displayName: 'claude-opus-4-6', default: false, efforts: ['low', 'medium', 'high', 'max'] },
      { id: 'claude-haiku-4-5-20251001', displayName: 'claude-haiku-4-5-20251001', default: false },
      { id: 'off', displayName: 'off', default: false },
    ]);
  });

  it.each([
    ['unset', undefined, ['low', 'high'], undefined],
    ['not a Claude level', 'turbo', undefined, undefined],
    ['a model the list did not name', 'xhigh', undefined, 'xhigh'],
    ['a level the model has', 'medium', ['low', 'medium', 'high'], 'medium'],
    ['the highest level below', 'xhigh', ['low', 'medium', 'high', 'max'], 'high'],
    ['the lowest when none is below', 'low', ['high', 'max'], 'high'],
    ['a model without effort', 'low', [], undefined],
  ])('fitEffort: %s', (_name, requested, levels, expected) => {
    expect(fitEffort(requested, levels)).toBe(expected);
  });

  it('the static list marks the configured default', () => {
    expect(STATIC_MODELS.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(staticModels('sonnet').filter((m) => m.default).map((m) => m.id)).toEqual(['sonnet']);
  });
});
