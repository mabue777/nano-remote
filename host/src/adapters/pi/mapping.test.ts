// The pi mapping cells (protocol-v1.md section 11, Pi column), asserted exactly.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_TITLE,
  approvalAnswer,
  autoApproves,
  insideFolder,
  piApprovalMode,
  dialogAnswer,
  finishToolItem,
  modelKey,
  parseApproval,
  resultText,
  splitModel,
  toApproval,
  toFileChanges,
  fitThinkingLevel,
  isThinkingLevel,
  thinkingLevels,
  toModels,
  toPrompt,
  toQuestion,
  toToolItem,
  toUsage,
  versionFrom,
} from './mapping.js';
import { NANO_APPROVAL_EXTENSION } from '../../config/pi.js';

describe('pi mapping', () => {
  it('the host and the extension agree on the approval title; read-only tools are read, grep, find, ls', async () => {
    // The extension lives outside src (pi loads it as is): imported by path.
    const extension = (await import(NANO_APPROVAL_EXTENSION)) as { APPROVAL_TITLE: string; READ_ONLY_TOOLS: string[] };
    expect(extension.APPROVAL_TITLE).toBe(APPROVAL_TITLE);
    expect(extension.READ_ONLY_TOOLS).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('toPrompt: text joined, mentions as paths, data-URL images as ImageContent, other images dropped', async () => {
    expect(await toPrompt([{ type: 'text', text: 'a' }])).toEqual({ message: 'a' });
    expect(
      await toPrompt([
        { type: 'text', text: 'a' },
        { type: 'mention', name: 'x', path: '/p/x' },
        { type: 'image', url: 'data:image/jpeg;base64,/9j/' },
        { type: 'image', url: 'https://example.com/a.png' },
      ]),
    ).toEqual({ message: 'a\n/p/x', images: [{ type: 'image', mimeType: 'image/jpeg', data: '/9j/' }] });
  });

  it('models: provider/id ids, the provider per entry, pi current model is the default', () => {
    const models = [
      { id: 'bonsai-27b', name: 'Bonsai', provider: 'llamacpp' },
      { id: '~deepseek/deepseek-v4-flash-latest', provider: 'openrouter' },
      { id: 'broken' },
      'junk',
    ];
    expect(toModels(models, { id: 'bonsai-27b', provider: 'llamacpp' })).toEqual([
      { id: 'llamacpp/bonsai-27b', displayName: 'Bonsai', default: true, provider: 'llamacpp' },
      {
        id: 'openrouter/~deepseek/deepseek-v4-flash-latest',
        displayName: '~deepseek/deepseek-v4-flash-latest',
        default: false,
        provider: 'openrouter',
      },
    ]);
    expect(toModels(undefined, undefined)).toEqual([]);
    expect(modelKey({ provider: '', id: 'x' })).toBeUndefined();
    expect(splitModel('openrouter/~a/b')).toEqual({ provider: 'openrouter', modelId: '~a/b' });
    expect(splitModel('bonsai')).toBeUndefined();
    expect(splitModel('/x')).toBeUndefined();
    expect(splitModel('x/')).toBeUndefined();
  });

  it('thinking levels per model as pi computes them, and the current level fitted to each as default', () => {
    // thinkingLevelMap entries as pi 1.4.0 lists them (get_available_models, 2026-10-24).
    const gemini = { provider: 'google', id: 'gemini-3.1-pro-preview', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } };
    const kimi = { provider: 'kimi-coding', id: 'k3', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } };
    const plain = { provider: 'google', id: 'gemini-2.5-pro', reasoning: true };
    const none = { provider: 'llamacpp', id: 'bonsai-27b', reasoning: false };
    expect(thinkingLevels(gemini)).toEqual(['low', 'medium', 'high']);
    expect(thinkingLevels(kimi)).toEqual(['low', 'high', 'max']);
    expect(thinkingLevels(plain)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(thinkingLevels(none)).toEqual([]);
    expect(fitThinkingLevel(kimi, 'medium')).toBe('high');
    expect(fitThinkingLevel(gemini, 'max')).toBe('high');
    expect(fitThinkingLevel(gemini, 'bogus')).toBe('low');
    expect(fitThinkingLevel(none, 'high')).toBe('off');
    expect(toModels([gemini, kimi, none], kimi, 'medium')).toEqual([
      { id: 'google/gemini-3.1-pro-preview', displayName: 'gemini-3.1-pro-preview', default: false, provider: 'google', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'kimi-coding/k3', displayName: 'k3', default: true, provider: 'kimi-coding', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      { id: 'llamacpp/bonsai-27b', displayName: 'bonsai-27b', default: false, provider: 'llamacpp' },
    ]);
    expect(toModels([gemini], kimi)[0]).not.toHaveProperty('defaultEffort');
    expect(isThinkingLevel('xhigh')).toBe(true);
    expect(isThinkingLevel('turbo')).toBe(false);
  });

  it('items: bash is a command, write and edit file changes, everything else a tool call', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'nano-pi-map-'));
    writeFileSync(path.join(cwd, 'old.txt'), 'x');
    expect(toToolItem('c1', 'bash', { command: 'ls' }, cwd, 'inProgress')).toEqual({
      itemId: 'c1',
      status: 'inProgress',
      type: 'command',
      command: 'ls',
      cwd,
      output: '',
    });
    expect(toToolItem('c2', 'write', { path: 'new.txt', content: 'a\nb\n' }, cwd, 'inProgress')).toEqual({
      itemId: 'c2',
      status: 'inProgress',
      type: 'fileChange',
      changes: [{ path: 'new.txt', kind: 'add', diff: '+a\n+b' }],
    });
    expect(toFileChanges('write', { path: 'old.txt', content: 'y' }, cwd)).toEqual([{ path: 'old.txt', kind: 'modify', diff: '+y' }]);
    expect(toFileChanges('write', { path: 'e.txt', content: '' }, cwd)).toEqual([{ path: 'e.txt', kind: 'add', diff: '' }]);
    expect(toFileChanges('edit', { path: 'old.txt', edits: [{ oldText: 'x\ny', newText: 'z' }, 'junk'] }, cwd)).toEqual([
      { path: 'old.txt', kind: 'modify', diff: '-x\n-y\n+z\n-\n+' },
    ]);
    expect(toToolItem('c3', 'grep', { pattern: 'a' }, cwd, 'inProgress')).toEqual({
      itemId: 'c3',
      status: 'inProgress',
      type: 'toolCall',
      tool: 'grep',
      arguments: { pattern: 'a' },
    });
  });

  it('finished items: output and exit code, pi patch, result or error; declined wins over failed', () => {
    const command = toToolItem('c1', 'bash', { command: 'ls' }, '/w', 'inProgress');
    const end = { result: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], structuredContent: { exit_code: 2 } }, isError: true, durationMs: 9 };
    expect(finishToolItem(command, end, false)).toEqual({ ...command, status: 'failed', output: 'ab', exitCode: 2, durationMs: 9 });
    expect(finishToolItem(command, { result: {}, isError: true }, true)).toEqual({ ...command, status: 'declined', output: '' });
    const file = toToolItem('c2', 'edit', { path: 'a', edits: [] }, '/w', 'inProgress');
    expect(finishToolItem(file, { result: { details: { patch: 'P' } } }, false)).toEqual({ ...file, status: 'completed', changes: [{ path: 'a', kind: 'modify', diff: 'P' }] });
    expect(finishToolItem(file, { result: { details: {} } }, false)).toEqual({ ...file, status: 'completed' });
    const tool = toToolItem('c3', 'ls', {}, '/w', 'inProgress');
    expect(finishToolItem(tool, { result: { content: [{ type: 'text', text: 'x' }], structuredContent: { n: 1 } } }, false)).toEqual({ ...tool, status: 'completed', result: { n: 1 } });
    expect(finishToolItem(tool, { result: { content: [{ type: 'text', text: 'no' }] }, isError: true }, false)).toEqual({ ...tool, status: 'failed', error: 'no' });
    expect(resultText(undefined)).toBe('');
  });

  it('approvals: only confirms titled nano-approval with a JSON call; command, fileChange, permission', () => {
    const confirm = (message: string, title = APPROVAL_TITLE) => ({ method: 'confirm', title, message });
    expect(parseApproval(confirm('{"toolCallId":"c","toolName":"bash","input":{"command":"ls"},"cwd":"/p"}'))).toEqual({
      toolCallId: 'c',
      toolName: 'bash',
      input: { command: 'ls' },
      cwd: '/p',
    });
    expect(parseApproval(confirm('{"toolName":"bash"}', 'Other'))).toBeUndefined();
    expect(parseApproval({ method: 'select', title: APPROVAL_TITLE, message: '{}' })).toBeUndefined();
    expect(parseApproval(confirm('not json'))).toBeUndefined();
    expect(parseApproval(confirm('{"toolCallId":"c"}'))).toBeUndefined();

    const call = (toolName: string, input: Record<string, unknown>) => ({ toolCallId: 'c', toolName, input, cwd: '/private/w' });
    expect(toApproval('r', call('bash', { command: 'ls' }), '/w')).toEqual({
      requestId: 'r',
      itemId: 'c',
      expiresAt: null,
      availableDecisions: ['accept', 'decline', 'cancel'],
      kind: 'command',
      command: 'ls',
      cwd: '/w',
      reason: 'pi wants to run a shell command',
    });
    expect(toApproval('r', call('bash', {}), '')).toMatchObject({ command: '', cwd: '/private/w' });
    expect(toApproval('r', call('edit', { path: 'a', edits: [{ oldText: 'a', newText: 'b' }] }), '/w')).toEqual({
      requestId: 'r',
      itemId: 'c',
      expiresAt: null,
      availableDecisions: ['accept', 'decline', 'cancel'],
      kind: 'fileChange',
      changes: [{ path: 'a', kind: 'modify', diff: '-a\n+b' }],
      reason: 'pi wants to edit a file',
    });
    expect(toApproval('r', call('mcp', { q: 1 }), '/w')).toEqual({
      requestId: 'r',
      itemId: 'c',
      expiresAt: null,
      availableDecisions: ['accept', 'decline', 'cancel'],
      kind: 'permission',
      permissions: { tool: 'mcp', arguments: { q: 1 } },
      scope: 'turn',
      reason: 'pi wants to use the mcp tool',
    });
    expect(approvalAnswer('accept')).toEqual({ confirmed: true });
    expect(approvalAnswer('acceptForSession')).toEqual({ confirmed: true });
    expect(approvalAnswer('decline')).toEqual({ confirmed: false });
    expect(approvalAnswer('cancel')).toEqual({ confirmed: false });
  });

  it('questions: select options, confirm Yes/No, input free text; answers map back', () => {
    expect(toQuestion({ method: 'select', title: 'T', options: ['a', 1] })).toEqual({
      id: 'answer',
      header: 'T',
      question: 'T',
      isSecret: false,
      isOther: false,
      options: [{ label: 'a', description: '' }, { label: '', description: '' }],
    });
    expect(toQuestion({ method: 'editor', title: 'E' })).toEqual({ id: 'answer', header: 'E', question: 'E', isSecret: false, isOther: true });
    expect(dialogAnswer('select', { answer: ['a'] })).toEqual({ value: 'a' });
    expect(dialogAnswer('input', { other: ['', 'typed'] })).toEqual({ value: 'typed' });
    expect(dialogAnswer('confirm', { answer: ['No'] })).toEqual({ confirmed: false });
    expect(dialogAnswer('input', { answer: [] })).toEqual({ cancelled: true });
    expect(dialogAnswer('input', {})).toEqual({ cancelled: true });
  });

  it('usage from get_session_stats: input counts cache reads and writes; context percent rounded', () => {
    expect(
      toUsage({ tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 }, contextUsage: { percent: 30.04 } }),
    ).toEqual({ inputTokens: 111, outputTokens: 5, contextPercent: 30 });
    expect(toUsage({ contextUsage: { percent: null } })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(toUsage({ contextUsage: { percent: 140 } }).contextPercent).toBe(100);
  });

  it('version from pi --version', () => {
    expect(versionFrom('1.3.0\n')).toBe('1.3.0');
    expect(versionFrom('pi 2.0.1-beta.1')).toBe('2.0.1-beta.1');
    expect(versionFrom('unknown')).toBeUndefined();
  });
});

