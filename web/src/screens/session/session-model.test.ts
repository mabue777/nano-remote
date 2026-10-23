import { describe, expect, it, vi } from 'vitest';

import { FakeTransport, rpcError, settle } from '../../../test/replica-doubles';
import { SID, agentItem, approval, ev, inputRequest, session, snapshot, summary, turn, userItem } from '../../../test/replica-fixtures';
import { Replica } from '../../replica/replica';
import type { Item, TurnView } from '../../replica/types';
import type { AgentsSource } from '../capabilities';
import {
  commandSummary,
  formatDuration,
  itemRow,
  NO_STEER_NOTE,
  oneLine,
  sendErrorText,
  SessionModel,
  taskStateOf,
  turnRow,
  unwrapShell,
  usageLine,
} from './session-model';

/* eslint-disable @typescript-eslint/no-explicit-any */

function command(over: Record<string, unknown> = {}): any {
  return { itemId: 'c1', type: 'command', turnId: 't1', status: 'inProgress', command: '/bin/zsh -lc "echo hello > hello.txt"', cwd: '/w', output: '', ...over };
}

async function setup(options: { open?: boolean; turns?: any[]; over?: Record<string, unknown>; agents?: AgentsSource } = {}) {
  const client = new FakeTransport();
  client.rule('session/list', () => ({ sessions: [summary({ title: 'Listed title', cwd: '/Users/me/Desktop/phone-test' })] }));
  client.rule('session/close', () => ({ ok: true }));
  let n = 0;
  const replica = new Replica({ client, storage: null, newClientMessageId: () => `cm-${++n}`, now: () => 100 });
  client.goReady();
  await settle();
  const model = new SessionModel({ sessionId: SID, replica, ...(options.agents ? { agents: options.agents } : {}) });
  const changes = vi.fn();
  model.subscribe(changes);
  if (options.open !== false) {
    model.start();
    client.last('session/open').resolve(snapshot(options.turns?.length ? 10 : 0, options.turns ?? [], options.over ?? {}));
    await settle();
  }
  /** Delivers live events after the cursor, numbering them from `from`. */
  const live = (from: number, events: [string, Record<string, unknown>][]) =>
    events.forEach(([method, params], i) => client.notify(method, ev(from + i, method, params).params));
  return { client, replica, model, changes, live };
}

