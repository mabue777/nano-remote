// End-to-end tests of the stream server with real in-process ws clients on loopback.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CloseCode,
  MAX_MESSAGE_BYTES,
  MAX_UNACKED_BYTES,
  MAX_UNACKED_ENVELOPES,
  MethodRegistry,
  PING_TIMEOUT_MS,
  PresenceRegistry,
  RpcError,
  SEGMENT_BYTES,
  StreamServer,
  tokenFrom,
  type StreamServerOptions,
} from './index.js';
import { CLIENT, TestClient } from './testing/client.js';

const INIT_RESULT = {
  protocolVersion: 1,
  host: { hostId: 'host_test', name: 'test', version: '0.0.0', os: 'darwin', arch: 'arm64' },
  device: { clientId: 'dev_test', displayName: 'Test' },
  agents: [],
  push: { vapidPublicKey: 'k', subscribed: false },
  limits: { maxMessageBytes: MAX_MESSAGE_BYTES, snapshotTurns: 5 },
};

const TOKENS: Record<string, string> = { 'good-token': 'dev_test', 'other-token': 'dev_other' };

function registry(): MethodRegistry {
  return new MethodRegistry()
    .register('initialize', (_params, ctx) => ({ ...INIT_RESULT, device: { clientId: ctx.clientId, displayName: 'Test' } }))
    .register('host/status', () => ({
      host: INIT_RESULT.host,
      agents: [],
      sessionsActive: 0,
      uptimeSeconds: 1,
    }))
    .register('session/close', (params) => {
      if (params.sessionId === 'missing') throw new RpcError('not_found', 'no such session', { sessionId: 'missing' });
      if (params.sessionId === 'boom') throw new Error('handler bug');
      return { ok: true as const };
    })
    .register(
      'session/rename',
      () => ({ ok: true as const }),
      (params) =>
        typeof (params as { title?: unknown }).title === 'string'
          ? { ok: true, value: params }
          : { ok: false, path: 'params.title', message: 'title must be a string' },
    );
}

let servers: StreamServer[] = [];
const clients: TestClient[] = [];

async function start(options: Partial<StreamServerOptions> = {}): Promise<StreamServer> {
  const server = new StreamServer({
    authenticate: (token) => TOKENS[token] ?? null,
    registry: registry(),
    ...options,
  });
  await server.listen();
  servers.push(server);
  return server;
}

async function connect(server: StreamServer, options: Parameters<typeof TestClient.connect>[1] = {}): Promise<TestClient> {
  const client = await TestClient.connect(server.url, options);
  clients.push(client);
  return client;
}

