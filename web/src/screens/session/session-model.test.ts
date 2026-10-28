import { describe, expect, it, vi } from 'vitest';

import { FakeTransport, rpcError, settle } from '../../../test/replica-doubles';
import { SID, agentItem, approval, ev, inputRequest, session, snapshot, summary, turn, userItem } from '../../../test/replica-fixtures';
import { Replica } from '../../replica/replica';
import type { Item, TurnView } from '../../replica/types';
import type { AgentsSource } from '../capabilities';
import type { ConnectionSource } from '../home-model';
import { FakeUploader, fakeObjectUrls, fakeResize, picked } from '../../../test/attachment-doubles';
import type { Agent } from '../../generated/common';
import {
  type AttachmentServices,
  commandSummary,
  inputText,
  formatDuration,
  itemRow,
  NO_STEER_NOTE,
  QUEUE_HINT,
  STEER_HINT,
  oneLine,
  sendErrorText,
  SessionModel,
  elapsedText,
  TASK_LINGER_S,
  queuedText,
  stopConfirmText,
  turnRow,
  unwrapShell,
  usageLine,
} from './session-model';

/* eslint-disable @typescript-eslint/no-explicit-any */

function command(over: Record<string, unknown> = {}): any {
  return { itemId: 'c1', type: 'command', turnId: 't1', status: 'inProgress', command: '/bin/zsh -lc "echo hello > hello.txt"', cwd: '/w', output: '', ...over };
}

