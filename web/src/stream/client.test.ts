import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSocket, HostScript, INIT_RESULT, ManualLifecycle } from '../../test/doubles';
import { LocalError, RequestError, StreamClient, type ClientState, type StreamClientOptions } from './client';
import { CloseCode, DEFAULT_TIMING, MAX_MESSAGE_BYTES } from './constants';
import { browserLifecycle } from './lifecycle';

function setup(options: Partial<StreamClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const hosts: HostScript[] = [];
  const lifecycle = new ManualLifecycle();
  let n = 0;
  const client = new StreamClient({
    clientId: 'dev_test',
    url: 'ws://fake/v1/stream',
    lifecycle,
    newStreamId: () => `stream-${++n}`,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      hosts.push(new HostScript(socket, `stream-${n}`));
      return socket;
    },
    ...options,
  });
  const states: [ClientState, string][] = [];
  client.on('state', (state, detail) => states.push([state, detail]));
  const socket = () => sockets.at(-1)!;
  const host = () => hosts.at(-1)!;
  /** Opens the newest socket and answers initialize. */
  const handshake = (result: object = INIT_RESULT) => {
    socket().open();
    host().answer('initialize', result);
  };
  return { client, sockets, lifecycle, states, socket, host, handshake };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('StreamClient handshake (spec 4)', () => {
  it('opens a stream, pings, sends initialize with protocolVersion 1, then initialized, then is ready', () => {
    const { client, socket, handshake, states } = setup({ optOutNotifications: ['usage/updated'] });
    const ready = vi.fn();
    client.on('ready', ready);
    expect(client.state).toBe('idle');
    client.start();
    client.start(); // idempotent
    expect(client.state).toBe('connecting');
    expect(socket().url).toBe('ws://fake/v1/stream');
    handshake();
    const sent = socket().sent;
    expect(sent[0]).toMatchObject({ type: 'ping', seq_id: 1, state: 'foreground', stream_id: 'stream-1', client_id: 'dev_test' });
    expect(sent[1]).toMatchObject({ type: 'client_message', seq_id: 2, message: { method: 'initialize' } });
    expect(sent[1].message.params).toMatchObject({
      protocolVersion: 1,
      client: { name: 'Nano Remote Web', platform: 'web' },
      optOutNotifications: ['usage/updated'],
    });
    expect(socket().messages[1]).toEqual({ method: 'initialized', params: {} });
    expect(client.state).toBe('ready');
    expect(client.host).toEqual(INIT_RESULT);
    expect(client.streamId).toBe('stream-1');
    expect(ready).toHaveBeenCalledWith(INIT_RESULT, 'stream-1');
    expect(states.map((s) => s[0])).toEqual(['connecting', 'ready']);
  });

  it('queues requests made before the stream is ready and sends them after initialized', async () => {
    const { client, socket, host, handshake } = setup();
    client.start();
    const list = client.request('session/list', { limit: 5 });
    socket().open();
    expect(socket().messages.map((m) => m.method)).toEqual(['initialize']);
    host().answer('initialize', INIT_RESULT);
    expect(socket().messages.map((m) => m.method)).toEqual(['initialize', 'initialized', 'session/list']);
    host().answer('session/list', { sessions: [] });
    await expect(list).resolves.toEqual({ sessions: [] });
    void handshake;
  });

  it('matches responses by id, maps error responses to RequestError, and ignores unknown ids', async () => {
    const { client, socket, host, handshake } = setup();
    client.start();
    handshake();
    const a = client.request('session/open', { sessionId: 's1' });
    const b = client.request('turn/start', { sessionId: 's1' });
    const c = client.request('host/status');
    const [ida, idb, idc] = socket().messages.slice(-3).map((m) => m.id);
    expect(socket().messages.at(-1)).toEqual({ id: idc, method: 'host/status' });
    host().message({ id: 'c-999', result: {} });
    host().message({ id: idb, error: { code: 'session_busy', message: 'busy', data: { turnId: 't1' } } });
    host().message({ id: ida, result: { mode: 'snapshot' } });
    host().message({ id: idc, error: 'garbage' });
    await expect(a).resolves.toEqual({ mode: 'snapshot' });
    const error = await b.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: 'session_busy', message: 'busy', data: { turnId: 't1' } });
    await expect(c).resolves.toEqual({});
    host().message({ id: idc, error: {} }); // already answered: ignored
    host().message('not an object');
    host().message({ id: { weird: true }, result: {} });
  });

  it('defaults missing error fields', async () => {
    const { client, socket, host, handshake } = setup();
    client.start();
    handshake();
    const a = client.request('x');
    host().message({ id: socket().messages.at(-1).id, error: { data: 'not an object' } });
    await expect(a).rejects.toMatchObject({ code: 'internal', message: '', data: undefined });
  });

  it('fails a request with timeout after 30 s, and ignores the late answer', async () => {
    const { client, socket, host, handshake } = setup();
    client.start();
    handshake();
    const slow = client.request('session/list');
    const id = socket().messages.at(-1).id;
    vi.advanceTimersByTime(DEFAULT_TIMING.requestTimeoutMs);
    await expect(slow).rejects.toMatchObject({ code: LocalError.timeout });
    host().message({ id, result: {} });
    const custom = client.request('x', undefined, { timeoutMs: 10 });
    vi.advanceTimersByTime(10);
    await expect(custom).rejects.toMatchObject({ code: LocalError.timeout });
  });

  it('times out a queued request while no stream is ready', async () => {
    const { client } = setup();
    client.start();
    const queued = client.request('session/list', undefined, { timeoutMs: 50 });
    vi.advanceTimersByTime(50);
    await expect(queued).rejects.toMatchObject({ code: LocalError.timeout });
  });

  it('rejects a request above 16 MiB with message_too_large and keeps the stream', async () => {
    const { client, handshake } = setup();
    client.start();
    handshake();
    await expect(client.request('turn/start', { blob: 'z'.repeat(MAX_MESSAGE_BYTES) })).rejects.toMatchObject({
      code: LocalError.tooLarge,
    });
    expect(client.state).toBe('ready');
  });

  it('dispatches notifications by method and to "*" handlers; unsubscribe works', () => {
    const { client, host, handshake } = setup();
    client.start();
    handshake();
    const byMethod = vi.fn();
    const all = vi.fn();
    const off = client.onNotification('item/delta', byMethod);
    client.onNotification('*', all);
    host().message({ method: 'item/delta', params: { seq: 1 } });
    host().message({ method: 'session/updated' });
    off();
    host().message({ method: 'item/delta', params: { seq: 2 } });
    expect(byMethod.mock.calls).toEqual([[{ seq: 1 }, 'item/delta']]);
    expect(all.mock.calls.map((c) => c[1])).toEqual(['item/delta', 'session/updated', 'item/delta']);
    expect(all.mock.calls[1]![0]).toEqual({});
  });

  it('answers a host request with method_not_found (the host sends none in v1)', () => {
    const { client, socket, host, handshake } = setup();
    client.start();
    handshake();
    host().message({ id: 'h-1', method: 'item/tool/call', params: {} });
    expect(socket().messages.at(-1)).toEqual({ id: 'h-1', error: { code: 'method_not_found', message: 'client does not serve item/tool/call' } });
  });

  it('notify sends only on a ready stream', () => {
    const { client, socket, handshake } = setup();
    expect(client.notify('x')).toBe(false);
    client.start();
    handshake();
    expect(client.notify('custom/note', { a: 1 })).toBe(true);
    expect(client.notify('bare')).toBe(true);
    expect(socket().messages.slice(-2)).toEqual([{ method: 'custom/note', params: { a: 1 } }, { method: 'bare' }]);
  });

  it('forwards pong status', () => {
    const { client, host, handshake } = setup();
    const pongs: string[] = [];
    client.on('pong', (s) => pongs.push(s));
    client.start();
    handshake();
    host().pong(1, 'degraded');
    expect(pongs).toEqual(['degraded']);
  });
});