async function ready(server: StreamServer, options: Parameters<typeof TestClient.connect>[1] = {}): Promise<TestClient> {
  const client = await connect(server, options);
  client.ping();
  await client.handshake();
  await vi.waitFor(() => expect(server.stream(client.streamId)?.ready).toBe(true));
  return client;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.socket.terminate();
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

describe('upgrade and authentication', () => {
  it('accepts a bearer token and a cookie, and maps the token to the clientId', async () => {
    const server = await start();
    const bearer = await ready(server);
    expect(server.presence.isConnected('dev_test')).toBe(true);
    const viaCookie = await connect(server, { token: null, cookie: 'theme=dark; nano_device=other-token', clientId: 'dev_other' });
    viaCookie.ping();
    await viaCookie.until(() => viaCookie.frames.find((f) => f.type === 'pong'));
    expect(server.streams('dev_other')).toHaveLength(1);
    expect(server.streams()).toHaveLength(2);
    expect(bearer.isClosed).toBeUndefined();
  });

  it('closes 4003 when the token is missing, unknown, or authentication throws', async () => {
    const log = vi.fn();
    const server = await start({
      log,
      authenticate: async (token) => {
        if (token === 'throws') throw new Error('db down');
        return TOKENS[token] ?? null;
      },
    });
    for (const token of [null, 'unknown', 'throws']) {
      const client = await connect(server, { token });
      expect((await client.closed).code).toBe(CloseCode.unauthorized);
    }
    expect(log).toHaveBeenCalledWith('stream authentication failed', expect.any(Error));
  });

  it('closes 4001 for an unsupported version header and lists the accepted versions', async () => {
    const server = await start();
    const client = await connect(server, { headers: { 'x-nano-protocol-version': '2' } });
    expect(await client.closed).toEqual({ code: CloseCode.unsupportedProtocol, reason: 'unsupported protocol version; accepted: 1' });
    const supported = await connect(server, { headers: { 'x-nano-protocol-version': '1' } });
    supported.ping();
    await supported.until(() => supported.frames.find((f) => f.type === 'pong'));
  });

  it('answers 404 for other paths and for plain HTTP requests', async () => {
    const server = await start();
    const wrongPath = server.url.replace('/v1/stream', '/v1/other');
    await expect(TestClient.connect(wrongPath)).rejects.toThrow(/404/);
    const response = await fetch(server.url.replace('ws://', 'http://'));
    expect(response.status).toBe(404);
  });

  it('uses an injected request listener for plain HTTP', async () => {
    const server = await start({ requestListener: (_req, res) => res.end('hello') });
    const response = await fetch(server.url.replace('ws://', 'http://'));
    expect(await response.text()).toBe('hello');
  });

  it('reads tokens from bearer or cookie headers', () => {
    const request = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage;
    expect(tokenFrom(request({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(tokenFrom(request({ authorization: 'Basic abc', cookie: 'nano_device=x%20y' }))).toBe('x y');
    expect(tokenFrom(request({ cookie: 'nano_device=; other=1' }))).toBeNull();
    expect(tokenFrom(request({ cookie: 'novalue; =x' }))).toBeNull();
    expect(tokenFrom(request({}))).toBeNull();
  });

  it('serves wss:// with a provided certificate and key', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-tls-'));
    try {
      const certPath = path.join(dir, 'cert.pem');
      const keyPath = path.join(dir, 'key.pem');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', keyPath, '-out', certPath,
      ], { stdio: 'ignore' });
      const server = await start({ tls: { certPath, keyPath } });
      expect(server.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/v1\/stream$/);
      const client = await ready(server, { ws: { rejectUnauthorized: false } });
      expect(client.messages[0]).toMatchObject({ result: { protocolVersion: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats IPv6 listen addresses in the URL', async () => {
    const server = await start({ host: '::1' });
    expect(server.url).toMatch(/^ws:\/\/\[::1\]:\d+\/v1\/stream$/);
    await ready(server);
  });

  it('rejects listen errors', async () => {
    const first = await start();
    const port = Number(new URL(first.url).port);
    const second = new StreamServer({ authenticate: () => null, registry: registry(), port });
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('envelope ordering and validation', () => {
  it('acks every message and pongs every ping with its seq_id, without consuming host seq_ids', async () => {
    const server = await start({ status: () => 'degraded' });
    const client = await connect(server);
    const ping = client.ping('background');
    await client.until(() => client.frames.find((f) => f.type === 'pong'));
    expect(client.frames[0]).toEqual({
      type: 'pong',
      client_id: 'dev_test',
      stream_id: client.streamId,
      seq_id: ping,
      status: 'degraded',
    });
    await client.handshake();
    const acks = client.frames.filter((f) => f.type === 'ack').map((f) => f.seq_id);
    expect(acks).toContain(2);
    const serverMessages = client.frames.filter((f) => f.type === 'server_message');
    expect(serverMessages.map((f) => f.seq_id)).toEqual([1]);
    expect(server.presence.streams('dev_test')[0]).toMatchObject({ streamId: client.streamId, state: 'background' });
  });

  it('closes 4002 on a seq_id gap', async () => {
    const server = await start();
    const client = await connect(server);
    client.ping();
    client.seq += 1;
    client.ping();
    expect(await client.closed).toEqual({ code: CloseCode.sequence, reason: 'seq_id 3 after 1' });
  });

  it('closes 4002 on a repeated seq_id', async () => {
    const server = await start();
    const client = await connect(server);
    client.ping();
    client.seq -= 1;
    client.ping();
    expect((await client.closed).code).toBe(CloseCode.sequence);
  });

  it('closes 4002 when the first seq_id is not 1', async () => {
    const server = await start();
    const client = await connect(server);
    client.seq = 4;
    client.ping();
    expect((await client.closed).code).toBe(CloseCode.sequence);
  });

  it.each([
    ['not JSON', '{nope', 'invalid envelope at (root): frame is not JSON'],
    ['a host-to-client type', { type: 'pong', status: 'active' }, 'invalid envelope at type: pong is a host-to-client envelope'],
    ['an invalid ping state', { type: 'ping', state: 'asleep' }, 'invalid envelope at state: state must be foreground or background'],
  ])('closes 4002 on %s', async (_label, frame, reason) => {
    const server = await start();
    const client = await connect(server);
    if (typeof frame === 'string') client.raw(frame);
    else client.send(frame);
    expect(await client.closed).toEqual({ code: CloseCode.sequence, reason });
  });

  it('closes 4002 when the stream_id changes or is already used by another socket', async () => {
    const server = await start();
    const first = await connect(server);
    first.ping();
    first.streamId = '00000000-0000-4000-8000-000000000000';
    first.ping();
    expect(await first.closed).toEqual({ code: CloseCode.sequence, reason: 'stream_id changed on an open stream' });

    const owner = await connect(server);
    owner.ping();
    await owner.until(() => owner.frames.length > 0);
    const thief = await connect(server, { streamId: owner.streamId });
    thief.ping();
    expect(await thief.closed).toEqual({ code: CloseCode.sequence, reason: 'stream_id is already in use by another socket' });
    expect(server.stream(owner.streamId)?.open).toBe(true);
  });

  it('closes 4003 when client_id does not match the authenticated device', async () => {
    const server = await start();
    const client = await connect(server, { clientId: 'dev_somebody_else' });
    client.ping();
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
  });

  it('closes 4002 on an ack for an envelope the host never sent', async () => {
    const server = await start();
    const client = await connect(server);
    client.ping();
    client.ack(7);
    expect(await client.closed).toEqual({ code: CloseCode.sequence, reason: 'ack 7 for an envelope not sent (last 0)' });
  });

  it('drops binary frames', async () => {
    const server = await start();
    const client = await connect(server);
    client.raw(Buffer.from('{"type":"ping"}'));
    client.ping();
    await client.until(() => client.frames.find((f) => f.type === 'pong'));
    expect(client.frames).toHaveLength(1);
  });

  it('closes normally on client_closed', async () => {
    const server = await start();
    const client = await connect(server);
    client.send({ type: 'client_closed', reason: 'background' });
    expect(await client.closed).toEqual({ code: CloseCode.normal, reason: 'client closed: background' });
    const plain = await connect(server);
    plain.send({ type: 'client_closed' });
    expect(await plain.closed).toEqual({ code: CloseCode.normal, reason: 'client closed' });
    await vi.waitFor(() => expect(server.presence.isConnected('dev_test')).toBe(false));
  });

  it('closes 4009 for a frame above 16 MiB', async () => {
    const server = await start();
    const client = await connect(server);
    client.raw('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(await client.closed).toEqual({ code: CloseCode.tooLarge, reason: 'frame exceeds 16 MiB' });
  });
});

describe('initialize and the message router', () => {
  it('answers not_initialized before initialize, then serves requests after it', async () => {
    const server = await start();
    const client = await connect(server);
    expect(await client.call('host/status')).toMatchObject({ error: { code: 'not_initialized' } });
    const init = await client.handshake({ optOutNotifications: ['usage/updated'] });
    expect(init).toMatchObject({ result: { protocolVersion: 1, device: { clientId: 'dev_test' } } });
    expect(await client.call('host/status')).toMatchObject({ result: { sessionsActive: 0 } });
  });

  it('closes 4001 after unsupported_protocol when initialize asks for another version', async () => {
    const server = await start();
    const client = await connect(server);
    const id = client.request('initialize', { protocolVersion: 2, client: CLIENT });
    expect(await client.response(id)).toEqual({
      id,
      error: { code: 'unsupported_protocol', message: 'protocolVersion 2 is not supported', data: { accepted: [1] } },
    });
    expect(await client.closed).toEqual({ code: CloseCode.unsupportedProtocol, reason: 'unsupported protocol version; accepted: 1' });
  });

  it('answers invalid_params with data.path for bad initialize params, and a second initialize', async () => {
    const server = await start();
    const client = await connect(server);
    expect(await client.call('initialize', { protocolVersion: 1, client: { name: 'x' } })).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'params.client.version' } },
    });
    await client.handshake();
    expect(await client.call('initialize', { protocolVersion: 1, client: CLIENT })).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'method' } },
    });
  });

  it('maps handler outcomes to section 10 errors', async () => {
    const log = vi.fn();
    const server = await start({ log });
    const client = await ready(server);
    expect(await client.call('nope/missing')).toMatchObject({ error: { code: 'method_not_found', data: { method: 'nope/missing' } } });
    expect(await client.call('session/close', { sessionId: 'missing' })).toMatchObject({
      error: { code: 'not_found', data: { sessionId: 'missing' } },
    });
    expect(await client.call('session/close', { sessionId: 'boom' })).toEqual(
      expect.objectContaining({ error: { code: 'internal', message: 'internal error' } }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('session/close failed'), expect.any(Error));
    expect(await client.call('session/rename', { sessionId: 's', title: 3 })).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'params.title' } },
    });
    expect(await client.call('session/rename', { sessionId: 's', title: 't' })).toMatchObject({ result: { ok: true } });
  });

  it('answers invalid_params with data.path for a malformed message that has an id, drops one without', async () => {
    const log = vi.fn();
    const server = await start({ log });
    const client = await ready(server);
    client.message({ id: 'bad-1', method: 'Not/Valid' });
    expect(await client.response('bad-1')).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'message.method' } },
    });
    client.message({ method: 'x', params: [] });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('dropped malformed message at message.params')));
    // Client responses and unknown notifications are accepted and ignored.
    client.message({ id: 9, result: {} });
    client.message({ method: 'something/else' });
    expect(await client.call('host/status')).toHaveProperty('result');
  });

  it('answers not_initialized to requests while initialize is still running', async () => {
    let release: () => void = () => {};
    const slow = new MethodRegistry()
      .register('initialize', () => new Promise((resolve) => (release = () => resolve(INIT_RESULT))))
      .register('host/status', () => ({ host: INIT_RESULT.host, agents: [], sessionsActive: 0, uptimeSeconds: 0 }));
    const server = await start({ registry: slow });
    const client = await connect(server);
    const init = client.request('initialize', { protocolVersion: 1, client: CLIENT });
    const again = client.request('initialize', { protocolVersion: 1, client: CLIENT });
    expect(await client.response(again)).toMatchObject({ error: { code: 'invalid_params' } });
    expect(await client.call('host/status')).toMatchObject({ error: { code: 'not_initialized' } });
    release();
    expect(await client.response(init)).toHaveProperty('result');
  });

  it('lets initialize be retried after its handler fails, and drops a result after the stream closed', async () => {
    let attempt = 0;
    let release: () => void = () => {};
    const flaky = new MethodRegistry().register('initialize', () => {
      attempt += 1;
      if (attempt === 1) throw new RpcError('agent_unavailable', 'not yet', { agentId: 'codex' });
      return new Promise((resolve) => (release = () => resolve(INIT_RESULT)));
    });
    const server = await start({ registry: flaky });
    const client = await connect(server);
    expect(await client.call('initialize', { protocolVersion: 1, client: CLIENT })).toMatchObject({
      error: { code: 'agent_unavailable' },
    });
    client.request('initialize', { protocolVersion: 1, client: CLIENT });
    await vi.waitFor(() => expect(attempt).toBe(2));
    const connection = server.stream(client.streamId)!;
    connection.close(CloseCode.normal, 'bye');
    release();
    await client.closed;
    expect(connection.initialized).toBe(false);
  });

  it('runs onClose handlers when the stream closes, and at once when registered after', async () => {
    const closed: string[] = [];
    let late: ((fn: () => void) => void) | undefined;
    const reg = registry().register('session/open', (params, ctx) => {
      ctx.onClose(() => closed.push(`${ctx.streamId}:${params.sessionId}`));
      ctx.onClose(() => {
        throw new Error('cleanup bug');
      });
      late = ctx.onClose;
      return { mode: 'snapshot', session: {}, turns: [], cursor: 0, pending: { approvals: [], inputs: [] } } as never;
    });
    const log = vi.fn();
    const server = await start({ registry: reg, log });
    const client = await ready(server);
    await client.call('session/open', { sessionId: 'ses_1' });
    client.close();
    await client.closed;
    await vi.waitFor(() => expect(closed).toEqual([`${client.streamId}:ses_1`]));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('close handler failed'), expect.any(Error));
    late!(() => closed.push('late'));
    expect(closed).toContain('late');
  });

  it('answers internal when a response is too large to send', async () => {
    const reg = registry().register('agent/list', () => ({ agents: [{ id: 'x'.repeat(MAX_MESSAGE_BYTES) }] }) as never);
    const server = await start({ registry: reg });
    const client = await ready(server);
    expect(await client.call('agent/list')).toMatchObject({ error: { code: 'internal' } });
  });
});