async function setup(
  options: { open?: boolean; turns?: any[]; over?: Record<string, unknown>; agents?: AgentsSource; attachments?: AttachmentServices; now?: () => number; link?: ConnectionSource } = {},
) {
  const client = new FakeTransport();
  client.rule('session/list', () => ({ sessions: [summary({ title: 'Listed title', cwd: '/Users/me/Desktop/phone-test' })] }));
  client.rule('session/close', () => ({ ok: true }));
  let n = 0;
  const replica = new Replica({ client, storage: null, newClientMessageId: () => `cm-${++n}`, now: () => 100 });
  client.goReady();
  await settle();
  const model = new SessionModel({
    sessionId: SID,
    replica,
    ...(options.agents ? { agents: options.agents } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.link ? { link: options.link } : {}),
  });
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
    ).toEqual({ kind: 'user', itemId: 'u', text: 'hi\n@a.ts', images: [{ url: 'data:', name: 'image' }], files: [] });
    expect(itemRow(agentItem('a', 't1', 'yo'), false)).toEqual({ kind: 'agent', itemId: 'a', text: 'yo', streaming: true });
    expect(itemRow({ ...base, itemId: 'r', type: 'reasoning', summary: 'Thinking' } as Item, true)).toEqual({
      kind: 'reasoning', itemId: 'r', summary: 'Thinking', text: '', expanded: true, streaming: false,
    });
    expect(itemRow(command(), false)).toMatchObject({ kind: 'command', state: 'Running', tone: 'busy' });
    expect(itemRow(command({ status: 'completed', exitCode: 0, output: 'ok' }), false)).toMatchObject({ state: 'Done', tone: 'ok', output: 'ok', expanded: false });
    expect(itemRow(command({ status: 'completed', command: '/bin/zsh -lc "npm test"', exitCode: 0, durationMs: 42 }), true)).toMatchObject({
      command: 'npm test', meta: 'exit 0 · 42 ms', summary: 'npm test · exit 0 · 42 ms', expanded: true,
    });
    expect(itemRow(command({ status: 'completed', exitCode: 2 }), false)).toMatchObject({ state: 'Failed', tone: 'error' });
    expect(itemRow(command({ status: 'failed' }), false)).toMatchObject({ state: 'Failed', tone: 'error' });
    expect(itemRow(command({ status: 'declined' }), false)).toMatchObject({ state: 'Declined', tone: 'muted' });
    expect(
      itemRow({ ...base, itemId: 'f', type: 'fileChange', changes: [{ path: 'a.txt', kind: 'add', diff: '+' }, { path: 'b.txt', kind: 'delete', diff: '' }] } as Item, false),
    ).toEqual({ kind: 'fileChange', itemId: 'f', files: [{ path: 'a.txt', kind: 'add' }, { path: 'b.txt', kind: 'delete' }], state: 'Done', tone: 'ok', expanded: false });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'search', arguments: {} } as Item, false)).toEqual({
      kind: 'tool', itemId: 't', summary: 'search', state: 'Done', tone: 'ok', expanded: false,
    });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'read', server: 'fs', arguments: {}, error: { message: 'denied' } } as Item, false)).toMatchObject({
      summary: 'fs/read', state: 'Failed', error: 'denied',
    });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'x', server: '', arguments: {}, error: 'nope' } as Item, false)).toMatchObject({ summary: 'x', error: 'nope' });
    expect(itemRow({ ...base, itemId: 't', type: 'toolCall', tool: 'x', arguments: {}, error: { code: 3 } } as Item, false)).toMatchObject({ error: '{"code":3}' });
    expect(itemRow({ ...base, itemId: 'p', type: 'plan', text: '1. do' } as Item, true)).toEqual({ kind: 'plan', itemId: 'p', text: '1. do', expanded: true });
    expect(itemRow({ ...base, itemId: 'o', type: 'other', raw: {} } as Item, false)).toEqual({ kind: 'other', itemId: 'o', label: 'Other activity' });
    expect(itemRow({ ...base, itemId: 'n', type: 'imageGeneration' } as unknown as Item, false)).toEqual({ kind: 'other', itemId: 'n', label: 'imageGeneration' });
  });

  it('turnRow: labels by status, inline error of a failed turn, missing items skipped, refused sends', () => {
    const items = { i1: agentItem('i1', 't1', 'x') };
    const none = { expanded: new Set<string>() };
    const make = (over: Partial<TurnView>): TurnView => ({ ...turn('t1'), items: ['i1', 'gone'], ...over });
    expect(turnRow(make({}), items, none)).toMatchObject({ label: '', tone: 'busy', items: [{ kind: 'agent' }], final: false, unfolded: false });
    expect(turnRow(make({}), items, none).items[0]).toMatchObject({ streaming: true });
    expect(turnRow(make({ status: 'completed' }), items, none)).toMatchObject({ label: '', tone: 'ok', items: [{ streaming: false }] });
    expect(turnRow(make({ status: 'interrupted' }), items, none)).toMatchObject({ label: 'Interrupted', final: true });
    expect(turnRow(make({ status: 'interrupted', completedAt: 22 }), items, none)).toMatchObject({ label: '', workedFor: 'Stopped after 12s' });
    expect(turnRow(make({ status: 'completed', completedAt: 202 }), items, none)).toMatchObject({ workedFor: 'Worked for 3m 12s', final: true });
    expect(turnRow(make({ status: 'completed', completedAt: 202 }), items, { ...none, unfolded: new Set(['t1']) })).toMatchObject({ unfolded: true });
    expect(turnRow(make({ status: 'failed', error: { code: 'internal', message: 'model crashed' } }), items, none)).toMatchObject({ label: 'Failed', error: 'model crashed' });
    expect(turnRow(make({ status: 'failed', error: { code: 'internal', message: '' } }), items, none).error).toBe('internal');
    expect(turnRow(make({ status: 'failed' }), items, none).error).toBeUndefined();
    expect(turnRow(make({ status: 'sending', optimistic: { clientMessageId: 'cm' } }), items, none)).toMatchObject({
      label: 'Sending…', send: { clientMessageId: 'cm', busy: false },
    });
    const busy = turnRow(make({ status: 'failed_to_send', optimistic: { clientMessageId: 'cm', error: { code: 'session_busy', message: 'x' } } }), items, none);
    expect(busy).toMatchObject({ label: 'Not sent', final: false, thinking: false, send: { busy: true, failure: 'The agent is busy with another turn.' } });
  });

  it('turnRow: "Thinking" while the agent works and no answer text streams, not while it waits for the user', () => {
    const none = { expanded: new Set<string>() };
    const at = (text: string, over: Record<string, unknown> = {}) => ({ i1: agentItem('i1', 't1', text, over) });
    const running: TurnView = { ...turn('t1'), items: ['i1'] };
    expect(turnRow({ ...turn('t1'), items: [] }, {}, none).thinking).toBe(true);
    expect(turnRow(running, at(''), none).thinking).toBe(true); // the message started, no words yet
    expect(turnRow(running, at('Hel'), none).thinking).toBe(false); // the answer streams
    expect(turnRow(running, at('Hello', { status: 'completed' }), none).thinking).toBe(true); // a message ended, work goes on
    expect(turnRow({ ...turn('t1'), items: [] }, {}, { ...none, waiting: true }).thinking).toBe(false);
    const thought = { r: { itemId: 'r', type: 'reasoning', turnId: 't1', status: 'inProgress', summary: '' } as Item };
    expect(turnRow({ ...turn('t1'), items: ['r'] }, thought, none).thinking).toBe(false); // the thinking row shimmers itself
    expect(turnRow({ ...turn('t1', { status: 'completed', completedAt: 11 }), items: [] }, {}, none).thinking).toBe(false);
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

  it('effort: the header names the level in effect from Session.settings.effort', async () => {
    expect((await setup({ over: { session: session({ lastSeq: 0, settings: { model: 'opus' } }) } })).model.effort).toBeUndefined();
    expect((await setup({ over: { session: session({ lastSeq: 0, settings: { effort: '' } }) } })).model.effort).toBeUndefined();
    const high = await setup({ over: { session: session({ lastSeq: 0, settings: { model: 'opus', effort: 'xhigh' } }) } });
    expect(high.model.effort).toBe('XHigh');
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
    expect(model.runHint).toBe(STEER_HINT);
    expect(model.turns[0]!.items).toEqual([
      { kind: 'user', itemId: 'u1', text: 'hi', images: [], files: [] },
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
    // The finished turn folds its work; "N previous messages" opens and closes it.
    expect(model.turns[0]).toMatchObject({ final: true, unfolded: false, workedFor: 'Worked for 10s' });
    expect(model.foldedTurns).toBe('t1');
    model.toggleFold('t1');
    expect(model.turns[0]).toMatchObject({ unfolded: true });
    expect(model.foldedTurns).toBe('');
    model.toggleFold('t1');
    expect(model.foldedTurns).toBe('t1');
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

  it('pending counters follow the Journal', async () => {
    const { model, live } = await setup();
    expect(model.pending.total).toBe(0);
    live(1, [
      ['approval/request', { request: approval('req_1') }],
      ['input/request', { request: inputRequest('req_2') }],
      ['status/changed', { status: 'waiting_approval' }],
    ]);
    expect(model.pending).toEqual({ approvals: 1, inputs: 1, total: 2 });
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
    expect(model.runHint).toBeUndefined();
    live(1, [['turn/started', { turn: turn('t1') }]]);
    expect(model.mode).toBe('queue');
    expect(model.composerNote).toBe(NO_STEER_NOTE);
    expect(NO_STEER_NOTE).toBe('Sent when the turn ends'); // one line, the same words as while typing
    expect(model.runHint).toBe(QUEUE_HINT);
    model.setDraft('after this');
    model.send();
    expect(client.count('turn/steer')).toBe(0);
    expect(model.steerRows).toEqual([{ clientMessageId: 'cm-1', text: 'after this', images: [], files: [], state: 'queued', label: 'Queued until the turn ends' }]);
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
    expect(model.steerRows).toEqual([{ clientMessageId: 'cm-2', text: 'also list files', images: [], files: [], state: 'sending', label: 'Sending…' }]);
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

describe('header status word', () => {
  it('SessionModel.status follows the list row before open and the view after', async () => {
    const { model, live, client } = await setup({ open: false });
    expect(model.status.label).toBe('Idle');
    model.start();
    client.last('session/open').resolve(snapshot(10, [turn('t1', { status: 'completed', completedAt: 20 })]));
    await settle();
    expect(model.status).toEqual({ label: 'Finished', tone: 'ok', status: 'idle' });
    live(11, [['status/changed', { status: 'waiting_approval' }]]);
    expect(model.status).toMatchObject({ label: 'Needs approval', tone: 'attention' });
  });
});

/** A stream client's connection as the session view reads it: state, retry time, host name, state events. */
function fakeLink(state: ConnectionSource['state'] = 'ready') {
  const listeners = new Set<(state: ConnectionSource['state'], detail: string) => void>();
  const link = {
    state,
    reconnectAt: undefined as number | undefined,
    host: { host: { name: 'Mac mini' } } as ConnectionSource['host'],
    on: (_event: 'state', listener: (state: ConnectionSource['state'], detail: string) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: ConnectionSource['state'], reconnectAt?: number) {
      link.state = next;
      link.reconnectAt = reconnectAt;
      for (const listener of listeners) listener(next, '');
    },
    listeners,
  };
  return link;
}

describe('SessionModel: the centred header and its ⋯ sheet', () => {
  it('running: "Working" with the elapsed time since the turn started, counting while it runs, none after', async () => {
    let now = 40_000; // the turn started at 10 s
    const { model, live, changes } = await setup({ now: () => now });
    expect(model.statusLine).toMatchObject({ text: 'Idle', ticking: false });
    expect(model.ticking).toBe(false);
    live(1, [
      ['turn/started', { turn: turn('t1') }],
      ['status/changed', { status: 'running' }],
    ]);
    expect(model.statusLine).toMatchObject({ text: 'Working · 30s', status: 'running', tone: 'busy' });
    expect(model.ticking).toBe(true);
    now = 144_000;
    changes.mockClear();
    model.tick();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(model.statusLine.text).toBe('Working · 2m 14s');
    live(3, [
      ['turn/completed', { turn: turn('t1', { status: 'completed', completedAt: 202 }) }],
      ['status/changed', { status: 'idle' }],
    ]);
    expect(model.statusLine).toMatchObject({ text: 'Finished', ticking: false });
    expect(model.ticking).toBe(false);
    changes.mockClear();
    model.tick();
    expect(changes).not.toHaveBeenCalled();
    expect(model.detailRows(false)[0]!.value).toEqual([{ text: 'Finished · Worked for 3m 12s' }]);
  });

  it('waiting for an approval: the word, no timer', async () => {
    const { model, live } = await setup();
    live(1, [
      ['turn/started', { turn: turn('t1') }],
      ['status/changed', { status: 'waiting_approval' }],
    ]);
    expect(model.statusLine).toMatchObject({ text: 'Needs approval', tone: 'attention', status: 'waiting_approval', ticking: false });
  });

  it('Mac offline comes first, with the retry countdown, and follows the connection live', async () => {
    let now = 50_000;
    const link = fakeLink();
    const { model, changes, live } = await setup({ link, now: () => now });
    live(1, [
      ['turn/started', { turn: turn('t1') }],
      ['status/changed', { status: 'running' }],
    ]);
    expect(model.connection).toMatchObject({ kind: 'connected' });
    changes.mockClear();
    link.set('waiting', 53_000);
    expect(changes).toHaveBeenCalled();
    expect(model.statusLine).toMatchObject({ text: 'Mac offline · retrying in 3 s', tone: 'error', status: 'offline', ticking: true });
    now = 51_000;
    expect(model.statusLine.text).toBe('Mac offline · retrying in 2 s');
    link.set('stopped');
    expect(model.statusLine).toMatchObject({ text: 'Mac offline', ticking: false });
    expect(model.ticking).toBe(false); // offline hides the elapsed time, and no retry is counting down
    link.set('ready');
    expect(model.statusLine).toMatchObject({ status: 'running', ticking: true });
  });

  it('without a link there is no connection; dispose stops listening to it', async () => {
    const { model } = await setup();
    expect(model.connection).toBeUndefined();
    const link = fakeLink();
    const linked = await setup({ link });
    expect(link.listeners.size).toBe(1);
    linked.model.dispose();
    expect(link.listeners.size).toBe(0);
    expect(model.detailsSubtitle).toBe('work');
    expect(linked.model.detailsSubtitle).toBe('Mac mini · work');
  });

  it('the ⋯ sheet: status, agent, model and effort, folder, permissions, Changes, archive and delete', async () => {
    const turns = [turn('t1', { status: 'completed', completedAt: 20 })];
    const { model, client } = await setup({
      turns,
      agents: FULL,
      over: { session: session({ lastSeq: 0, settings: { model: 'gpt-5.5-codex', effort: 'high', approvalMode: 'never' } }) },
    });
    client.calls.find((c) => c.method === 'turn/diff')!.resolve({ files: [{ path: 'a', kind: 'add', diff: '' }] });
    await settle();
    const rows = model.detailRows(false);
    expect(rows.map((row) => [row.key, row.value.map((part) => part.text).join(' · ')])).toEqual([
      ['status', 'Finished · Worked for 10s'],
      ['agent', 'Codex'],
      ['model', 'gpt-5.5-codex · High'],
      ['folder', '/work'],
      ['permissions', 'Full access'],
      ['changes', '1 file changed'],
      ['archive', ''],
      ['delete', ''],
    ]);
    expect(model.statusLine.fullAccess).toBe(true);
    expect(model.detailRows(true).map((row) => row.key)).toContain('unarchive');
    model.openLastChanges();
    expect(model.changesTurnId).toBe('t1');
  });

  it('no finished turn with changes: no Changes row, and openLastChanges does nothing', async () => {
    const { model } = await setup({ turns: [turn('t1', { status: 'completed', completedAt: 20 })], agents: PI_LIKE });
    expect(model.detailRows(false).map((row) => row.key)).not.toContain('changes');
    model.openLastChanges();
    expect(model.changesTurnId).toBeUndefined();
  });
});

describe('SessionModel: "N files changed" per finished turn (turn/diff, spec 7)', () => {
  const diffCalls = (client: Awaited<ReturnType<typeof setup>>['client']) => client.calls.filter((c) => c.method === 'turn/diff');

  it('asks turn/diff once per finished turn and shows the count of turns that changed files', async () => {
    const turns = [turn('t1', { status: 'completed' }), turn('t2', { status: 'interrupted' }), turn('t3')];
    const { client, model, live } = await setup({ turns, agents: FULL });
    expect(diffCalls(client).map((c) => c.params)).toEqual([
      { sessionId: SID, turnId: 't1' },
      { sessionId: SID, turnId: 't2' },
    ]);
    diffCalls(client)[0]!.resolve({ files: [{ path: 'a', kind: 'add', diff: '' }, { path: 'b', kind: 'modify', diff: '' }], omittedFiles: 1 });
    diffCalls(client)[1]!.reject(rpcError('not_a_repository'));
    await settle();
    expect(model.turns.map((t) => [t.turnId, t.changes ?? null])).toEqual([
      ['t1', '3 files changed'],
      ['t2', null],
      ['t3', null],
    ]);

    live(11, [['turn/completed', { turn: turn('t3', { status: 'completed', completedAt: 20 }) }]]);
    await settle();
    expect(diffCalls(client)).toHaveLength(3);
    diffCalls(client)[2]!.resolve({ files: [] });
    await settle();
    expect(model.turns.find((t) => t.turnId === 't3')?.changes).toBeUndefined();
    live(12, [['usage/updated', { usage: { inputTokens: 1, outputTokens: 1 } }]]);
    await settle();
    expect(diffCalls(client)).toHaveLength(3);

    model.openChanges('t1');
    model.openChanges('t1');
    expect(model.changesTurnId).toBe('t1');
    model.closeChanges();
    model.closeChanges();
    expect(model.changesTurnId).toBeUndefined();
  });

  it("counts the agent's edits git did not list: a folder outside git, a file outside the folder", async () => {
    const edit = (itemId: string, turnId: string, paths: string[]) => ({
      itemId,
      type: 'fileChange',
      turnId,
      status: 'completed',
      changes: paths.map((path) => ({ path, kind: 'modify', diff: '@@ -1 +1 @@\n-a\n+b\n' })),
    });
    const turns = [
      turn('t1', { status: 'completed', items: [edit('f1', 't1', ['/work/a.ts', '/tmp/handoff.md'])] }),
      turn('t2', { status: 'completed', items: [edit('f2', 't2', ['/work/b.ts'])] }),
      turn('t3', { status: 'completed' }),
    ];
    const { client, model } = await setup({ turns, agents: FULL });
    diffCalls(client)[0]!.resolve({ files: [{ path: 'a.ts', kind: 'modify', diff: '' }] });
    diffCalls(client)[1]!.reject(rpcError('not_a_repository'));
    diffCalls(client)[2]!.reject(rpcError('not_a_repository'));
    await settle();
    expect(model.turns.map((t) => [t.turnId, t.changes ?? null])).toEqual([
      ['t1', '2 files changed'],
      ['t2', '1 file changed'],
      ['t3', null],
    ]);
  });

  it('an agent without diffs asks nothing and opens no Changes sheet', async () => {
    const { client, model } = await setup({ turns: [turn('t1', { status: 'completed' })], agents: PI_LIKE });
    expect(diffCalls(client)).toHaveLength(0);
    model.openChanges('t1');
    expect(model.changesTurnId).toBeUndefined();
  });
});

describe('SessionModel: attachments (spec 8.1)', () => {
  const codex = (attachments?: { images: boolean; files: boolean }): Agent => ({
    id: 'codex',
    name: 'Codex',
    status: 'ready',
    capabilities: { steer: true, diff: true, approvalModes: [], ...(attachments ? { attachments } : {}) },
  });
  const MAX = 20 * 1024 * 1024;

  /** `null`: a host without `limits.maxAttachmentBytes`. */
  function services(maxBytes: number | null = MAX) {
    const uploader = new FakeUploader();
    const urls = fakeObjectUrls();
    const attachments: AttachmentServices = { maxBytes: () => maxBytes ?? undefined, uploader: uploader.upload, resize: fakeResize().deps, objectUrls: urls.urls };
    return { uploader, urls, attachments };
  }

  it('inputText splits a message into text, image thumbnails and file chips', () => {
    expect(
      inputText([
        { type: 'text', text: 'look' },
        { type: 'image', url: '/v1/blob/blb_a?x=1' },
        { type: 'image', url: 'data:image/png;base64,AA' },
        { type: 'image', url: '/' },
        { type: 'file', url: '/v1/blob/blb_b', name: 'log.txt', mediaType: 'text/plain' },
      ]),
    ).toEqual({
      text: 'look',
      images: [
        { url: '/v1/blob/blb_a?x=1', name: 'blb_a' },
        { url: 'data:image/png;base64,AA', name: 'image' },
        { url: '/', name: 'image' },
      ],
      files: [{ url: '/v1/blob/blb_b', name: 'log.txt', mediaType: 'text/plain' }],
    });
  });

  it('the attach button needs uploads, a host limit, an agent with attachments, and an open session', async () => {
    const both = services();
    expect((await setup({ agents: () => [codex({ images: true, files: true })], attachments: both.attachments })).model.attachRules).toEqual({
      images: true,
      files: true,
      maxBytes: MAX,
    });
    expect((await setup({ agents: () => [codex({ images: true, files: true })] })).model.attachRules).toBeUndefined();
    expect((await setup({ agents: () => [codex({ images: true, files: true })], attachments: services(null).attachments })).model.attachRules).toBeUndefined();
    expect((await setup({ agents: () => [codex()], attachments: services().attachments })).model.attachRules).toBeUndefined();
    expect((await setup({ agents: () => [codex({ images: false, files: false })], attachments: services().attachments })).model.attachRules).toBeUndefined();
    expect((await setup({ attachments: services().attachments })).model.attachRules).toBeUndefined();
    const closed = await setup({ agents: () => [codex({ images: true, files: true })], attachments: services().attachments });
    closed.live(1, [['session/closed', { reason: 'archived' }]]);
    expect(closed.model.attachRules).toBeUndefined();
    // Images only: the picker asks for images; an agent without image input still takes photos (as files).
    const imagesOnly = await setup({ agents: () => [codex({ images: true, files: false })], attachments: services().attachments });
    expect(imagesOnly.model.attachAccept).toBe('image/*');
    const filesOnly = await setup({ agents: () => [codex({ images: false, files: true })], attachments: services().attachments });
    expect(filesOnly.model.attachRules).toEqual({ images: true, files: true, maxBytes: MAX });
    expect(filesOnly.model.attachAccept).toBe('');
  });

  it('send waits for uploads, then sends text and attachments in one turn/start and empties the tray', async () => {
    const { uploader, urls, attachments } = services();
    const { client, model } = await setup({ agents: () => [codex({ images: true, files: true })], attachments });
    model.attach([picked('IMG@4000x3000.jpg', 'image/jpeg'), picked('log.txt', 'text/plain')]);
    model.setDraft('  what broke?  ');
    expect(model.canSend).toBe(false);
    expect(model.attachmentsNote).toBe('Uploading attachments…');
    await settle();
    // The file uploads at once (blb_..1); the photo after it was downscaled (blb_..2).
    const byName = (name: string) => uploader.uploads.find((u) => u.name === name)!;
    byName('log.txt').reject('Upload failed: the host answered 500.');
    await settle();
    expect(model.attachmentsNote).toBe('Uploading attachments…');
    byName('IMG@4000x3000.jpg').resolve();
    await settle();
    expect(model.attachmentsNote).toBe('An attachment did not upload: retry or remove it.');
    expect(model.canSend).toBe(false);
    model.retryAttachment(model.attachments!.entries[1]!.id);
    uploader.last.resolve();
    await settle();
    expect(model.attachmentsNote).toBeUndefined();
    expect(model.canSend).toBe(true);
    model.send();
    expect(client.last('turn/start').params.input).toEqual([
      { type: 'text', text: 'what broke?' },
      { type: 'image', url: `/v1/blob/blb_${'2'.padStart(22, '0')}` },
      { type: 'file', url: `/v1/blob/blb_${'3'.padStart(22, '0')}`, name: 'log.txt', mediaType: 'text/plain' },
    ]);
    expect(model.attachments!.entries).toEqual([]);
    expect(urls.revoked).toEqual(['blob:preview-1']);
    expect(model.draft).toBe('');
    // The optimistic message shows the thumbnail and the chip at once.
    const user = model.turns.at(-1)!.items[0]!;
    expect(user).toMatchObject({ kind: 'user', text: 'what broke?', images: [{ name: `blb_${'2'.padStart(22, '0')}` }], files: [{ name: 'log.txt' }] });
  });

  it('a message may be attachments only; removing the last one leaves an empty draft unsendable', async () => {
    const { uploader, attachments } = services();
    const { client, model } = await setup({ agents: () => [codex({ images: true, files: true })], attachments });
    model.attach([picked('a.txt', 'text/plain')]);
    uploader.last.resolve();
    await settle();
    expect(model.canSend).toBe(true);
    model.removeAttachment(model.attachments!.entries[0]!.id);
    expect(model.canSend).toBe(false);
    model.attach([picked('b.txt', 'text/plain')]);
    uploader.last.resolve();
    await settle();
    model.send();
    expect(client.last('turn/start').params.input).toEqual([{ type: 'file', url: `/v1/blob/blb_${'2'.padStart(22, '0')}`, name: 'b.txt', mediaType: 'text/plain' }]);
  });

  it('attach does nothing without rules or files; dispose aborts uploads in flight', async () => {
    const { uploader, attachments } = services();
    const none = await setup({ agents: () => [codex()], attachments });
    none.model.attach([picked('a.txt', 'text/plain')]);
    expect(uploader.uploads).toEqual([]);
    none.model.retryAttachment('att-1');
    const { model } = await setup({ agents: () => [codex({ images: true, files: true })], attachments });
    model.attach([]);
    model.attach([picked('a.txt', 'text/plain')]);
    model.dispose();
    expect(uploader.last.aborted).toBe(true);
    const without = await setup({});
    without.model.attach([picked('a.txt', 'text/plain')]);
    without.model.removeAttachment('x');
    without.model.retryAttachment('x');
    expect(without.model.attachmentsNote).toBeUndefined();
  });

  it('attachments steer into a running turn, and wait with a queued message for an agent that cannot steer', async () => {
    const { uploader, attachments } = services();
    const { client, model, live } = await setup({ agents: () => [codex({ images: true, files: true })], attachments });
    live(1, [['turn/started', { turn: turn('t1') }]]);
    model.attach([picked('a@10x10.png', 'image/png')]);
    await settle();
    uploader.last.resolve();
    await settle();
    model.send();
    expect(client.last('turn/steer').params.input).toEqual([{ type: 'image', url: `/v1/blob/blb_${'1'.padStart(22, '0')}` }]);
    expect(model.steerRows[0]).toMatchObject({ text: '', images: [{ url: `/v1/blob/blb_${'1'.padStart(22, '0')}` }], files: [] });

    const noSteer = services();
    const claude: Agent = { id: 'codex', name: 'Codex', status: 'ready', capabilities: { steer: false, diff: true, approvalModes: [], attachments: { images: true, files: true } } };
    const q = await setup({ agents: () => [claude], attachments: noSteer.attachments });
    q.live(1, [['turn/started', { turn: turn('t1') }]]);
    q.model.attach([picked('n.txt', 'text/plain')]);
    noSteer.uploader.last.resolve();
    await settle();
    q.model.setDraft('later');
    q.model.send();
    expect(q.model.steerRows[0]).toMatchObject({ state: 'queued', text: 'later', files: [{ name: 'n.txt' }] });
    q.live(2, [['turn/completed', { turn: turn('t1', { status: 'completed' }) }]]);
    expect(q.client.last('turn/start').params.input).toEqual([
      { type: 'text', text: 'later' },
      { type: 'file', url: `/v1/blob/blb_${'1'.padStart(22, '0')}`, name: 'n.txt', mediaType: 'text/plain' },
    ]);
  });
});

describe('SessionModel: background tasks (spec 5.1 backgroundTasks)', () => {
  const T0 = 1_760_930_400;
  const task = (id: string, over: Record<string, unknown> = {}): any => ({ id, title: `Task ${id}`, status: 'running', startedAt: T0, ...over });
  const withTasks = (tasks: any[], over: Record<string, unknown> = {}) => ({ session: session({ lastSeq: 10, backgroundTasks: tasks, ...over }) });
  const queuedItem = (itemId: string, turnId: string): any => ({ ...userItem(itemId, turnId, 'cm-q'), queued: true });

  it('helpers: elapsed time, the queued notice and the Stop question', () => {
    expect(elapsedText(-3)).toBe('0 s');
    expect(elapsedText(45)).toBe('45 s');
    expect(elapsedText(125)).toBe('2 min 5 s');
    expect(elapsedText(3 * 3600 + 7 * 60 + 9)).toBe('3 h 7 min');
    expect(queuedText(1)).toBe('Queued: waiting for 1 background task to finish');
    expect(queuedText(3)).toBe('Queued: waiting for 3 background tasks to finish');
    expect(queuedText(0)).toBe('Queued: waiting for the agent');
    expect(stopConfirmText(2)).toBe('This also cancels 2 background tasks. Stop anyway?');
  });

  it('the strip: one row per task with title, elapsed time and status; a tap shows the latest activity', async () => {
    let now = (T0 + 65) * 1000;
    const tasks = [
      task('a', { title: 'Review the parser', lastActivity: 'Running Read parser.ts' }),
      task('b', { title: '  ', status: 'finished', endedAt: T0 + 30 }),
      task('c', { status: 'cancelled', endedAt: T0 + 10 }),
      task('d', { status: 'failed', startedAt: T0 + 40 }),
    ];
    const { model, changes } = await setup({ over: withTasks(tasks), now: () => now });
    expect(model.backgroundTasks.map((r) => [r.id, r.title, r.elapsed, r.state, r.tone, r.activity])).toEqual([
      ['a', 'Review the parser', '1 min 5 s', 'Running', 'busy', 'Running Read parser.ts'],
      ['b', 'Background task', '30 s', 'Finished', 'ok', undefined],
      ['c', 'Task c', '10 s', 'Cancelled', 'muted', undefined],
      ['d', 'Task d', '0 s', 'Failed', 'error', undefined],
    ]);
    expect(model.runningTasks).toBe(1);
    expect(model.backgroundTasks[0]!.expanded).toBe(false);
    model.toggleTask('a');
    expect(model.backgroundTasks[0]!.expanded).toBe(true);
    model.toggleTask('a');
    expect(model.backgroundTasks[0]!.expanded).toBe(false);
    // The clock moves the running row only, and takes the one that ended 60 s ago away.
    now += 10_000;
    const before = changes.mock.calls.length;
    model.tick();
    expect(changes.mock.calls.length).toBe(before + 1);
    expect(model.backgroundTasks.map((r) => [r.id, r.elapsed])).toEqual([
      ['a', '1 min 15 s'],
      ['b', '30 s'],
      ['d', '0 s'],
    ]);
  });

  it('an ended task leaves the strip 60 s after it ended, also while the turn goes on; a running one stays', async () => {
    let now = (T0 + 100) * 1000;
    const tasks = [task('run'), task('stop', { status: 'cancelled', endedAt: T0 + 100 }), task('done', { status: 'finished', endedAt: T0 + 120 })];
    const turns = [turn('t1')];
    const { model, changes } = await setup({ turns, over: withTasks(tasks, { status: 'running' }), now: () => now });
    now = (T0 + 159) * 1000;
    expect(model.backgroundTasks.map((r) => r.id)).toEqual(['run', 'stop', 'done']);
    now = (T0 + 160) * 1000;
    const before = changes.mock.calls.length;
    model.tick();
    expect(changes.mock.calls.length).toBe(before + 1);
    expect(model.backgroundTasks.map((r) => r.id)).toEqual(['run', 'done']);
    now = (T0 + 3600) * 1000;
    expect(model.backgroundTasks.map((r) => [r.id, r.state])).toEqual([['run', 'Running']]);
    expect(TASK_LINGER_S).toBe(60);
  });

  it('a session whose agent stopped (error) shows no task running: "Ended", muted, not counted, no clock', async () => {
    const tasks = [task('a', { lastActivity: 'Running Read' }), task('b', { status: 'finished', endedAt: T0 + 2 })];
    const { model, live } = await setup({ over: withTasks(tasks, { status: 'error' }), now: () => (T0 + 30) * 1000 });
    live(1, [['status/changed', { status: 'error' }]]);
    expect(model.backgroundTasks.map((r) => [r.id, r.status, r.state, r.tone, r.elapsed])).toEqual([
      ['a', 'ended', 'Ended', 'muted', ''],
      ['b', 'finished', 'Finished', 'ok', '2 s'],
    ]);
    expect(model.runningTasks).toBe(0);
    // Idle is not stopped: Claude Code runs background tasks between turns.
    live(2, [['status/changed', { status: 'idle' }]]);
    expect(model.backgroundTasks[0]).toMatchObject({ id: 'a', status: 'running', state: 'Running' });
  });

  it('follows session/changed; nothing shows without tasks, once closed, or from the list row of an unopened session', async () => {
    const { model, live, changes } = await setup({ now: () => (T0 + 1) * 1000 });
    expect(model.backgroundTasks).toEqual([]);
    model.tick(); // nothing running: no re-render
    const calls = changes.mock.calls.length;
    model.tick();
    expect(changes.mock.calls.length).toBe(calls);
    live(1, [['session/changed', withTasks([task('a')])]]);
    expect(model.backgroundTasks.map((r) => r.id)).toEqual(['a']);
    live(2, [['session/changed', { session: session({ lastSeq: 2 }) }]]);
    expect(model.backgroundTasks).toEqual([]);
    live(3, [['session/changed', withTasks([task('a')])], ['session/closed', { reason: 'archived' }]]);
    expect(model.backgroundTasks).toEqual([]);

    const unopened = await setup({ open: false });
    expect(unopened.model.backgroundTasks).toEqual([]);
  });

  it('a queued message: the running turn says it waits for the background tasks instead of "Working…"', async () => {
    const turns = [{ ...turn('t1'), items: [queuedItem('u1', 't1')] }];
    const { model, live } = await setup({ turns, over: withTasks([task('a'), task('b')]) });
    expect(model.turns[0]).toMatchObject({ label: 'Queued: waiting for 2 background tasks to finish', tone: 'muted', queued: true, thinking: false });
    // The engine took it: the host journals the item again without the flag.
    live(11, [['item/completed', { turnId: 't1', item: userItem('u1', 't1', 'cm-q') }]]);
    expect(model.turns[0]).toMatchObject({ label: '', tone: 'busy', thinking: true });
    expect(model.turns[0]!.queued).toBeUndefined();
  });

  it('a finished turn with a stale flag shows no notice', async () => {
    const turns = [{ ...turn('t1', { status: 'completed' }), items: [queuedItem('u1', 't1')] }];
    const { model } = await setup({ turns, over: withTasks([task('a')]) });
    expect(model.turns[0]).toMatchObject({ label: '' });
    expect(model.turns[0]!.queued).toBeUndefined();
  });

  it('Stop while tasks run asks first: "Keep running" stops nothing, "Stop anyway" interrupts', async () => {
    const turns = [{ ...turn('t1'), items: [queuedItem('u1', 't1')] }];
    const { client, model, changes } = await setup({ turns, over: withTasks([task('a'), task('b'), task('c', { status: 'finished', endedAt: T0 })]) });
    expect(model.stopQuestion).toBeUndefined();
    model.requestStop();
    expect(client.count('turn/interrupt')).toBe(0);
    expect(model.confirmingStop).toBe(true);
    expect(model.stopQuestion).toBe('This also cancels 2 background tasks. Stop anyway?');
    model.cancelStop();
    expect(model.stopQuestion).toBeUndefined();
    expect(client.count('turn/interrupt')).toBe(0);
    const calls = changes.mock.calls.length;
    model.cancelStop(); // already closed
    model.confirmStop(); // nothing to confirm
    expect(changes.mock.calls.length).toBe(calls);
    expect(client.count('turn/interrupt')).toBe(0);

    model.requestStop();
    model.confirmStop();
    expect(model.confirmingStop).toBe(false);
    expect(client.count('turn/interrupt')).toBe(1);
    expect(client.last('turn/interrupt').params).toEqual({ sessionId: SID, turnId: 't1' });
    model.requestStop(); // already stopping
    expect(model.confirmingStop).toBe(false);
  });

  it('Stop without running tasks stops at once; a question whose tasks ended meanwhile still asks plainly', async () => {
    const { client, model } = await setup({ turns: [turn('t1')], over: withTasks([task('a', { status: 'finished', endedAt: T0 })]) });
    model.requestStop();
    expect(model.confirmingStop).toBe(false);
    expect(client.count('turn/interrupt')).toBe(1);

    const other = await setup({ turns: [turn('t1')], over: withTasks([task('a')]) });
    other.model.requestStop();
    other.live(11, [['session/changed', withTasks([task('a', { status: 'finished', endedAt: T0 })])]]);
    expect(other.model.stopQuestion).toBe('Stop the turn?');
  });
});

describe('settings sheet (spec 6 session/settings/update)', () => {
  const codex = (settingsUpdate?: ('model' | 'effort')[]): Agent => ({
    id: 'codex',
    name: 'Codex',
    status: 'ready',
    capabilities: { steer: true, diff: true, approvalModes: [], ...(settingsUpdate ? { settingsUpdate } : {}) },
  });

  it('the model line opens the sheet only for an agent that can change settings', async () => {
    const without = await setup({ agents: () => [codex()] });
    expect(without.model.canChangeSettings).toBe(false);
    without.model.openSettings();
    expect(without.model.settingsOpen).toBe(false);
    const older = await setup({ agents: () => [{ id: 'codex', name: 'Codex', status: 'ready' }] });
    expect(older.model.canChangeSettings).toBe(false);
    const { model, changes } = await setup({ agents: () => [codex(['model', 'effort'])] });
    expect(model.settingsKeys).toEqual(['model', 'effort']);
    expect(model.canChangeSettings).toBe(true);
    changes.mockClear();
    model.openSettings();
    expect(model.settingsOpen).toBe(true);
    expect(changes).toHaveBeenCalled();
    model.closeSettings();
    expect(model.settingsOpen).toBe(false);
  });

  it('the sheet starts from the session\'s settings, knows a running turn, and saves through the Replica', async () => {
    const { model, client, live } = await setup({
      agents: () => [codex(['effort'])],
      over: { session: { ...snapshot(0).session, settings: { model: 'gpt-5-codex', effort: 'low' } } },
    });
    client.rule('model/list', () => ({
      models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', default: true, efforts: ['low', 'high'], defaultEffort: 'high' }],
    }));
    const sheet = model.settingsSheet();
    await sheet.load();
    expect([sheet.modelId, sheet.effort, sheet.canChangeModel, sheet.note]).toEqual(['gpt-5-codex', 'low', false, undefined]);
    live(1, [['turn/started', { turn: turn('t1') }]]);
    expect(sheet.note).toBe('Applies after this turn');
    sheet.selectEffort('high');
    const saved = sheet.save();
    await settle();
    expect(client.last('session/settings/update').params).toEqual({ sessionId: SID, settings: { effort: 'high' } });
    client.last('session/settings/update').resolve({ session: snapshot(2).session });
    expect(await saved).toBe(true);
  });

  it('a session whose settings name no model or effort gives the sheet none', async () => {
    const { model } = await setup({ agents: () => [codex(['model'])], over: { session: { ...snapshot(0).session, settings: {} } } });
    const sheet = model.settingsSheet();
    expect(sheet.canChangeEffort).toBe(false);
    expect(sheet.change).toEqual({});
  });
});
