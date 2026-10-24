// The push rules (spec 9) with a fake sender, the real PresenceRegistry and a real (in-memory) device
// store for the subscriptions.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceStore } from '../devices/store.js';
import type { PushSubscription } from '../generated/common.js';
import type { JournalEvent } from '../journal/types.js';
import { PresenceRegistry } from '../stream/presence.js';
import { MAX_PUSH_TITLE, PUSH_BODY, PushNotifier, pushTitle, type PushNotifierLogFields } from './notifier.js';
import type { PushPayload, SendOptions, SendResult } from './sender.js';

interface Sent {
  clientId: string;
  subscription: PushSubscription;
  payload: PushPayload;
  options: SendOptions;
}

class FakeSender {
  readonly sent: Sent[] = [];
  /** Result per clientId; default delivered. */
  results = new Map<string, SendResult | Error>();
  send(clientId: string, subscription: PushSubscription, payload: PushPayload, options: SendOptions = {}): Promise<SendResult> {
    this.sent.push({ clientId, subscription, payload, options });
    const result = this.results.get(clientId) ?? { outcome: 'delivered', status: 201 };
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

const SESSION = 'ses_1';
const TITLE = 'Fix the login bug';

let devices: DeviceStore;
let presence: PresenceRegistry;
let sender: FakeSender;
let logs: { event: string; fields: PushNotifierLogFields }[];
let notifier: PushNotifier;

function pair(name: string): string {
  const { device } = devices.create({ displayName: name, platform: 'ios-web' });
  const subscription = {
    endpoint: `https://web.push.apple.com/${name}-endpoint`,
    keys: { p256dh: `${name}-p256dh`, auth: `${name}-auth` },
  };
  expect(devices.push.subscribe(device.clientId, subscription)).toBe(true);
  return device.clientId;
}

/** Opens a stream for the client; returns the close function. */
function connectStream(clientId: string): () => void {
  const handle = {};
  presence.open(clientId, handle);
  return () => presence.close(clientId, handle);
}

let seq = 0;
const ev = (method: string, params: Record<string, unknown>): JournalEvent =>
  ({ method, params: { sessionId: SESSION, seq: ++seq, ...params } }) as unknown as JournalEvent;

const SECRET_COMMAND = 'rm -rf /Users/mabue/secret-project/.env';
const SECRET_PATH = '/Users/mabue/secret-project/src/auth.ts';

const approval = (requestId = 'req_a1') =>
  ev('approval/request', {
    request: {
      requestId,
      kind: 'command',
      sessionId: SESSION,
      turnId: 'trn_1',
      itemId: 'itm_1',
      reason: 'May I delete the env file?',
      command: SECRET_COMMAND,
      cwd: '/Users/mabue/secret-project',
      expiresAt: null,
    },
  });
const fileApproval = () =>
  ev('approval/request', {
    request: {
      requestId: 'req_f1',
      kind: 'fileChange',
      sessionId: SESSION,
      turnId: 'trn_1',
      itemId: 'itm_2',
      changes: [{ path: SECRET_PATH, kind: 'update', diff: '+const password = "hunter2";' }],
      expiresAt: null,
    },
  });
const input = (requestId = 'req_i1') =>
  ev('input/request', {
    request: {
      requestId,
      kind: 'input',
      sessionId: SESSION,
      turnId: 'trn_1',
      itemId: 'itm_3',
      isBlocking: true,
      questions: [{ id: 'q1', question: 'Which database password should I use?', options: [] }],
    },
  });
const completed = (status: 'completed' | 'failed' | 'interrupted' = 'completed', turnId = 'trn_1') =>
  ev('turn/completed', {
    turn: {
      turnId,
      status,
      startedAt: 1,
      completedAt: 2,
      error: status === 'failed' ? { message: `cannot open ${SECRET_PATH}` } : null,
      items: ['itm_1'],
    },
  });
const statusChanged = (status: string) => ev('status/changed', { status });
const resolved = () => ev('request/resolved', { requestId: 'req_a1', kind: 'command', resolvedBy: 'dev_other', decision: 'accept' });

async function emit(...events: JournalEvent[]): Promise<void> {
  for (const event of events) notifier.handle(event);
  await notifier.idle();
}

beforeEach(() => {
  devices = new DeviceStore({ path: ':memory:' });
  presence = new PresenceRegistry();
  sender = new FakeSender();
  logs = [];
  notifier = new PushNotifier({
    subscriptions: devices.push,
    presence,
    sender,
    title: (sessionId) => (sessionId === SESSION ? TITLE : undefined),
    log: (event, fields) => logs.push({ event, fields }),
  });
});

afterEach(async () => {
  await notifier.close();
  devices.close();
});

describe('push rules (spec 9)', () => {
  it('approval/request pushes while connected', async () => {
    const phone = pair('phone');
    connectStream(phone);
    await emit(approval());
    expect(sender.sent).toEqual([
      {
        clientId: phone,
        subscription: devices.push.get(phone)!.subscription,
        payload: { title: TITLE, body: PUSH_BODY.approval, url: `/s/${SESSION}` },
        options: { ttl: 60, topic: 'req_a1' },
      },
    ]);
  });

  it('approval/request pushes while disconnected', async () => {
    const phone = pair('phone');
    await emit(approval());
    expect(sender.sent.map((s) => [s.clientId, s.payload.body, s.options])).toEqual([[phone, 'Approval needed', { ttl: 60, topic: 'req_a1' }]]);
  });

  it('input/request pushes always, with the request id as topic and a 60 s TTL', async () => {
    const phone = pair('phone');
    await emit(input('req_i1'));
    const close = connectStream(phone);
    await emit(input('req_i2'));
    close();
    expect(sender.sent.map((s) => [s.payload.body, s.payload.url, s.options])).toEqual([
      ['Question waiting', `/s/${SESSION}`, { ttl: 60, topic: 'req_i1' }],
      ['Question waiting', `/s/${SESSION}`, { ttl: 60, topic: 'req_i2' }],
    ]);
  });

  it('turn/completed does not push to a client with an open stream', async () => {
    const phone = pair('phone');
    connectStream(phone);
    await emit(completed());
    expect(sender.sent).toEqual([]);
  });

  it('turn/completed pushes to a client without an open stream, body by final status, turn id topic, 1 h TTL', async () => {
    const phone = pair('phone');
    await emit(completed('completed', 'trn_1'), completed('failed', 'trn_2'), completed('interrupted', 'trn_3'));
    expect(sender.sent.map((s) => [s.clientId, s.payload, s.options])).toEqual([
      [phone, { title: TITLE, body: 'Turn finished', url: `/s/${SESSION}` }, { ttl: 3600, topic: 'trn_1' }],
      [phone, { title: TITLE, body: 'Turn failed', url: `/s/${SESSION}` }, { ttl: 3600, topic: 'trn_2' }],
      [phone, { title: TITLE, body: 'Turn interrupted', url: `/s/${SESSION}` }, { ttl: 3600, topic: 'trn_3' }],
    ]);
  });

  const tasks = (...statuses: string[]) =>
    ev('session/changed', {
      session: {
        sessionId: SESSION,
        title: TITLE,
        backgroundTasks: statuses.map((status, n) => ({ id: `toolu_${n}`, title: `task ${n}`, status, startedAt: 1 })),
      },
    });

  it('the last running background task ending pushes "Background tasks finished" to a client without an open stream', async () => {
    const phone = pair('phone');
    await emit(tasks('running', 'running'), tasks('running', 'finished'));
    expect(sender.sent).toEqual([]);
    await emit(tasks('finished', 'cancelled'));
    expect(sender.sent.map((s) => [s.clientId, s.payload, s.options])).toEqual([
      [phone, { title: TITLE, body: 'Background tasks finished', url: `/s/${SESSION}` }, { ttl: 3600, topic: `${SESSION}.background` }],
    ]);
    // Nothing ran since: an empty list, or one with only ended tasks, pushes nothing more.
    await emit(tasks(), tasks('failed'));
    expect(sender.sent).toHaveLength(1);
  });

  it('background tasks the host cancels (kill, shutdown, restart recovery) never push "Background tasks finished"', async () => {
    pair('phone');
    // The host cancels every running task at once; an earlier finished one does not make it a finish.
    await emit(tasks('running', 'running'), tasks('finished', 'running'), tasks('finished', 'cancelled'));
    // Restart recovery: the notifier starts empty and sees the journaled list, then the cancel.
    await emit(tasks('running'), tasks('cancelled'));
    expect(sender.sent).toEqual([]);
    // The engine ending the last one finished or failed still pushes.
    await emit(tasks('running'), tasks('failed'));
    expect(sender.sent.map((s) => s.payload.body)).toEqual(['Background tasks finished']);
  });

  it('background tasks ending do not push to a client with an open stream, nor without tasks ever running', async () => {
    const phone = pair('phone');
    await emit(tasks('finished'));
    connectStream(phone);
    await emit(tasks('running'), tasks());
    expect(sender.sent).toEqual([]);
  });

  it('status/changed to error does not push to a client with an open stream', async () => {
    const phone = pair('phone');
    connectStream(phone);
    await emit(statusChanged('error'));
    expect(sender.sent).toEqual([]);
  });

  it('status/changed to error pushes to a client without an open stream, session id topic', async () => {
    const phone = pair('phone');
    await emit(statusChanged('error'));
    expect(sender.sent.map((s) => [s.clientId, s.payload.body, s.payload.url, s.options])).toEqual([
      [phone, 'Session error', `/s/${SESSION}`, { ttl: 3600, topic: SESSION }],
    ]);
  });

  it('status/changed to anything but error never pushes', async () => {
    pair('phone');
    await emit(...['idle', 'running', 'waiting_approval', 'waiting_input', 'closed'].map(statusChanged));
    expect(sender.sent).toEqual([]);
  });

  it('request/resolved never pushes, connected or not', async () => {
    const phone = pair('phone');
    await emit(resolved());
    connectStream(phone);
    await emit(resolved());
    expect(sender.sent).toEqual([]);
  });

  it('every other event never pushes', async () => {
    pair('phone');
    await emit(
      ev('session/changed', { session: { title: 'x' } }),
      ev('turn/started', { turn: { turnId: 'trn_1', status: 'inProgress', items: [] } }),
      ev('item/started', { item: { itemId: 'itm_1', type: 'agentMessage', turnId: 'trn_1', status: 'inProgress', text: 'hi' } }),
      ev('item/delta', { itemId: 'itm_1', field: 'text', delta: 'hi' }),
      ev('item/completed', { item: { itemId: 'itm_1', type: 'agentMessage', turnId: 'trn_1', status: 'completed', text: 'hi' } }),
      ev('request/withdrawn', { requestId: 'req_a1' }),
      ev('usage/updated', { usage: {} }),
    );
    expect(sender.sent).toEqual([]);
  });

  it('evaluates every client separately: two clients, one connected', async () => {
    const phone = pair('phone');
    const laptop = pair('laptop');
    connectStream(laptop);
    await emit(completed());
    expect(sender.sent.map((s) => s.clientId)).toEqual([phone]);
    await emit(statusChanged('error'));
    expect(sender.sent.map((s) => s.clientId)).toEqual([phone, phone]);
    sender.sent.length = 0;
    await emit(approval());
    expect(sender.sent.map((s) => s.clientId).sort()).toEqual([phone, laptop].sort());
    expect(sender.sent.find((s) => s.clientId === laptop)!.subscription.endpoint).toContain('laptop');
  });

  it('reads presence at the moment of the event, with no grace window', async () => {
    const phone = pair('phone');
    const laptop = pair('laptop');
    const closeLaptop = connectStream(laptop);
    // The phone reconnects and the laptop drops before the deferred send runs: the decision stands.
    notifier.handle(completed());
    connectStream(phone);
    closeLaptop();
    await notifier.idle();
    expect(sender.sent.map((s) => s.clientId)).toEqual([phone]);
  });

  it('sends off the append path: handle returns before the sender is called and never waits on it', async () => {
    pair('phone');
    let release!: () => void;
    const hanging = new Promise<SendResult>((resolve) => (release = () => resolve({ outcome: 'delivered', status: 201 })));
    const calls: string[] = [];
    const slow = new PushNotifier({
      subscriptions: devices.push,
      presence,
      sender: { send: (clientId) => (calls.push(clientId), hanging) },
      title: () => TITLE,
    });
    slow.handle(approval());
    expect(calls).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    slow.handle(approval('req_a2')); // does not wait on the hanging first send
    release();
    await slow.close();
    expect(calls).toHaveLength(2);
  });

  it('a gone result deletes the subscription; the next event sends nothing', async () => {
    const phone = pair('phone');
    sender.results.set(phone, { outcome: 'gone', status: 410 });
    await emit(approval());
    expect(devices.push.isSubscribed(phone)).toBe(false);
    expect(logs).toEqual([{ event: 'push.expired', fields: { clientId: phone, kind: 'approval', outcome: 'gone', statusCode: 410 } }]);
    await emit(approval('req_a2'));
    expect(sender.sent).toHaveLength(1);
  });

  it('failed and error results are logged and dropped; the subscription stays and nothing is retried', async () => {
    const phone = pair('phone');
    const laptop = pair('laptop');
    const tablet = pair('tablet');
    sender.results.set(phone, { outcome: 'failed', status: 500 });
    sender.results.set(laptop, { outcome: 'error', reason: 'timeout' });
    sender.results.set(tablet, new Error('sender bug'));
    await emit(completed());
    expect(sender.sent).toHaveLength(3);
    expect(devices.push.list()).toHaveLength(3);
    expect(logs.map((l) => l.fields).sort((a, b) => a.clientId.localeCompare(b.clientId))).toEqual(
      [
        { clientId: phone, kind: 'completion', outcome: 'failed', statusCode: 500 },
        { clientId: laptop, kind: 'completion', outcome: 'error', reason: 'timeout' },
        { clientId: tablet, kind: 'completion', outcome: 'error', reason: 'network' },
      ].sort((a, b) => a.clientId.localeCompare(b.clientId)),
    );
    expect(logs.every((l) => l.event === 'push.dropped')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sender.sent).toHaveLength(3);
  });

  it('a revoked device never receives a push: the revoke cascade removed its subscription', async () => {
    const phone = pair('phone');
    const laptop = pair('laptop');
    expect(devices.revoke(phone)).toBe(true);
    expect(devices.push.list().map((s) => s.clientId)).toEqual([laptop]);
    await emit(approval(), completed(), statusChanged('error'));
    expect(sender.sent.map((s) => s.clientId)).toEqual([laptop, laptop, laptop]);
  });

  it('isPaired guards a subscription row whose device is gone', async () => {
    const phone = pair('phone');
    const guarded = new PushNotifier({ subscriptions: devices.push, presence, sender, title: () => TITLE, isPaired: (id) => id !== phone });
    guarded.handle(approval());
    await guarded.close();
    expect(sender.sent).toEqual([]);
  });

  it('payloads carry {title, body, url} only, never command text, paths, questions or error messages', async () => {
    pair('phone');
    await emit(
      approval(),
      fileApproval(),
      input(),
      completed('failed'),
      statusChanged('error'),
      ev('item/completed', { item: { itemId: 'itm_9', type: 'agentMessage', turnId: 'trn_1', status: 'completed', text: 'the secret is 42' } }),
    );
    expect(sender.sent).toHaveLength(5);
    for (const { payload } of sender.sent) expect(Object.keys(payload).sort()).toEqual(['body', 'title', 'url']);
    const all = JSON.stringify(sender.sent.map((s) => s.payload));
    for (const secret of [SECRET_COMMAND, 'rm -rf', 'secret-project', SECRET_PATH, 'hunter2', 'database password', 'May I delete', 'cannot open', 'secret is 42']) {
      expect(all).not.toContain(secret);
    }
  });

  it('cuts the session title to one line of at most 60 characters', async () => {
    pair('phone');
    const long = `First line of a very long session title\nthat goes on and on ${'x'.repeat(80)}`;
    const titled = new PushNotifier({ subscriptions: devices.push, presence, sender, title: () => long });
    titled.handle(approval());
    await titled.close();
    const title = sender.sent[0]!.payload.title;
    expect(title).not.toContain('\n');
    expect([...title].length).toBeLessThanOrEqual(MAX_PUSH_TITLE);
    expect(title.startsWith('First line of a very long session title that goes on')).toBe(true);
    expect(pushTitle('  Short  \t title ')).toBe('Short title');
    expect(pushTitle('')).toBe('Nano Host');
    expect(pushTitle(undefined)).toBe('Nano Host');
  });
});