describe('notifications', () => {
  it('sends by streamId and by clientId, honoring initialize state, initialized and opt-outs', async () => {
    const server = await start();
    const a = await ready(server);
    const b = await connect(server);
    b.ping();
    await b.call('initialize', { protocolVersion: 1, client: CLIENT, optOutNotifications: ['usage/updated'] });
    const fresh = await connect(server);
    fresh.ping();
    await fresh.until(() => fresh.frames.length > 0);

    expect(server.notifyStream(fresh.streamId, 'session/updated', {})).toBe(false);
    expect(server.notifyStream('unknown', 'session/updated', {})).toBe(false);
    expect(server.notifyStream(b.streamId, 'usage/updated', { sessionId: 's', seq: 1 }, { journal: true })).toBe(false);
    expect(server.notifyStream(b.streamId, 'host/status/changed')).toBe(true);
    await b.until(() => b.messages.find((m) => m.method === 'host/status/changed'));
    expect(b.messages.at(-1)).toEqual({ method: 'host/status/changed' });

    // b has not sent `initialized`, so a client-wide broadcast reaches only a.
    expect(server.notifyClient('dev_test', 'session/updated', { summary: {} })).toBe(1);
    await a.until(() => a.messages.find((m) => m.method === 'session/updated'));
    b.message({ method: 'initialized' });
    await vi.waitFor(() => expect(server.stream(b.streamId)?.ready).toBe(true));
    expect(server.notifyClient('dev_test', 'session/updated', { summary: {} })).toBe(2);
    expect(server.notifyClient('dev_nobody', 'session/updated', {})).toBe(0);
  });

  it('keeps a second stream of the same client independent', async () => {
    const server = await start();
    const first = await ready(server);
    const second = await ready(server);
    expect(first.streamId).not.toBe(second.streamId);
    expect(server.presence.streams('dev_test')).toHaveLength(2);
    expect(server.notifyStream(second.streamId, 'session/updated', { summary: {} })).toBe(true);
    await second.until(() => second.messages.find((m) => m.method === 'session/updated'));
    // Each stream numbers its own envelopes from 1.
    expect(second.frames.filter((f) => f.type === 'server_message').map((f) => f.seq_id)).toEqual([1, 2]);
    expect(first.messages.some((m) => m.method === 'session/updated')).toBe(false);

    first.close();
    await first.closed;
    await vi.waitFor(() => expect(server.presence.streams('dev_test')).toHaveLength(1));
    expect(server.presence.isConnected('dev_test')).toBe(true);
    second.close();
    await second.closed;
    await vi.waitFor(() => expect(server.presence.isConnected('dev_test')).toBe(false));
  });

  it('does not notify a closed stream', async () => {
    const server = await start();
    const client = await ready(server);
    const connection = server.stream(client.streamId)!;
    connection.close(CloseCode.normal, 'bye');
    expect(connection.notify('session/updated', {})).toBe(false);
  });
});

