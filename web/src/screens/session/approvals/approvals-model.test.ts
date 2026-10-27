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
  const model = new ApprovalsModel({ sessionId: SID, replica, clientId: ME, deviceName: (id) => devices.nameOf(id) });
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

const lines = (model: ApprovalsModel) => model.answered.map((r) => ({ requestId: r.requestId, text: r.text, tone: r.tone, mark: r.mark }));

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
    // This device's clientId (another tab, or before this screen opened): its own words, no device.
    expect(lines(model)).toEqual([{ requestId: 'r1', text: 'Approved', tone: 'ok', mark: 'check' }]);
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
    expect(model.approvals[0]!.buttons.map((b) => b.label)).toEqual(['Accept', 'Accept for this session', 'Decline', 'Cancel the turn']);
    const done = model.decide('r1', 'acceptForSession');
    expect(client.last('approval/resolve').params).toEqual({ sessionId: SID, requestId: 'r1', decision: 'acceptForSession' });
    expect(model.approvals[0]!.sending).toBe('acceptForSession');
    void model.decide('r1', 'decline'); // ignored while one is in flight
    expect(client.count('approval/resolve')).toBe(1);
    client.last('approval/resolve').resolve({ ok: true });
    await done;
    expect(model.approvals).toEqual([]);
    expect(model.answered).toEqual([
      { requestId: 'r1', kind: 'approval', requestKind: 'command', turnId: 't1', itemId: approval('r1').itemId, title: 'Run this command?', text: 'Accepted for this session', tone: 'ok', mark: 'check' },
    ]);
  });

  it('each decision leaves its own line where the card was', async () => {
    const all = ['accept', 'acceptForSession', 'decline', 'cancel'];
    const { client, model } = await setup({ approvals: ['a', 'b', 'c', 'd'].map((id, i) => ({ ...approval(id), createdAt: i, availableDecisions: all })) });
    for (const [id, decision] of [['a', 'accept'], ['b', 'decline'], ['c', 'cancel'], ['d', 'acceptForSession']] as const) {
      const done = model.decide(id, decision);
      client.last('approval/resolve').resolve({ ok: true });
      await done;
    }
    expect(lines(model).map((l) => [l.requestId, l.text, l.tone, l.mark])).toEqual([
      ['a', 'Approved', 'ok', 'check'],
      ['b', 'Declined', 'muted', 'x'],
      ['c', 'Turn cancelled', 'muted', 'x'],
      ['d', 'Accepted for this session', 'ok', 'check'],
    ]);
  });

  it('refuses decisions the adapter did not offer', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] }); // accept, decline
    await model.decide('r1', 'cancel');
    expect(client.count('approval/resolve')).toBe(0);
  });

  it('already_resolved turns the card into "answered on <device>"', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    client.last('approval/resolve').reject(rpcError('already_resolved', { resolvedBy: 'dev_mac' }));
    await done;
    await settle();
    expect(model.approvals).toEqual([]);
    expect(lines(model)).toEqual([{ requestId: 'r1', text: 'Answered on Mabue MacBook', tone: 'muted', mark: 'check' }]);
    expect(model.answered[0]!.title).toBe('Run this command?');
  });

  it('not_found turns the card into "No longer waiting"', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    client.last('approval/resolve').reject(rpcError('not_found'));
    await done;
    expect(lines(model)).toEqual([{ requestId: 'r1', text: 'No longer waiting', tone: 'muted', mark: 'x' }]);
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
    expect(lines(model).map((l) => l.text)).toEqual(['Declined']);
  });

  it('the host event arriving before the response: the card turns into our line at once, never a gap', async () => {
    const { client, model, live } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: ME, decision: 'accept' });
    expect(model.approvals).toEqual([]);
    expect(lines(model).map((l) => l.text)).toEqual(['Approved']); // before the response
    client.last('approval/resolve').resolve({ ok: true });
    await done;
    expect(lines(model).map((l) => l.text)).toEqual(['Approved']);
  });

  it('our answer in flight when another device wins: the line is corrected to the winner', async () => {
    const { client, model, live } = await setup({ approvals: [approval('r1')] });
    const done = model.decide('r1', 'accept');
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: 'dev_mac', decision: 'decline' });
    client.last('approval/resolve').reject(rpcError('already_resolved', { resolvedBy: 'dev_mac' }));
    await done;
    await settle();
    expect(lines(model)).toEqual([{ requestId: 'r1', text: 'Declined on Mabue MacBook', tone: 'muted', mark: 'x' }]);
  });
});