describe('StreamClient close codes and reconnect (spec 2, 10)', () => {
  it.each([CloseCode.sequence, CloseCode.pingTimeout, CloseCode.tooLarge, 1006])(
    'close %i: new stream with a new stream_id after the backoff, initialize again',
    (code) => {
      const { client, sockets, socket, handshake } = setup();
      const ready = vi.fn();
      client.on('ready', ready);
      client.start();
      handshake();
      socket().serverClose(code, 'bye');
      expect(client.state).toBe('waiting');
      vi.advanceTimersByTime(DEFAULT_TIMING.backoffMinMs - 1);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
      handshake();
      expect(client.streamId).toBe('stream-2');
      expect(socket().messages[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: 1 } });
      expect(ready).toHaveBeenCalledTimes(2);
    },
  );

  it('backs off from 0.5 s doubling to 30 s, and resets after a successful stream', () => {
    const { client, sockets, socket, handshake } = setup();
    client.start();
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const before = sockets.length;
      socket().serverClose(1006);
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    handshake();
    socket().serverClose(1006);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(11);
  });

  it('4010 (host draining): waits at least the draining delay', () => {
    const { client, sockets, socket, handshake } = setup();
    client.start();
    handshake();
    socket().serverClose(CloseCode.draining, 'restarting');
    expect(client.state).toBe('waiting');
    vi.advanceTimersByTime(DEFAULT_TIMING.drainingDelayMs - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it('4001: update_required, no reconnect, pending requests fail', async () => {
    const { client, sockets, socket, handshake, states } = setup();
    client.start();
    handshake();
    const queued = client.request('session/list');
    socket().serverClose(CloseCode.unsupportedProtocol, 'accepted: 2');
    await expect(queued).rejects.toMatchObject({ code: LocalError.connectionLost });
    expect(client.state).toBe('update_required');
    expect(states.at(-1)).toEqual(['update_required', 'accepted: 2']);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    await expect(client.request('x')).rejects.toMatchObject({ code: LocalError.closed });
  });

  it('4003: unpaired (return to pairing), no reconnect', () => {
    const { client, sockets, socket } = setup();
    client.start();
    socket().open();
    socket().serverClose(CloseCode.unauthorized, 'revoked');
    expect(client.state).toBe('unpaired');
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('initialize errors: unsupported_protocol → update_required, unauthorized → unpaired', () => {
    const a = setup();
    a.client.start();
    a.socket().open();
    a.host().fail('initialize', { code: 'unsupported_protocol', message: 'v2 only' });
    expect(a.client.state).toBe('update_required');
    expect(a.socket().closes[0]!.code).toBe(1000);
    const b = setup();
    b.client.start();
    b.socket().open();
    b.host().fail('initialize', { code: 'unauthorized', message: 'revoked' });
    expect(b.client.state).toBe('unpaired');
  });

  it('a host that answers with another protocolVersion means update_required', () => {
    const { client, handshake } = setup();
    client.start();
    handshake({ ...INIT_RESULT, protocolVersion: 2 });
    expect(client.state).toBe('update_required');
  });

  it('other initialize failures (internal, timeout) close the stream and retry', () => {
    const { client, sockets, socket, host } = setup();
    client.start();
    socket().open();
    host().fail('initialize', { code: 'internal', message: 'boom' });
    expect(client.state).toBe('waiting');
    vi.advanceTimersByTime(500);
    socket().open();
    vi.advanceTimersByTime(DEFAULT_TIMING.requestTimeoutMs);
    expect(client.state).toBe('waiting');
    expect(sockets).toHaveLength(2);
  });

  it('in-flight requests fail with connection_lost when the stream dies; queued ones wait for the next', async () => {
    const { client, socket, host, handshake } = setup();
    client.start();
    handshake();
    const inflight = client.request('session/open', { sessionId: 's' });
    socket().serverClose(1006);
    await expect(inflight).rejects.toMatchObject({ code: LocalError.connectionLost });
    const later = client.request('session/list');
    vi.advanceTimersByTime(500);
    handshake();
    host().answer('session/list', { sessions: [] });
    await expect(later).resolves.toEqual({ sessions: [] });
  });

  it('a ready listener that closes the stream keeps queued requests for the next stream', async () => {
    const { client, socket, host, handshake } = setup();
    client.start();
    const queued = client.request('session/list');
    const off = client.on('ready', () => socket().serverClose(1006));
    handshake();
    off();
    expect(socket().messages.map((m) => m.method)).toEqual(['initialize', 'initialized']);
    vi.advanceTimersByTime(500);
    handshake();
    host().answer('session/list', { ok: 1 });
    await expect(queued).resolves.toEqual({ ok: 1 });
  });

  it('a socket that cannot be created counts as a failed attempt', () => {
    let calls = 0;
    const { client } = setup({
      createSocket: () => {
        calls += 1;
        throw new Error('bad url');
      },
    });
    client.start();
    expect(client.state).toBe('waiting');
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
  });

  it('retryNow skips the backoff wait', () => {
    const { client, sockets, socket } = setup();
    client.start();
    socket().serverClose(1006);
    client.retryNow();
    expect(sockets).toHaveLength(2);
    client.retryNow(); // connecting: nothing to skip
    expect(sockets).toHaveLength(2);
  });

  it('stop: client_closed {reason: user}, everything pending fails, no reconnect', async () => {
    const { client, sockets, socket, handshake, lifecycle } = setup();
    client.start();
    handshake();
    const inflight = client.request('session/list');
    client.stop();
    client.stop();
    await expect(inflight).rejects.toMatchObject({ code: LocalError.closed });
    expect(socket().ofType('client_closed')[0]).toMatchObject({ reason: 'user' });
    expect(client.state).toBe('stopped');
    expect(lifecycle.unsubscribed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('StreamClient presence (spec 2.2)', () => {
  it('pings at once on a visibility change, with the new state', () => {
    const { client, socket, handshake, lifecycle } = setup();
    client.start();
    handshake();
    lifecycle.setVisibility('background');
    lifecycle.setVisibility('foreground');
    expect(socket().ofType('ping').map((p) => p.state)).toEqual(['foreground', 'background', 'foreground']);
  });

  it('pagehide: client_closed {reason: background}, suspended, suspend event; pageshow reconnects', () => {
    const { client, sockets, socket, handshake, lifecycle } = setup();
    const suspended = vi.fn();
    client.on('suspend', suspended);
    client.start();
    handshake();
    lifecycle.pagehide();
    expect(socket().ofType('client_closed')).toEqual([
      expect.objectContaining({ type: 'client_closed', reason: 'background', seq_id: 4 }),
    ]);
    expect(socket().closes[0]!.code).toBe(1000);
    expect(client.state).toBe('suspended');
    expect(suspended).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    lifecycle.pageshow();
    expect(sockets).toHaveLength(2);
    handshake();
    expect(client.streamId).toBe('stream-2');
  });

  it('coming to the foreground while waiting connects at once', () => {
    const { client, sockets, socket, lifecycle } = setup();
    client.start();
    socket().serverClose(1006);
    lifecycle.setVisibility('background');
    expect(sockets).toHaveLength(1);
    lifecycle.setVisibility('foreground');
    expect(sockets).toHaveLength(2);
  });

  it('pagehide before start does nothing', () => {
    const { client, lifecycle } = setup();
    lifecycle.pagehide();
    expect(client.state).toBe('idle');
  });
});

describe('browserLifecycle', () => {
  class Target {
    listeners = new Map<string, Set<() => void>>();
    addEventListener(type: string, fn: () => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: () => void) {
      this.listeners.get(type)?.delete(fn);
    }
    fire(type: string) {
      for (const fn of this.listeners.get(type) ?? []) fn();
    }
  }

  it('reads document.visibilityState and forwards visibilitychange, pagehide and pageshow', () => {
    const doc = Object.assign(new Target(), { visibilityState: 'visible' });
    const win = new Target();
    const lifecycle = browserLifecycle(doc, win);
    const seen: string[] = [];
    const off = lifecycle.subscribe({
      visibility: (s) => seen.push(`visibility:${s}`),
      pagehide: () => seen.push('pagehide'),
      pageshow: () => seen.push('pageshow'),
    });
    expect(lifecycle.presence()).toBe('foreground');
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    win.fire('pagehide');
    win.fire('pageshow');
    off();
    doc.fire('visibilitychange');
    expect(seen).toEqual(['visibility:background', 'pagehide', 'pageshow']);
  });

  it('outside a browser it is always foreground and subscribes to nothing', () => {
    const lifecycle = browserLifecycle(undefined, undefined);
    expect(lifecycle.presence()).toBe('foreground');
    lifecycle.subscribe({ visibility: () => {}, pagehide: () => {}, pageshow: () => {} })();
    expect(browserLifecycle().presence()).toBe('foreground'); // Node: no document
  });
});

describe('StreamClient defaults', () => {
  it('derives the URL from the page origin and uses WebSocket and crypto.randomUUID', () => {
    const created: string[] = [];
    class FakeWebSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        created.push(url);
      }
    }
    vi.stubGlobal('location', { protocol: 'https:', host: 'mac.tail.ts.net:8443' });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('navigator', { userAgent: 'TestAgent/1' });
    try {
      const client = new StreamClient({ clientId: 'dev_x' });
      client.start();
      expect(created).toEqual(['wss://mac.tail.ts.net:8443/v1/stream']);
      expect(client.streamId).toMatch(/^[0-9a-f-]{36}$/);
      client.stop();
      vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
      new StreamClient({ clientId: 'dev_x' }).start();
      expect(created[1]).toBe('ws://localhost:5173/v1/stream');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends the user agent when there is one', () => {
    vi.stubGlobal('navigator', { userAgent: 'TestAgent/1' });
    try {
      const { client, socket } = setup();
      client.start();
      socket().open();
      expect(socket().messages[0].params.client).toMatchObject({ userAgent: 'TestAgent/1' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('without a page origin and no url, every attempt fails and is retried', () => {
    const client = new StreamClient({ clientId: 'dev_x', lifecycle: new ManualLifecycle() });
    client.start();
    expect(client.state).toBe('waiting');
    client.stop();
  });
});