describe('acks and backpressure', () => {
  it('accepts batched acks: one ack releases everything up to its seq_id', async () => {
    const server = await start();
    const client = await ready(server);
    client.autoAck = false;
    const connection = server.stream(client.streamId)!;
    await vi.waitFor(() => expect(connection.backlog.unackedEnvelopes).toBe(0));
    for (let i = 0; i < 5; i += 1) server.notifyStream(client.streamId, 'item/delta', { seq: i }, { journal: true });
    expect(connection.backlog.unackedEnvelopes).toBe(5);
    await client.until(() => client.messages.length >= 6);
    client.ack(4);
    await vi.waitFor(() => expect(connection.backlog.unackedEnvelopes).toBe(2));
    client.ack(2); // stale ack: changes nothing
    client.ack(6);
    await vi.waitFor(() => expect(connection.backlog).toEqual({ unackedEnvelopes: 0, unackedBytes: 0, waiting: 0 }));
  });

  it('holds Journal events at 256 unacked envelopes and resumes in order once acked', async () => {
    const server = await start();
    const client = await ready(server);
    client.autoAck = false;
    const connection = server.stream(client.streamId)!;
    await vi.waitFor(() => expect(connection.backlog.unackedEnvelopes).toBe(0));
    const total = MAX_UNACKED_ENVELOPES + 50;
    for (let seq = 1; seq <= total; seq += 1) {
      expect(server.notifyStream(client.streamId, 'item/delta', { sessionId: 's', seq }, { journal: true })).toBe(true);
    }
    expect(connection.backlog).toMatchObject({ unackedEnvelopes: MAX_UNACKED_ENVELOPES, waiting: 50 });
    // A response is not held back by the window itself, but it never overtakes waiting events.
    const id = client.request('host/status');
    await client.until(() => client.messages.length >= MAX_UNACKED_ENVELOPES + 1);
    await vi.waitFor(() => expect(connection.backlog.waiting).toBe(51));
    expect(client.messages.length).toBe(MAX_UNACKED_ENVELOPES + 1);

    client.ack(client.frames.filter((f) => f.type === 'server_message').at(-1)!.seq_id);
    await client.response(id);
    const events = client.messages.filter((m) => m.method === 'item/delta').map((m) => (m.params as { seq: number }).seq);
    expect(events).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    const last = client.messages.at(-1)!;
    expect(last.id).toBe(id);
    const seqIds = client.frames.filter((f) => f.type === 'server_message').map((f) => f.seq_id);
    expect(seqIds).toEqual(Array.from({ length: seqIds.length }, (_, i) => i + 1));
  });

  it('holds Journal events at 4 MiB unacked and sends non-Journal messages while nothing waits', async () => {
    const server = await start();
    const client = await ready(server);
    client.autoAck = false;
    const connection = server.stream(client.streamId)!;
    await vi.waitFor(() => expect(connection.backlog.unackedEnvelopes).toBe(0));
    const delta = 'd'.repeat(90 * 1024);
    let sent = 0;
    while (connection.backlog.waiting === 0) {
      sent += 1;
      server.notifyStream(client.streamId, 'item/delta', { seq: sent, delta }, { journal: true });
    }
    expect(connection.backlog.unackedBytes).toBeGreaterThanOrEqual(MAX_UNACKED_BYTES);
    expect(connection.backlog.unackedEnvelopes).toBeLessThan(MAX_UNACKED_ENVELOPES);
    // Window full but only Journal events wait: still, a later status notification must queue behind them.
    server.notifyStream(client.streamId, 'host/status/changed', {});
    expect(connection.backlog.waiting).toBe(2);

    await client.until(() => client.messages.length >= sent);
    client.ack(client.frames.at(-1)!.seq_id);
    await client.until(() => client.messages.find((m) => m.method === 'host/status/changed'));
    expect(client.messages.filter((m) => m.method === 'item/delta')).toHaveLength(sent);
    expect(client.messages.at(-1)!.method).toBe('host/status/changed');
  });

  it('sends non-Journal messages past a full window when nothing is waiting', async () => {
    const server = await start();
    const client = await ready(server);
    client.autoAck = false;
    const connection = server.stream(client.streamId)!;
    await vi.waitFor(() => expect(connection.backlog.unackedEnvelopes).toBe(0));
    for (let seq = 1; seq <= MAX_UNACKED_ENVELOPES; seq += 1) {
      server.notifyStream(client.streamId, 'item/delta', { seq }, { journal: true });
    }
    expect(server.notifyStream(client.streamId, 'session/updated', {})).toBe(true);
    expect(connection.backlog).toMatchObject({ unackedEnvelopes: MAX_UNACKED_ENVELOPES + 1, waiting: 0 });
  });
});