describe('ApprovalsModel: answered elsewhere', () => {
  it('request/resolved naming another client: "Approved on <device>", which stays', async () => {
    vi.useFakeTimers();
    const { model, live } = await setup({ approvals: [approval('r1')] });
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: 'dev_mac', decision: 'accept' });
    expect(model.approvals).toEqual([]);
    expect(lines(model)[0]!.text).toBe('Approved on another device'); // until device/list answers
    await settle();
    expect(lines(model)[0]).toEqual({ requestId: 'r1', text: 'Approved on Mabue MacBook', tone: 'ok', mark: 'check' });
    vi.advanceTimersByTime(60_000);
    expect(lines(model).map((l) => l.text)).toEqual(['Approved on Mabue MacBook']); // no fading, no dismiss
  });

  it('an unknown device keeps the generic text; the agent withdrawing says so', async () => {
    const { model, live } = await setup({ approvals: [approval('r1'), approval('r2')] });
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: 'dev_tablet' });
    live('request/resolved', { requestId: 'r2', kind: 'command', resolvedBy: 'agent', decision: 'cancel' });
    await settle();
    expect(lines(model).map((l) => l.text)).toEqual(['Answered on another device', 'Withdrawn by the agent']);
  });

  it('a card dropped by a reconnect snapshot (no resolution known) says it was answered elsewhere', async () => {
    const { client, model } = await setup({ approvals: [approval('r1')] });
    client.goReady();
    client.last('session/open').resolve(eventsResult([], 3, { pending: { approvals: [], inputs: [] } }));
    await settle();
    expect(lines(model).map((l) => l.text)).toEqual(['Answered on another device']);
  });

  it('a question answered on another device shows the device and the answer it sent', async () => {
    const { model, live } = await setup({ inputs: [question()] });
    live('request/resolved', { requestId: 'q1', kind: 'input', resolvedBy: 'dev_mac', answers: { folder: ['Desktop'], token: ['hunter2'] } });
    await settle();
    expect(model.answered[0]).toMatchObject({ kind: 'question', requestKind: 'input', title: '2 questions', text: 'Answered on Mabue MacBook: Desktop · ••••' });
    live('input/request', { request: { ...question(), requestId: 'q2' } });
    live('request/resolved', { requestId: 'q2', kind: 'input', resolvedBy: 'agent' });
    expect(model.answered[1]!.text).toBe('Answered by the agent');
  });

  it('a device name that arrives after the screen closed changes nothing', async () => {
    const { model, live } = await setup({ approvals: [approval('r1')] });
    live('request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: 'dev_mac', decision: 'decline' });
    model.dispose();
    await settle();
    expect(lines(model)[0]!.text).toBe('Declined on another device');
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
    // The answered line shows the answer, the secret hidden.
    expect(model.answered).toEqual([
      { requestId: 'q1', kind: 'question', requestKind: 'input', turnId: 't1', itemId: 'i8', title: '2 questions', text: 'Desktop · ••••', tone: 'muted', mark: 'check' },
    ]);
  });

  it('"Other…": choosing it opens its field, typing makes the answer, picking an option closes it', async () => {
    const one = question({ questions: [question().questions[0]] });
    const { client, model } = await setup({ inputs: [one] });
    const card = () => model.inlineQuestions[0]!;
    expect(card().title).toBe('Which folder?');
    expect(card().questions[0]!.isOther).toBe(true);
    model.toggle('q1', 'folder', 'Here');
    model.chooseOther('q1', 'folder');
    expect(card().questions[0]).toMatchObject({ otherOn: true, other: '' });
    expect(card().questions[0]!.options.map((o) => o.selected)).toEqual([false, false]);
    expect(card().canSubmit).toBe(false);
    model.setText('q1', 'folder', '~/code');
    expect(card().canSubmit).toBe(true);
    model.toggle('q1', 'folder', 'Desktop');
    expect(card().questions[0]).toMatchObject({ otherOn: false, other: '' });
    model.chooseOther('q1', 'folder');
    model.setText('q1', 'folder', '~/code');
    const done = model.submit('q1');
    expect(client.last('input/answer').params.answers).toEqual({ folder: ['~/code'] });
    client.last('input/answer').resolve({ ok: true });
    await done;
    expect(model.answered[0]!.text).toBe('~/code');
  });

  it('a failed answer keeps the form with its error; editing clears the error', async () => {
    const { client, model } = await setup({ inputs: [question()] });
    model.toggle('q1', 'folder', 'Here');
    model.setText('q1', 'token', 'abc');
    const done = model.submit('q1');
    client.last('input/answer').reject(rpcError('connection_lost'));
    await done;
    expect(model.inlineQuestions[0]).toMatchObject({ error: 'Not sent: connection_lost', sending: false, canSubmit: true });
    expect(model.answered).toEqual([]);
    model.toggle('q1', 'folder', 'Desktop');
    expect(model.inlineQuestions[0]!.error).toBeUndefined();
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
