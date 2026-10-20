import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeTransport, rpcError, settle } from '../../../../test/replica-doubles';
import { SID, approval, ev, eventsResult, inputRequest, snapshot } from '../../../../test/replica-fixtures';
import { Replica } from '../../../replica/replica';
import { ApprovalsModel } from './approvals-model';
import { DeviceNames } from './devices';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ME = 'dev_phone';

function question(over: Record<string, unknown> = {}): any {
  return {
    ...inputRequest('q1'),
    isBlocking: false,
    questions: [
      { id: 'folder', header: 'Folder', question: 'Which folder?', options: [{ label: 'Here', description: '' }, { label: 'Desktop', description: '' }], isOther: true, isSecret: false },
      { id: 'token', header: 'Token', question: 'Your token?', isOther: false, isSecret: true },
    ],
    ...over,
  };
}

async function setup(pending: { approvals?: any[]; inputs?: any[] } = {}, names: Record<string, string> = { dev_mac: 'Mabue MacBook' }) {
  const client = new FakeTransport();
  client.rule('device/list', () => ({
    devices: Object.entries(names).map(([clientId, displayName]) => ({ clientId, displayName, platform: 'macos', createdAt: 1, lastSeenAt: 2, current: false })),
  }));
  const replica = new Replica({ client, storage: null });
  client.goReady();
  const devices = new DeviceNames(client);
  const model = new ApprovalsModel({ sessionId: SID, replica, clientId: ME, deviceName: (id) => devices.nameOf(id), noticeMs: 5000 });
  const opened = replica.open(SID);
  client.last('session/open').resolve(snapshot(3, [], { pending: { approvals: pending.approvals ?? [], inputs: pending.inputs ?? [] } }));
  await opened;
  await settle();
  let seq = 3;
  const live = (method: string, params: Record<string, unknown>) => client.notify(method, ev(++seq, method, params).params);
  return { client, replica, model, live };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ApprovalsModel: cards', () => {
  it('pending requests from session/open show at once; live approval/request adds a card; request/resolved removes it', async () => {
    const { model, live } = await setup({ approvals: [approval('r1')], inputs: [question()] });
    expect(model.approvals.map((c) => c.requestId)).toEqual(['r1']);
    expect(model.inlineQuestions.map((c) => c.requestId)).toEqual(['q1']);
    expect(model.count).toBe(2);
    live('approval/request', { request: { ...approval('r2'), createdAt: 5 } });
    expect(model.approvals.map((c) => c.requestId)).toEqual(['r1', 'r2']);
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: ME, decision: 'accept' });
    expect(model.approvals.map((c) => c.requestId)).toEqual(['r2']);
    expect(model.notices).toEqual([]); // this device answered: nothing to say
  });

  it('pending requests come back after a reconnect (events-mode session/open)', async () => {
    const { client, model } = await setup();
    expect(model.count).toBe(0);
    client.goReady(); // a new stream: the Replica opens again with its cursor
    client.last('session/open').resolve(eventsResult([], 3, { pending: { approvals: [approval('r7')], inputs: [] } }));
    await settle();
    expect(model.approvals.map((c) => c.requestId)).toEqual(['r7']);
  });

  it('blocking questions are pinned, the others inline', async () => {
    const { model } = await setup({ inputs: [question(), question({ requestId: 'q2', isBlocking: true })] });
    expect(model.inlineQuestions.map((c) => c.requestId)).toEqual(['q1']);
    expect(model.pinnedQuestions.map((c) => c.requestId)).toEqual(['q2']);
  });
});

describe('ApprovalsModel: deciding', () => {
  it('approval/resolve with the decision; buttons disabled while it is in flight; the card goes on ok', async () => {
    const { client, model } = await setup({ approvals: [{ ...approval('r1'), availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] }] });
    expect(model.approvals[0]!.buttons.map((b) => b.label)).toEqual(['Accept', 'Accept for session', 'Decline', 'Cancel']);
    const done = model.decide('r1', 'acceptForSession');
    expect(client.last('approval/resolve').params).toEqual({ sessionId: SID, requestId: 'r1', decision: 'acceptForSession' });
    expect(model.approvals[0]!.sending).toBe('acceptForSession');
    void model.decide('r1', 'decline'); // ignored while one is in flight
    expect(client.count('approval/resolve')).toBe(1);
    client.last('approval/resolve').resolve({ ok: true });
    await done;
    expect(model.approvals).toEqual([]);
    expect(model.notices).toEqual([]);
  });

  it('refuses decisions the adapter did not offer', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] }); // accept, decline
    await model.decide('r1', 'cancel');
    expect(client.count('approval/resolve')).toBe(0);
  });

  it('already_resolved dismisses the card with "answered on <device>"', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    client.last('approval/resolve').reject(rpcError('already_resolved', { resolvedBy: 'dev_mac' }));
    await done;
    await settle();
    expect(model.approvals).toEqual([]);
    expect(model.notices).toEqual([{ requestId: 'r1', title: 'Run this command?', text: 'Answered on Mabue MacBook' }]);
  });

  it('not_found dismisses the card with a short notice', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    client.last('approval/resolve').reject(rpcError('not_found'));
    await done;
    expect(model.notices.map((n) => n.text)).toEqual(['No longer waiting for an answer']);
  });

  it('a failed send keeps the card with the error and lets the user try again', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    client.last('approval/resolve').reject(rpcError('connection_lost'));
    await done;
    expect(model.approvals[0]).toMatchObject({ requestId: 'r1', error: 'Not sent: connection_lost' });
    expect(model.approvals[0]!.sending).toBeUndefined();
    const again = model.decide('r1', 'decline');
    expect(model.approvals[0]!.error).toBeUndefined();
    client.last('approval/resolve').resolve({ ok: true });
    await again;
    expect(model.approvals).toEqual([]);
  });

  it('the host event arriving before the response leaves no notice for our own answer', async () => {
    const { client, model, live } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: ME, decision: 'accept' });
    client.last('approval/resolve').resolve({ ok: true });
    await done;
    expect(model.notices).toEqual([]);
  });
});