describe('chunking', () => {
  it('sends a large message as consecutive chunks of at most 100 KiB and the client reassembles it', async () => {
    const server = await start();
    const client = await ready(server);
    const big = 'é'.repeat(130 * 1024); // 260 KiB of UTF-8
    server.notifyStream(client.streamId, 'item/delta', { delta: big }, { journal: true });
    server.notifyStream(client.streamId, 'session/updated', {});
    await client.until(() => client.messages.find((m) => m.method === 'session/updated'));
    const chunks = client.frames.filter((f) => f.type === 'server_message_chunk');
    expect(chunks.map((f) => f.segment_id)).toEqual([0, 1, 2]);
    expect(chunks.every((f) => f.segment_count === 3 && Buffer.from(f.message_chunk_base64 as string, 'base64').length <= SEGMENT_BYTES)).toBe(true);
    const seqs = client.frames.filter((f) => f.type.startsWith('server_message')).map((f) => f.seq_id);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(client.messages.find((m) => m.method === 'item/delta')).toEqual({ method: 'item/delta', params: { delta: big } });
  });

  it('reassembles client chunks and acks each one', async () => {
    const server = await start();
    const client = await ready(server);
    const title = 't'.repeat(250 * 1024);
    client.sendChunked({ id: 'big', method: 'session/rename', params: { sessionId: 's', title } });
    expect(await client.response('big')).toMatchObject({ result: { ok: true } });
    const acked = client.frames.filter((f) => f.type === 'ack').map((f) => f.seq_id);
    expect(acked).toEqual(expect.arrayContaining([client.seq - 2, client.seq - 1, client.seq]));
  });

  it('closes 4009 when a chunked message declares more than 16 MiB', async () => {
    const server = await start();
    const client = await connect(server);
    client.send({
      type: 'client_message_chunk',
      segment_id: 0,
      segment_count: 200,
      message_size_bytes: MAX_MESSAGE_BYTES + 1,
      message_chunk_base64: 'AAAA',
    });
    expect((await client.closed).code).toBe(CloseCode.tooLarge);
  });

  it('closes 4002 when another envelope interrupts a chunked message', async () => {
    const server = await start();
    const client = await connect(server);
    client.send({
      type: 'client_message_chunk',
      segment_id: 0,
      segment_count: 2,
      message_size_bytes: 6,
      message_chunk_base64: 'AAAA',
    });
    client.ping();
    expect(await client.closed).toEqual({ code: CloseCode.sequence, reason: 'ping inside a chunked message' });
  });

  it('closes 4002 when the reassembled message is not JSON', async () => {
    const server = await start();
    const client = await connect(server);
    const text = Buffer.from('not json');
    client.send({
      type: 'client_message_chunk',
      segment_id: 0,
      segment_count: 1,
      message_size_bytes: text.length,
      message_chunk_base64: text.toString('base64'),
    });
    expect(await client.closed).toEqual({ code: CloseCode.sequence, reason: 'reassembled message is not JSON' });
  });

  it('refuses to send a notification above 16 MiB', async () => {
    const server = await start();
    const client = await ready(server);
    expect(() => server.notifyStream(client.streamId, 'item/delta', { delta: 'x'.repeat(MAX_MESSAGE_BYTES) })).toThrow(
      /exceeds/,
    );
  });
});