describe('helpers', () => {
  it('unwrapShell drops the shell wrapper adapters report, and keeps plain commands', () => {
    expect(unwrapShell('/bin/zsh -lc "echo hello > hello.txt"')).toBe('echo hello > hello.txt');
    expect(unwrapShell("bash -c 'ls -la'")).toBe('ls -la');
    expect(unwrapShell('/bin/sh -c "echo \\"hi\\""')).toBe('echo "hi"');
    expect(unwrapShell('  git status ')).toBe('git status');
  });

  it('oneLine keeps the first non-empty line and cuts long ones', () => {
    expect(oneLine('\nfirst\nsecond')).toBe('first …');
    expect(oneLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(oneLine('')).toBe('');
  });

  it('formatDuration: ms, s, min', () => {
    expect(formatDuration(42)).toBe('42 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });

  it('commandSummary: the command, then exit code and duration once known', () => {
    expect(commandSummary(command())).toBe('echo hello > hello.txt');
    expect(commandSummary(command({ status: 'completed', exitCode: 0, durationMs: 42 }))).toBe('echo hello > hello.txt · exit 0 · 42 ms');
  });

  it('usageLine with and without the context share', () => {
    expect(usageLine({ inputTokens: 1200, outputTokens: 340, contextPercent: 4 })).toBe('Session total 1,200 in · 340 out · context 4% full');
    expect(usageLine({ inputTokens: 5, outputTokens: 6 })).toBe('Session total 5 in · 6 out');
  });

  it('sendErrorText maps codes to copy and falls back to the message, then a generic line', () => {
    for (const code of ['session_busy', 'turn_mismatch', 'not_found', 'agent_unavailable', 'not_supported', 'rate_limited', 'connection_lost', 'timeout', 'unauthorized']) {
      expect(sendErrorText(code, 'raw')).not.toBe('raw');
    }
    expect(sendErrorText('internal', 'boom')).toBe('boom');
    expect(sendErrorText('internal', '')).toBe('The host refused the message.');
    expect(sendErrorText('internal')).toBe('The host refused the message.');
  });

  it('itemRow covers every item type, and unknown types as other', () => {
    const base = { turnId: 't1', status: 'completed' };
    expect(
      itemRow({ ...base, itemId: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hi' }, { type: 'mention', name: 'a.ts', path: '/a.ts' }, { type: 'image', url: 'data:' }] } as Item, false),
    ).toEqual({ kind: 'user', itemId: 'u', text: 'hi\n@a.ts', attachments: 1 });
    expect(itemRow(agentItem('a', 't1', 'yo'), false)).toEqual({ kind: 'agent', itemId: 'a', text: 'yo', streaming: true });
    expect(itemRow({ ...base, itemId: 'r', type: 'reasoning', summary: 'Thinking' } as Item, true)).toEqual({
      kind: 'reasoning', itemId: 'r', summary: 'Thinking', text: '', expanded: true, streaming: false,
    });
    expect(itemRow(command(), false)).toMatchObject({ kind: 'command', state: 'Running', tone: 'busy' });
    expect(itemRow(command({ status: 'completed', exitCode: 0, output: 'ok' }), false)).toMatchObject({ state: 'Done', tone: 'ok', output: 'ok' });
    expect(itemRow(command({ status: 'completed', exitCode: 2 }), false)).toMatchObject({ state: 'Failed', tone: 'error' });
    expect(itemRow(command({ status: 'failed' }), false)).toMatchObject({ state: 'Failed', tone: 'error' });
    expect(itemRow(command({ status: 'declined' }), false)).toMatchObject({ state: 'Declined', tone: 'muted' });
    expect(
      itemRow({ ...base, itemId: 'f', type: 'fileChange', changes: [{ path: 'a.txt', kind: 'add', diff: '+' }, { path: 'b.txt', kind: 'delete', diff: '' }] } as Item, false),
    ).toEqual({ kind: 'fileChange', itemId: 'f', files: [{ path: 'a.txt', kind: 'add' }, { path: 'b.txt', kind: 'delete' }], state: 'Done', tone: 'ok' });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'search', arguments: {} } as Item, false)).toEqual({
      kind: 'tool', itemId: 't', summary: 'search', state: 'Done', tone: 'ok',
    });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'read', server: 'fs', arguments: {}, error: { message: 'denied' } } as Item, false)).toMatchObject({
      summary: 'fs/read', state: 'Failed', error: 'denied',
    });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'x', server: '', arguments: {}, error: 'nope' } as Item, false)).toMatchObject({ summary: 'x', error: 'nope' });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'x', arguments: {}, error: { code: 3 } } as Item, false)).toMatchObject({ error: '{"code":3}' });
    expect(itemRow({ ...base, itemId: 'p', type: 'plan', text: '1. do' } as Item, false)).toEqual({ kind: 'plan', itemId: 'p', text: '1. do' });
    expect(itemRow({ ...base, itemId: 'o', type: 'other', raw: {} } as Item, false)).toEqual({ kind: 'other', itemId: 'o', label: 'Other activity' });
    expect(itemRow({ ...base, itemId: 'n', type: 'imageGeneration' } as unknown as Item, false)).toEqual({ kind: 'other', itemId: 'n', label: 'imageGeneration' });
  });

  it('turnRow: labels by status, inline error of a failed turn, missing items skipped, refused sends', () => {
    const items = { i1: agentItem('i1', 't1', 'x') };
    const none = new Set<string>();
    const make = (over: Partial<TurnView>): TurnView => ({ ...turn('t1'), items: ['i1', 'gone'], ...over });
    expect(turnRow(make({}), items, none)).toMatchObject({ label: 'Working…', tone: 'busy', items: [{ kind: 'agent' }] });
    expect(turnRow(make({}), items, none).items[0]).toMatchObject({ streaming: true });
    expect(turnRow(make({ status: 'completed' }), items, none)).toMatchObject({ label: '', tone: 'ok', items: [{ streaming: false }] });
    expect(turnRow(make({ status: 'interrupted' }), items, none)).toMatchObject({ label: 'Interrupted' });
    expect(turnRow(make({ status: 'failed', error: { code: 'internal', message: 'model crashed' } }), items, none)).toMatchObject({ label: 'Failed', error: 'model crashed' });
    expect(turnRow(make({ status: 'failed', error: { code: 'internal', message: '' } }), items, none).error).toBe('internal');
    expect(turnRow(make({ status: 'failed' }), items, none).error).toBeUndefined();
    expect(turnRow(make({ status: 'sending', optimistic: { clientMessageId: 'cm' } }), items, none)).toMatchObject({
      label: 'Sending…', send: { clientMessageId: 'cm', busy: false },
    });
    const busy = turnRow(make({ status: 'failed_to_send', optimistic: { clientMessageId: 'cm', error: { code: 'session_busy', message: 'x' } } }), items, none);
    expect(busy).toMatchObject({ label: 'Not sent', send: { busy: true, failure: 'The agent is busy with another turn.' } });
  });
});