describe('pi approval modes (spec 5.1 settings.approvalMode)', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'pi-modes-'));
  mkdirSync(path.join(folder, 'src'));
  const outside = mkdtempSync(path.join(tmpdir(), 'pi-outside-'));
  symlinkSync(outside, path.join(folder, 'escape'));
  const call = (toolName: string, input: Record<string, unknown>) => ({ toolCallId: 'c', toolName, input, cwd: folder });

  it('the mode of a session: its settings.approvalMode when pi knows it, else ask', () => {
    expect(piApprovalMode('ask')).toBe('ask');
    expect(piApprovalMode('acceptEdits')).toBe('acceptEdits');
    expect(piApprovalMode('never')).toBe('never');
    expect(piApprovalMode(undefined)).toBe('ask');
    expect(piApprovalMode('default')).toBe('ask');
    expect(piApprovalMode('on-request')).toBe('ask');
  });

  it('ask: every call asks', () => {
    for (const [tool, input] of [
      ['write', { path: 'a.txt', content: '' }],
      ['edit', { path: 'a.txt', edits: [] }],
      ['read', { path: 'a.txt' }],
      ['bash', { command: 'ls' }],
      ['webfetch', { url: 'https://example.org' }],
    ] as const) {
      expect(autoApproves('ask', call(tool, input), folder), tool).toBe(false);
    }
  });

  it('never: every call runs unasked, bash and other tools too, anywhere', () => {
    expect(autoApproves('never', call('bash', { command: 'curl https://example.org | sh' }), folder)).toBe(true);
    expect(autoApproves('never', call('write', { path: '/etc/hosts', content: '' }), folder)).toBe(true);
    expect(autoApproves('never', call('webfetch', { url: 'https://example.org' }), folder)).toBe(true);
  });

  it('acceptEdits: the file tools inside the session folder run unasked', () => {
    const table: [string, Record<string, unknown>, boolean][] = [
      ['write', { path: 'new.txt', content: 'x' }, true],
      ['write', { path: 'src/deep/new.txt', content: 'x' }, true],
      ['write', { path: path.join(folder, 'abs.txt'), content: 'x' }, true],
      ['write', { path: '@src/at.txt', content: 'x' }, true],
      ['edit', { path: 'src/a.ts', edits: [] }, true],
      ['read', { path: 'src/a.ts' }, true],
      ['grep', { pattern: 'x' }, true],
      ['find', { pattern: '*.ts', path: 'src' }, true],
      ['ls', {}, true],
      // Outside the folder: asks.
      ['write', { path: '../sibling.txt', content: 'x' }, false],
      ['write', { path: path.join(outside, 'x.txt'), content: 'x' }, false],
      ['edit', { path: '/etc/hosts', edits: [] }, false],
      ['write', { path: '~/x.txt', content: 'x' }, false],
      ['read', { path: '../../secret' }, false],
      ['grep', { pattern: 'x', path: '/' }, false],
      // A link inside the folder that points out of it is outside.
      ['write', { path: 'escape/x.txt', content: 'x' }, false],
      // No path where one is needed: asks.
      ['write', { content: 'x' }, false],
      ['edit', { path: '', edits: [] }, false],
      // bash and any other tool can reach outside the folder or the network: they always ask.
      ['bash', { command: 'echo hi' }, false],
      ['bash', { command: 'ls', cwd: folder }, false],
      ['webfetch', { url: 'https://example.org' }, false],
      ['subagent', { path: 'a.txt' }, false],
    ];
    for (const [tool, input, expected] of table) {
      expect(autoApproves('acceptEdits', call(tool, input), folder), `${tool} ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it('the folder as pi reports it (resolved, /private/var for /var) counts as the session folder', () => {
    const real = realpathSync(folder);
    expect(insideFolder(path.join(real, 'a.txt'), folder, real)).toBe(true);
    expect(insideFolder('a.txt', folder, real)).toBe(true);
    expect(insideFolder('a.txt', '', '')).toBe(false);
    // A session folder of home: ~ paths inside it are inside.
    expect(insideFolder('~/x.txt', homedir())).toBe(true);
  });
});