describe('presence, ping timeout and draining', () => {
  it('closes 4008 after 90 s without a ping, and each ping restarts the clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const presence = new PresenceRegistry();
    const changes: [string, boolean][] = [];
    presence.onChange((clientId, connected) => changes.push([clientId, connected]));
    const server = await start({ presence });
    const client = await connect(server);
    expect(server.presence).toBe(presence);
    await vi.waitFor(() => expect(presence.isConnected('dev_test')).toBe(true));

    vi.advanceTimersByTime(PING_TIMEOUT_MS - 1000);
    client.ping();
    await client.until(() => client.frames.find((f) => f.type === 'pong'));
    vi.advanceTimersByTime(PING_TIMEOUT_MS - 1000);
    expect(client.isClosed).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(await client.closed).toEqual({ code: CloseCode.pingTimeout, reason: 'no ping for 90 s' });
    await vi.waitFor(() => expect(presence.isConnected('dev_test')).toBe(false));
    expect(changes).toEqual([
      ['dev_test', true],
      ['dev_test', false],
    ]);
  });

  it('closes every stream of a revoked device with 4003', async () => {
    const server = await start();
    const a = await ready(server);
    const b = await ready(server);
    const other = await ready(server, { token: 'other-token', clientId: 'dev_other' });
    expect(server.revokeClient('dev_test')).toBe(2);
    expect(await a.closed).toEqual({ code: CloseCode.unauthorized, reason: 'device revoked' });
    expect((await b.closed).code).toBe(CloseCode.unauthorized);
    expect(other.isClosed).toBeUndefined();
  });

  it('reports draining in pongs, refuses new streams with 4010, then closes open ones with 4010', async () => {
    let release: (id: string | null) => void = () => {};
    const server = await start({
      authenticate: (token) =>
        token === 'slow' ? new Promise((resolve) => (release = resolve)) : (TOKENS[token] ?? null),
    });
    const client = await connect(server);
    const slow = TestClient.connect(server.url, { token: 'slow' });
    server.beginDrain();
    client.ping();
    await client.until(() => client.frames.find((f) => f.type === 'pong'));
    expect(client.frames[0]).toMatchObject({ status: 'draining' });

    const late = await connect(server);
    expect(await late.closed).toEqual({ code: CloseCode.draining, reason: 'host is draining; reconnect later' });
    release('dev_test');
    const slowClient = await slow;
    clients.push(slowClient);
    expect((await slowClient.closed).code).toBe(CloseCode.draining);

    const closing = server.close();
    expect(await client.closed).toEqual({ code: CloseCode.draining, reason: 'host is shutting down' });
    await closing;
    servers = servers.filter((s) => s !== server);
  });

  it('truncates close reasons to the WebSocket limit', async () => {
    const server = await start();
    const client = await connect(server);
    server.streams()[0]!.close(4002, 'é'.repeat(100));
    const { reason } = await client.closed;
    expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
    expect(reason.endsWith('...')).toBe(true);
  });
});