describe('SessionModel: what the screen shows', () => {
  it('before the open: the list row gives title, folder, status and pending; start opens once', async () => {
    const { client, model } = await setup({ open: false });
    expect(model.view).toBeUndefined();
    expect(model.turns).toEqual([]);
    expect(model.runningTurnId).toBeUndefined();
    expect(model.title).toBe('Listed title');
    expect(model.folder).toEqual({ name: 'phone-test', path: '/Users/me/Desktop/phone-test' });
    expect(model.agentId).toBe('codex');
    expect(model.status).toMatchObject({ label: 'Idle', status: 'idle' });
    expect(model.pending).toEqual({ approvals: 0, inputs: 0, total: 0 });
    model.start();
    model.start();
    expect(client.count('session/open')).toBe(1);
    expect(model.loaded).toBe(false);
  });

  it('bypass: the header marker follows Session.settings.approvalMode never', async () => {
    const plain = await setup();
    expect(plain.model.bypass).toBe(false);
    const bypassed = await setup({ over: { session: session({ lastSeq: 0, settings: { approvalMode: 'never', sandbox: 'danger-full-access' } }) } });
    expect(bypassed.model.bypass).toBe(true);
    const asking = await setup({ over: { session: session({ lastSeq: 0, settings: { approvalMode: 'on-request' } }) } });
    expect(asking.model.bypass).toBe(false);
  });

  it('model: the header names the model and provider from Session.settings.model', async () => {
    expect((await setup({ over: { session: session({ lastSeq: 0, settings: {} }) } })).model.model).toBeUndefined();
    const pi = await setup({ over: { session: session({ lastSeq: 0, agentId: 'pi', settings: { model: 'llamacpp/bonsai-27b' } }) } });
    expect(pi.model.model).toBe('bonsai-27b · llamacpp');
    const codex = await setup({ over: { session: session({ lastSeq: 0, settings: { model: 'gpt-5.5-codex' } }) } });
    expect(codex.model.model).toBe('gpt-5.5-codex');
  });

  it('an unknown session shows placeholders; a failed open shows why', async () => {
    const client = new FakeTransport();
    const replica = new Replica({ client, storage: null });
    const model = new SessionModel({ sessionId: 'ses_x', replica });
    expect(model.title).toBe('Session');
    expect(model.folder).toBeUndefined();
    expect(model.usage).toBeUndefined();
    model.start();
    client.last('session/open').reject(rpcError('not_found'));
    await settle();
    expect(model.openError).toBe('Could not open the session: not_found');
    model.dispose();
  });

  it('turns grow live from deltas; status pill from status/changed; usage from usage/updated; reasoning toggles', async () => {
    const { model, live, changes } = await setup();
    expect(model.loaded).toBe(true);
    expect(model.openError).toBeUndefined();
    live(1, [
      ['turn/started', { turn: turn('t1') }],
      ['item/started', { turnId: 't1', item: userItem('u1', 't1') }],
      ['status/changed', { status: 'running' }],
      ['item/started', { turnId: 't1', item: agentItem('a1', 't1') }],
      ['item/delta', { turnId: 't1', itemId: 'a1', field: 'text', delta: 'Hel' }],
    ]);
    expect(model.status).toMatchObject({ label: 'Working', tone: 'busy' });
    expect(model.runningTurnId).toBe('t1');
    expect(model.mode).toBe('steer');
    expect(model.turns[0]!.items).toEqual([
      { kind: 'user', itemId: 'u1', text: 'hi', attachments: 0 },
      { kind: 'agent', itemId: 'a1', text: 'Hel', streaming: true },
    ]);
    live(6, [
      ['item/delta', { turnId: 't1', itemId: 'a1', field: 'text', delta: 'lo' }],
      ['item/started', { turnId: 't1', item: { itemId: 'r1', type: 'reasoning', turnId: 't1', status: 'completed', summary: 'Plan', text: 'long' } }],
      ['usage/updated', { usage: { inputTokens: 1200, outputTokens: 340, contextPercent: 4 } }],
      ['turn/completed', { turn: turn('t1', { status: 'completed', completedAt: 20, items: ['u1', 'a1', 'r1'] }) }],
      ['status/changed', { status: 'idle' }],
    ]);
    expect(model.turns[0]!.items[1]).toMatchObject({ text: 'Hello' });
    expect(model.turns[0]!.items[2]).toMatchObject({ kind: 'reasoning', expanded: false });
    model.toggleReasoning('r1');
    expect(model.turns[0]!.items[2]).toMatchObject({ expanded: true });
    model.toggleReasoning('r1');
    expect(model.turns[0]!.items[2]).toMatchObject({ expanded: false });
    // The detail sheet opens for a known item only, once; closing twice is harmless.
    model.openItem('nope');
    expect(model.detailItemId).toBeUndefined();
    model.openItem('r1');
    model.openItem('r1');
    expect(model.detailItemId).toBe('r1');
    model.closeItem();
    model.closeItem();
    expect(model.detailItemId).toBeUndefined();
    expect(model.usage).toBe('Session total 1,200 in · 340 out · context 4% full');
    expect(model.status).toMatchObject({ label: 'Finished', tone: 'ok' });
    expect(model.mode).toBe('send');
    expect(changes).toHaveBeenCalled();
  });

  it('pending counters and the "needs your decision" banner follow the Journal', async () => {
    const { model, live } = await setup();
    expect(model.needsDecision).toBe(false);
    live(1, [
      ['approval/request', { request: approval('req_1') }],
      ['input/request', { request: inputRequest('req_2') }],
      ['status/changed', { status: 'waiting_approval' }],
    ]);
    expect(model.pending).toEqual({ approvals: 1, inputs: 1, total: 2 });
    expect(model.needsDecision).toBe(true);
    expect(model.status.label).toBe('Needs approval');
    live(4, [['request/resolved', { requestId: 'req_1', kind: 'command', resolvedBy: 'dev_other', decision: 'accept' }]]);
    expect(model.pending.total).toBe(1);
  });

  it('usage updates mid-turn, with an approval pending (field check turn 2 numbers)', async () => {
    const { model, live } = await setup();
    live(1, [
      ['usage/updated', { usage: { inputTokens: 32495, outputTokens: 144, contextPercent: 1.7 } }],
      ['turn/started', { turn: turn('t2') }],
      ['status/changed', { status: 'running' }],
      ['usage/updated', { usage: { inputTokens: 49451, outputTokens: 344, contextPercent: 1.7 } }],
      ['approval/request', { request: approval('req_1') }],
      ['status/changed', { status: 'waiting_approval' }],
    ]);
    expect(model.runningTurnId).toBe('t2');
    expect(model.status.label).toBe('Needs approval');
    expect(model.usage).toBe('Session total 49,451 in · 344 out · context 1.7% full');
    live(7, [['usage/updated', { usage: { inputTokens: 66646, outputTokens: 366, contextPercent: 1.7 } }]]);
    expect(model.runningTurnId).toBe('t2');
    expect(model.usage).toBe('Session total 66,646 in · 366 out · context 1.7% full');
  });

  it('a closed session cannot send', async () => {
    const { model, live } = await setup();
    live(1, [['session/closed', { reason: 'archived' }]]);
    model.setDraft('hello');
    expect(model.closed).toBe(true);
    expect(model.canSend).toBe(false);
  });

  it('scrolling: the jump pill shows when scrolled up; jumping asks the view to scroll', async () => {
    const { model, changes } = await setup();
    expect(model.showJumpToLatest).toBe(false);
    model.setAtBottom(false);
    expect(model.showJumpToLatest).toBe(true);
    const calls = changes.mock.calls.length;
    model.setAtBottom(false);
    expect(changes.mock.calls.length).toBe(calls);
    const before = model.scrollRequest;
    model.jumpToLatest();
    expect(model.showJumpToLatest).toBe(false);
    expect(model.scrollRequest).toBe(before + 1);
  });

  it('dispose stops listening and closes the session; never-started models close nothing', async () => {
    const { client, model, changes } = await setup();
    model.dispose();
    expect(client.count('session/close')).toBe(1);
    const calls = changes.mock.calls.length;
    client.notify('status/changed', ev(1, 'status/changed', { status: 'running' }).params);
    expect(changes.mock.calls.length).toBe(calls);
    const other = await setup({ open: false });
    other.model.dispose();
    expect(other.client.count('session/close')).toBe(0);
  });
});