describe('ApprovalsModel: answered elsewhere', () => {
  it('request/resolved naming another client leaves "answered on <device>", which fades', async () => {
    vi.useFakeTimers();
    const { model, live } = await setup({ approvals: [approval('r1')] });
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: 'dev_mac', decision: 'decline' });
    expect(model.approvals).toEqual([]);
    expect(model.notices[0]!.text).toBe('Answered on another device'); // until device/list answers
    await settle();
    expect(model.notices[0]!.text).toBe('Answered on Mabue MacBook');
    vi.advanceTimersByTime(5000);
    expect(model.notices).toEqual([]);
  });

  it('an unknown device keeps the generic text; the agent withdrawing says so; dismiss removes a notice', async () => {
    const { model, live } = await setup({ approvals: [approval('r1'), approval('r2')] });
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: 'dev_tablet' });
    live('request/resolved', { requestId: 'r2', kind: 'command', resolvedBy: 'agent', decision: 'cancel' });
    await settle();
    expect(model.notices.map((n) => n.text)).toEqual(['Answered on another device', 'Withdrawn by the agent']);
    model.dismissNotice('r1');
    expect(model.notices.map((n) => n.requestId)).toEqual(['r2']);
  });

  it('a card dropped by a reconnect snapshot (no resolution known) says it was answered elsewhere', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] });
    client.goReady();
    client.last('session/open').resolve(eventsResult([], 3, { pending: { approvals: [], inputs: [] } }));
    await settle();
    expect(model.notices.map((n) => n.text)).toEqual(['Answered on another device']);
  });
});

describe('ApprovalsModel: questions', () => {
  it('builds the form, then sends input/answer keyed by question id', async () => {
    const { client, model } = await setup({ inputs: [question()] });
    let card = model.inlineQuestions[0]!;
    expect(card.canSubmit).toBe(false);
    expect(card.questions.map((q) => ({ id: q.id, text: q.text, isOther: q.isOther, secret: q.secret, multi: q.multi }))).toEqual([
      { id: 'folder', text: true, isOther: true, secret: false, multi: false },
      { id: 'token', text: true, isOther: false, secret: true, multi: false },
    ]);
    model.toggle('q1', 'folder', 'Desktop');
    model.setText('q1', 'token', 'abc123');
    card = model.inlineQuestions[0]!;
    expect(card.questions[0]!.options.map((o) => o.selected)).toEqual([false, true]);
    expect(card.canSubmit).toBe(true);
    const done = model.submit('q1');
    expect(client.last('input/answer').params).toEqual({ sessionId: SID, requestId: 'q1', answers: { folder: ['Desktop'], token: ['abc123'] } });
    expect(model.inlineQuestions[0]!.sending).toBe(true);
    client.last('input/answer').resolve({ ok: true });
    await done;
    expect(model.questions).toEqual([]);
    expect(model.notices).toEqual([]);
  });

  it('does not send an incomplete form', async () => {
    const { client, model } = await setup({ inputs: [question()] });
    model.toggle('q1', 'folder', 'Here');
    await model.submit('q1');
    expect(client.count('input/answer')).toBe(0);
  });

  it('multi-select questions toggle options', async () => {
    const q = question({ questions: [{ id: 'pick', header: '', question: 'Which?', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], isOther: false, isSecret: false, multiSelect: true }] });
    const { client, model } = await setup({ inputs: [q] });
    model.toggle('q1', 'pick', 'B');
    model.toggle('q1', 'pick', 'A');
    expect(model.inlineQuestions[0]!.questions[0]!.multi).toBe(true);
    const done = model.submit('q1');
    expect(client.last('input/answer').params.answers).toEqual({ pick: ['A', 'B'] });
    client.last('input/answer').resolve({ ok: true });
    await done;
  });
});

describe('DeviceNames', () => {
  it('shares one device/list call and refreshes once for a clientId it does not know', async () => {
    const client = new FakeTransport();
    let names: Record<string, string> = { dev_mac: 'Mac' };
    client.rule('device/list', () => ({ devices: Object.entries(names).map(([clientId, displayName]) => ({ clientId, displayName })) }));
    const devices = new DeviceNames(client);
    expect(await Promise.all([devices.nameOf('dev_mac'), devices.nameOf('dev_mac')])).toEqual(['Mac', 'Mac']);
    expect(client.count('device/list')).toBe(1);
    names = { dev_mac: 'Mac', dev_new: 'New phone' };
    expect(await devices.nameOf('dev_new')).toBe('New phone');
    expect(await devices.nameOf('dev_ghost')).toBeUndefined();
    expect(await devices.nameOf('dev_ghost')).toBeUndefined();
    expect(client.count('device/list')).toBe(3);
  });

  it('a failing device/list gives no name', async () => {
    const client = new FakeTransport();
    client.rule('device/list', () => {
      throw rpcError('internal');
    });
    expect(await new DeviceNames(client).nameOf('dev_mac')).toBeUndefined();
  });
});
