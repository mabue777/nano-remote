import { describe, expect, it } from 'vitest';

import {
  approvalResponse,
  decisionsFrom,
  defaultModel,
  inputResponse,
  toFileChanges,
  toFinalStatus,
  toItem,
  toModels,
  toSessionStatus,
  toTurnError,
  toUsage,
  versionFrom,
} from './mapping.js';
import { FIELD_CHECK_MAPPED, FIELD_CHECK_USAGE } from './testing/token-usage-field-check.js';

describe('codex mapping', () => {
  it('maps every ThreadItem type onto the protocol items', () => {
    expect(toItem({ type: 'userMessage', id: 'u', content: [] }, true)).toBeUndefined();
    expect(toItem({ type: 'plan', id: 'p', text: '1. do' }, false)).toEqual({ itemId: 'p', type: 'plan', status: 'inProgress', text: '1. do' });
    expect(toItem({ type: 'reasoning', id: 'r', summary: ['a', 'b'], content: ['x', 'y'] }, true)).toEqual({
      itemId: 'r',
      type: 'reasoning',
      status: 'completed',
      summary: 'a\nb',
      text: 'x\ny',
    });
    expect(toItem({ type: 'reasoning', id: 'r' }, false)).toEqual({ itemId: 'r', type: 'reasoning', status: 'inProgress', summary: '' });
    expect(toItem({ type: 'commandExecution', id: 'c', command: 'ls', cwd: '/', status: 'failed' }, true)).toEqual({
      itemId: 'c',
      type: 'command',
      status: 'failed',
      command: 'ls',
      cwd: '/',
      output: '',
    });
    expect(
      toItem(
        { type: 'mcpToolCall', id: 'm', server: 'fs', tool: 'read', arguments: { p: 1 }, result: { ok: 1 }, error: { message: 'x' }, status: 'completed' },
        true,
      ),
    ).toEqual({ itemId: 'm', type: 'toolCall', status: 'completed', tool: 'read', server: 'fs', arguments: { p: 1 }, result: { ok: 1 }, error: { message: 'x' } });
    expect(toItem({ type: 'mcpToolCall', id: 'm', tool: 't', arguments: null, result: null, error: null }, false)).toEqual({
      itemId: 'm',
      type: 'toolCall',
      status: 'inProgress',
      tool: 't',
      arguments: {},
    });
    expect(toItem({ type: 'dynamicToolCall', id: 'd', tool: 'x', arguments: [1], contentItems: [{ t: 1 }] }, true)).toMatchObject({
      type: 'toolCall',
      arguments: {},
      result: [{ t: 1 }],
    });
    expect(toItem({ type: 'webSearch', id: 'w', query: 'q', results: [1] }, true)).toEqual({
      itemId: 'w',
      type: 'toolCall',
      status: 'completed',
      tool: 'webSearch',
      arguments: { query: 'q' },
      result: [1],
    });
    expect(toItem({ type: 'webSearch', id: 'w', query: 'q' }, false)).not.toHaveProperty('result');
    expect(toItem({ type: 'imageView', id: 'i', path: '/a.png' }, true)).toMatchObject({ tool: 'imageView', arguments: { path: '/a.png' } });
    expect(toItem(null, true)).toEqual({ itemId: '', type: 'other', status: 'completed', raw: {} });
    expect(toItem({ type: 'sleep', id: 's', status: 'weird' }, false)).toMatchObject({ type: 'other', status: 'inProgress' });
  });

  it('maps file changes: update is modify', () => {
    expect(
      toFileChanges([
        { path: 'a', kind: { type: 'add' }, diff: '+' },
        { path: 'b', kind: { type: 'delete' }, diff: '-' },
        { path: 'c', kind: { type: 'update', move_path: null }, diff: '~' },
        'junk',
      ]),
    ).toEqual([
      { path: 'a', kind: 'add', diff: '+' },
      { path: 'b', kind: 'delete', diff: '-' },
      { path: 'c', kind: 'modify', diff: '~' },
      { path: '', kind: 'modify', diff: '' },
    ]);
    expect(toFileChanges(undefined)).toEqual([]);
  });

  it('keeps only the string decisions the protocol knows', () => {
    expect(decisionsFrom(['accept', { acceptWithExecpolicyAmendment: {} }, 'cancel', 'bogus'])).toEqual(['accept', 'cancel']);
    expect(decisionsFrom(null)).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
  });

  it('builds approval and input responses', () => {
    expect(approvalResponse('item/commandExecution/requestApproval', 'decline', {})).toEqual({ decision: 'decline' });
    expect(approvalResponse('item/permissions/requestApproval', 'accept', {})).toEqual({ permissions: {}, scope: 'turn' });
    expect(approvalResponse('item/permissions/requestApproval', 'cancel', { permissions: { network: {} } })).toEqual({ permissions: {}, scope: 'turn' });
    expect(inputResponse({ a: ['1', '2'] })).toEqual({ answers: { a: { answers: ['1', '2'] } } });
  });

  it('maps thread statuses', () => {
    expect(toSessionStatus({ type: 'idle' })).toBe('idle');
    expect(toSessionStatus({ type: 'systemError' })).toBe('error');
    expect(toSessionStatus({ type: 'active', activeFlags: [] })).toBe('running');
    expect(toSessionStatus({ type: 'active' })).toBe('running');
    expect(toSessionStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waiting_input');
    expect(toSessionStatus({ type: 'active', activeFlags: ['waitingOnUserInput', 'waitingOnApproval'] })).toBe('waiting_approval');
    expect(toSessionStatus({ type: 'notLoaded' })).toBeUndefined();
    expect(toSessionStatus('idle')).toBeUndefined();
  });

  it('maps token usage, with the context window when known', () => {
    expect(toUsage({ total: { inputTokens: 10, outputTokens: 2 }, last: { totalTokens: 999 }, modelContextWindow: 1000 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      contextPercent: 99.9,
    });
    expect(toUsage({ last: { totalTokens: 5000 }, modelContextWindow: 1000 })).toEqual({ inputTokens: 0, outputTokens: 0, contextPercent: 100 });
    expect(toUsage({ total: { inputTokens: Number.NaN }, modelContextWindow: 0 })).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('maps the real field check notifications: totals from `total`, the context share from `last`', () => {
    expect(FIELD_CHECK_USAGE.map((n) => toUsage(n.params.tokenUsage))).toEqual(FIELD_CHECK_MAPPED);
    // Input doubled across the turns while the context stayed at 1.7%: `total` sums every request,
    // `last` is the one request that fills the window. From `total` it would read 6.7%.
    const final = FIELD_CHECK_USAGE[3].params.tokenUsage;
    expect(Math.round((final.total.totalTokens / final.modelContextWindow) * 1000) / 10).toBe(6.7);
    expect(toUsage(final).contextPercent).toBe(1.7);
  });

  it('maps turn ends and errors', () => {
    expect(toFinalStatus('interrupted')).toBe('interrupted');
    expect(toFinalStatus('failed')).toBe('failed');
    expect(toFinalStatus('completed')).toBe('completed');
    expect(toFinalStatus('inProgress')).toBe('completed');
    expect(toTurnError(undefined)).toEqual({ code: 'agent_error', message: 'the turn failed' });
    expect(toTurnError({ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 500 } } })).toEqual({
      code: 'responseStreamDisconnected',
      message: 'x',
    });
  });

  it('maps models and picks the default', () => {
    const models = toModels([
      { id: 'a', displayName: 'A', isDefault: false },
      { id: 'b', isDefault: true },
      { id: 'h', hidden: true },
      { displayName: 'no id' },
    ]);
    expect(models).toEqual([
      { id: 'a', displayName: 'A', default: false },
      { id: 'b', displayName: 'b', default: true },
    ]);
    expect(defaultModel(models)).toBe('b');
    expect(defaultModel([models[0]!])).toBe('a');
    expect(defaultModel([])).toBeUndefined();
    expect(toModels(undefined)).toEqual([]);
  });

  it('reads the engine version from the userAgent', () => {
    expect(versionFrom('codex_cli_rs/0.163.0-alpha.10.2 (Mac OS 26.0.0; arm64) vscode/1.0')).toBe('0.163.0-alpha.10.2');
    expect(versionFrom('something else')).toBeUndefined();
  });
});