/** The fixtures' session runs on "codex"; these lists say what the host reports about that agent. */
const codexAs = (capabilities?: Record<string, unknown>): AgentsSource => () => [
  { id: 'codex', name: 'Codex', status: 'ready', ...(capabilities ? { capabilities: capabilities as any } : {}) },
];
const NO_STEER = codexAs({ steer: false, diff: false, approvalModes: ['default', 'never'] });
const PI_LIKE = codexAs({ steer: true, diff: false, approvalModes: [] });
const FULL = codexAs({ steer: true, diff: true, approvalModes: ['on-request', 'never'] });

describe('SessionModel: agent capabilities (spec 4)', () => {
  const never = { session: session({ lastSeq: 0, settings: { approvalMode: 'never' } }) };

  it('the Bypass tag needs approvalMode never and an agent that honours it', async () => {
    expect((await setup({ over: never, agents: FULL })).model.bypass).toBe(true);
    expect((await setup({ over: never, agents: PI_LIKE })).model.bypass).toBe(false);
    const asking = await setup({ over: { session: session({ lastSeq: 0, settings: { approvalMode: 'on-request' } }) }, agents: FULL });
    expect(asking.model.bypass).toBe(false);
  });

  it('an older host (no capabilities), or an agent not listed yet, keeps today\'s behaviour', async () => {
    const old = await setup({ over: never, agents: codexAs() });
    expect(old.model.bypass).toBe(true);
    expect(old.model.steerable).toBe(true);
    expect(old.model.diffs).toBe(true);
    const unlisted = await setup({ over: never, agents: () => undefined });
    expect(unlisted.model.agent).toBeUndefined();
    expect(unlisted.model.bypass).toBe(true);
    expect(unlisted.model.hasDetail('agent')).toBe(true);
  });

  it('an agent that cannot steer: the composer says so up front and queues without trying turn/steer', async () => {
    const { client, model, live } = await setup({ agents: NO_STEER });
    expect(model.mode).toBe('send');
    expect(model.composerNote).toBeUndefined();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    expect(model.mode).toBe('queue');
    expect(model.composerNote).toBe(NO_STEER_NOTE);
    model.setDraft('after this');
    model.send();
    expect(client.count('turn/steer')).toBe(0);
    expect(model.steerRows).toEqual([{ clientMessageId: 'cm-1', text: 'after this', state: 'queued', label: 'Queued until the turn ends' }]);
    live(2, [['turn/completed', { turn: turn('t1', { status: 'completed' }) }]]);
    expect(model.steerRows).toEqual([]);
    expect(client.last('turn/start').params.input).toEqual([{ type: 'text', text: 'after this' }]);
  });

  it('an agent that cannot steer: "steer instead" after session_busy queues the message', async () => {
    const { client, model, live } = await setup({ agents: NO_STEER });
    model.setDraft('later');
    model.send();
    client.last('turn/start').reject(rpcError('session_busy', { turnId: 't9' }));
    await settle();
    live(1, [['turn/started', { turn: turn('t9') }]]);
    model.steerInstead('cm-1');
    expect(client.count('turn/steer')).toBe(0);
    expect(model.steerRows).toMatchObject([{ text: 'later', state: 'queued' }]);
    expect(client.count('turn/start')).toBe(1);
    live(2, [['turn/completed', { turn: turn('t9', { status: 'completed' }) }]]);
    expect(client.count('turn/start')).toBe(2);
    expect(client.last('turn/start').params.input).toEqual([{ type: 'text', text: 'later' }]);
  });

  it('an agent without diffs: only command items open the detail sheet', async () => {
    const { model } = await setup({
      turns: [turn('t1', { status: 'completed', items: [agentItem('a1', 't1', 'done'), command({ status: 'completed' })] })],
      agents: PI_LIKE,
    });
    expect(model.diffs).toBe(false);
    expect(model.hasDetail('agent')).toBe(false);
    expect(model.hasDetail('command')).toBe(true);
    model.openItem('a1');
    expect(model.detailItemId).toBeUndefined();
    model.openItem('c1');
    expect(model.detailItemId).toBe('c1');
  });
});

describe('SessionModel: composer (spec 7)', () => {
  it('send: an optimistic sending turn, reconciled by the host turn; blank drafts do nothing', async () => {
    const { client, model, live } = await setup();
    model.send();
    expect(client.count('turn/start')).toBe(0);
    model.setDraft('  Create hello.txt  ');
    model.setDraft('  Create hello.txt  ');
    expect(model.canSend).toBe(true);
    model.setAtBottom(false);
    model.send();
    expect(model.draft).toBe('');
    expect(model.atBottom).toBe(true);
    expect(client.last('turn/start').params).toEqual({ sessionId: SID, input: [{ type: 'text', text: 'Create hello.txt' }], clientMessageId: 'cm-1' });
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0]).toMatchObject({ status: 'sending', label: 'Sending…', items: [{ kind: 'user', text: 'Create hello.txt' }] });
    client.last('turn/start').resolve({ turn: turn('t1') });
    await settle();
    live(1, [
      ['turn/started', { turn: turn('t1') }],
      ['item/started', { turnId: 't1', item: userItem('u1', 't1', 'cm-1') }],
    ]);
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0]).toMatchObject({ turnId: 't1', status: 'inProgress' });
    expect(model.turns[0]!.send).toBeUndefined();
  });

  it('a refused send shows the failure with retry (same id) and discard', async () => {
    const { client, model } = await setup();
    model.setDraft('hi');
    model.send();
    client.last('turn/start').reject(rpcError('agent_unavailable'));
    await settle();
    expect(model.turns[0]).toMatchObject({ status: 'failed_to_send', send: { failure: 'The agent is not available on the host right now.', busy: false } });
    model.retry('cm-1');
    expect(model.turns[0]!.status).toBe('sending');
    expect(client.last('turn/start').params.clientMessageId).toBe('cm-1');
    client.last('turn/start').reject(rpcError('internal'));
    await settle();
    model.discard('cm-1');
    expect(model.turns).toEqual([]);
  });

  it('session_busy offers steer instead: the text goes into the busy turn', async () => {
    const { client, model } = await setup();
    model.setDraft('also list files');
    model.send();
    client.last('turn/start').reject(rpcError('session_busy', { turnId: 't9' }));
    await settle();
    expect(model.turns[0]!.send).toMatchObject({ busy: true });
    model.steerInstead('cm-1');
    expect(model.turns).toEqual([]);
    expect(client.last('turn/steer').params).toEqual({ sessionId: SID, turnId: 't9', input: [{ type: 'text', text: 'also list files' }], clientMessageId: 'cm-2' });
    expect(model.steerRows).toEqual([{ clientMessageId: 'cm-2', text: 'also list files', state: 'sending', label: 'Sending…' }]);
    model.steerInstead('cm-unknown'); // nothing to do
  });

  it('steer instead without a known running turn retries the send', async () => {
    const { client, model } = await setup();
    model.setDraft('x');
    model.send();
    client.last('turn/start').reject(rpcError('session_busy'));
    await settle();
    model.steerInstead('cm-1');
    expect(client.count('turn/start')).toBe(2);
    expect(client.count('turn/steer')).toBe(0);
  });

  it('while a turn runs, send steers it; the steer leaves once echoed', async () => {
    const { client, model, live } = await setup();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    model.setDraft('skip hidden files');
    model.send();
    expect(client.last('turn/steer').params).toMatchObject({ turnId: 't1', clientMessageId: 'cm-1' });
    client.last('turn/steer').resolve({ turn: turn('t1') });
    await settle();
    expect(model.steerRows).toMatchObject([{ state: 'sent', label: 'Sent' }]);
    live(2, [['item/started', { turnId: 't1', item: userItem('u2', 't1', 'cm-1') }]]);
    expect(model.steerRows).toEqual([]);
  });

  it('a sent steer that is never echoed leaves when its turn ends', async () => {
    const { client, model, live } = await setup();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    model.setDraft('more');
    model.send();
    client.last('turn/steer').resolve({ turn: turn('t1') });
    await settle();
    expect(model.steerRows).toHaveLength(1);
    live(2, [['turn/completed', { turn: turn('t1', { status: 'completed' }) }]]);
    expect(model.steerRows).toEqual([]);
  });

  it('turn_mismatch: the turn just ended, so the steer becomes a new turn', async () => {
    const { client, model, live } = await setup();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    model.setDraft('late');
    model.send();
    client.last('turn/steer').reject(rpcError('turn_mismatch'));
    await settle();
    expect(model.steerRows).toEqual([]);
    expect(client.last('turn/start').params.input).toEqual([{ type: 'text', text: 'late' }]);
  });

  it('not_supported: the steer is queued and goes out as a new turn once the running turn ends', async () => {
    const { client, model, live } = await setup();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    model.setDraft('queued one');
    model.send();
    client.last('turn/steer').reject(rpcError('not_supported'));
    await settle();
    expect(model.steerRows).toMatchObject([{ state: 'queued', label: 'Queued until the turn ends' }]);
    expect(client.count('turn/start')).toBe(0);
    live(2, [['turn/completed', { turn: turn('t1', { status: 'completed' }) }]]);
    expect(model.steerRows).toEqual([]);
    expect(client.last('turn/start').params.input).toEqual([{ type: 'text', text: 'queued one' }]);
  });

  it('a failed steer can be retried into the running turn, sent as a new turn later, or discarded', async () => {
    const { client, model, live } = await setup();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    model.setDraft('one');
    model.send();
    client.last('turn/steer').reject(rpcError('rate_limited'));
    await settle();
    expect(model.steerRows).toMatchObject([{ state: 'failed', error: 'Too many requests; wait a moment and retry.' }]);
    model.retrySteer('cm-1');
    expect(client.count('turn/steer')).toBe(2);
    expect(client.last('turn/steer').params.clientMessageId).toBe('cm-1');
    client.last('turn/steer').reject(rpcError('internal'));
    await settle();
    model.retrySteer('cm-nope'); // unknown: nothing
    live(2, [['turn/completed', { turn: turn('t1', { status: 'completed' }) }]]);
    model.retrySteer('cm-1');
    expect(client.last('turn/start').params.input).toEqual([{ type: 'text', text: 'one' }]);
    expect(model.steerRows).toEqual([]);

    live(3, [['turn/started', { turn: turn('t2') }]]);
    model.setDraft('two');
    model.send();
    client.last('turn/steer').reject(new Error('socket gone') as any);
    await settle();
    expect(model.steerRows).toMatchObject([{ state: 'failed', error: 'socket gone' }]);
    model.discardSteer('cm-3');
    model.discardSteer('cm-3');
    expect(model.steerRows).toEqual([]);
  });

  it('interrupt: turn/interrupt for the running turn; stays "stopping" until the turn ends', async () => {
    const { client, model, live } = await setup();
    await model.interrupt(); // nothing running
    expect(client.count('turn/interrupt')).toBe(0);
    live(1, [['turn/started', { turn: turn('t1') }]]);
    expect(model.canInterrupt).toBe(true);
    const done = model.interrupt();
    expect(model.interrupting).toBe(true);
    expect(model.canInterrupt).toBe(false);
    void model.interrupt(); // already stopping
    expect(client.count('turn/interrupt')).toBe(1);
    expect(client.last('turn/interrupt').params).toEqual({ sessionId: SID, turnId: 't1' });
    client.last('turn/interrupt').resolve({ ok: true });
    await done;
    expect(model.interrupting).toBe(true);
    live(2, [['turn/completed', { turn: turn('t1', { status: 'interrupted' }) }]]);
    expect(model.interrupting).toBe(false);
    expect(model.turns[0]).toMatchObject({ label: 'Interrupted' });
  });

  it('a failed interrupt shows why and allows another try', async () => {
    const { client, model, live } = await setup();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    const done = model.interrupt();
    client.last('turn/interrupt').reject(rpcError('connection_lost'));
    await done;
    expect(model.interruptError).toBe('Could not stop the turn: connection_lost');
    expect(model.canInterrupt).toBe(true);
  });
});

describe('SessionModel: older turns (session/history)', () => {
  it('loads a page before olderCursor; reports failures; does nothing without a cursor', async () => {
    const { client, model } = await setup({ turns: [{ ...turn('t5', { status: 'completed' }), items: [agentItem('i5', 't5', 'five')] }], over: { olderCursor: 'old-5' } });
    expect(model.hasOlder).toBe(true);
    const page = model.loadOlder();
    expect(model.loadingOlder).toBe(true);
    void model.loadOlder(); // one at a time
    expect(client.count('session/history')).toBe(1);
    expect(client.last('session/history').params).toEqual({ sessionId: SID, before: 'old-5', limit: 5 });
    client.last('session/history').reject(rpcError('internal'));
    await page;
    expect(model.olderError).toBe('Could not load earlier turns: internal');
    expect(model.loadingOlder).toBe(false);

    const again = model.loadOlder();
    expect(model.olderError).toBeUndefined();
    client.last('session/history').resolve({ turns: [{ ...turn('t4', { status: 'completed' }), items: [agentItem('i4', 't4', 'four')] }] });
    await again;
    expect(model.turns.map((t) => t.turnId)).toEqual(['t4', 't5']);
    expect(model.hasOlder).toBe(false);
    await model.loadOlder();
    expect(client.count('session/history')).toBe(2);
  });
});

describe('task state line', () => {
  it('taskStateOf: one of seven states from status and the last turn, toned like the list', () => {
    expect(taskStateOf({ status: 'running' })).toEqual({ label: 'Running', tone: 'busy' });
    expect(taskStateOf({ status: 'waiting_approval' })).toEqual({ label: 'Waiting for your approval', tone: 'attention' });
    expect(taskStateOf({ status: 'waiting_input' })).toEqual({ label: 'Waiting for your answer', tone: 'attention' });
    expect(taskStateOf({ status: 'error' })).toEqual({ label: 'Failed', tone: 'error' });
    expect(taskStateOf({ status: 'idle', lastTurnStatus: 'completed' })).toEqual({ label: 'Finished', tone: 'ok' });
    expect(taskStateOf({ status: 'idle', lastTurnStatus: 'failed' })).toEqual({ label: 'Failed', tone: 'error' });
    expect(taskStateOf({ status: 'idle', lastTurnStatus: 'interrupted' })).toEqual({ label: 'Interrupted', tone: 'muted' });
    expect(taskStateOf({ status: 'idle', lastTurnStatus: 'inProgress' })).toEqual({ label: 'Running', tone: 'busy' });
    expect(taskStateOf({ status: 'idle' })).toEqual({ label: 'Idle', tone: 'muted' });
    expect(taskStateOf({ status: 'closed', lastTurnStatus: 'completed' })).toEqual({ label: 'Finished', tone: 'muted' });
    expect(taskStateOf({ status: 'idle', lastTurnStatus: 'paused' as never })).toEqual({ label: 'Idle', tone: 'muted' });
  });

  it('SessionModel.taskState follows the list row before open and the view after', async () => {
    const { model, live, client } = await setup({ open: false });
    expect(model.taskState.label).toBe('Idle');
    model.start();
    client.last('session/open').resolve(snapshot(10, [turn('t1', { status: 'completed', completedAt: 20 })]));
    await settle();
    expect(model.taskState).toEqual({ label: 'Finished', tone: 'ok' });
    live(11, [['status/changed', { status: 'waiting_approval' }]]);
    expect(model.taskState.label).toBe('Waiting for your approval');
  });
});
