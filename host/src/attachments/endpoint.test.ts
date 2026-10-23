// Attachments end to end (spec 8.1) through the running host on loopback: upload auth and limits, who
// may read a blob, how turn input reaches the agent, and cleanup when the session is deleted.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, type HostConfig } from '../cli/config.js';
import { createLogger } from '../cli/log.js';
import { attachmentsDir, HostService } from '../cli/service.js';
import { FakeAgent } from '../core/testing/fake-adapter.js';
import { rpc, rpcError } from '../core/testing/harness.js';
import { TestClient } from '../stream/testing/client.js';
import { BLOB_ID, MAX_ATTACHMENT_BYTES } from './store.js';

let home: string;
let service: HostService | undefined;
const clients: TestClient[] = [];
/** Each client's `initialize` response. */
const initialized = new WeakMap<TestClient, Record<string, unknown>>();

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nano-blob-'));
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await service?.shutdown('test');
  service = undefined;
  rmSync(home, { recursive: true, force: true });
});

interface Device {
  clientId: string;
  token: string;
}

interface Host {
  service: HostService;
  agent: FakeAgent;
  base: string;
  config: HostConfig;
  device(name?: string): Device;
  connect(device: Device): Promise<TestClient>;
}

async function startHost(agent = new FakeAgent()): Promise<Host> {
  const config: HostConfig = {
    ...defaultConfig(home, 'host_test'),
    listenAddresses: ['127.0.0.1'],
    port: 0,
    journalPath: path.join(home, 'journal.sqlite'),
    logFile: path.join(home, 'logs', 'host.log'),
  };
  service = await HostService.start({
    config,
    configPath: path.join(home, 'config.json'),
    logger: createLogger({ file: config.logFile, stdout: { write: () => {} } }),
    insecureDev: true,
    agents: [agent],
    publicDir: home,
    drainMs: 0,
    keepAwake: { supported: false },
  });
  const started = service;
  const base = `http://127.0.0.1:${started.server.port}`;
  return {
    service: started,
    agent,
    base,
    config,
    device(name = 'iPhone') {
      const { device, token } = started.devices.create({ displayName: name, platform: 'ios-web', userAgent: 'test' });
      return { clientId: device.clientId, token };
    },
    async connect(device) {
      const client = await TestClient.connect(`ws://127.0.0.1:${started.server.port}/v1/stream`, { token: device.token, clientId: device.clientId });
      clients.push(client);
      initialized.set(client, await client.handshake());
      return client;
    },
  };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function upload(
  host: Host,
  sessionId: string | undefined,
  options: { token?: string; cookie?: string; name?: string; type?: string; body?: Buffer | string; origin?: string; method?: string } = {},
): Promise<Response> {
  const query = new URLSearchParams();
  if (sessionId !== undefined) query.set('sessionId', sessionId);
  if (options.name !== undefined) query.set('name', options.name);
  const headers: Record<string, string> = { 'content-type': options.type ?? 'image/png' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  return fetch(`${host.base}/v1/blob?${query}`, { method: options.method ?? 'POST', headers, body: options.body ?? PNG });
}

function download(host: Host, url: string, token?: string, method = 'GET'): Promise<Response> {
  return fetch(`${host.base}${url}`, { method, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
}

async function newSession(host: Host, client: TestClient): Promise<string> {
  const cwd = mkdtempSync(path.join(home, 'work-'));
  const { session } = await rpc<{ session: { sessionId: string } }>(client, 'session/start', { agentId: host.agent.id, cwd });
  return session.sessionId;
}

/** Raw HTTP, for a body whose length the client declares or streams itself. */
function rawPost(host: Host, pathAndQuery: string, headers: Record<string, string>, write: (req: http.ClientRequest) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${host.base}${pathAndQuery}`, { method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    write(req);
  });
}

describe('POST /v1/blob', () => {
  it('stores an upload for a paired device and answers its id, url, name, type and size', async () => {
    const host = await startHost();
    const phone = host.device();
    const sessionId = await newSession(host, await host.connect(phone));
    const response = await upload(host, sessionId, { token: phone.token, name: 'IMG 0001.png' });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = (await response.json()) as Record<string, unknown>;
    expect(result).toEqual({ blobId: expect.stringMatching(BLOB_ID), url: `/v1/blob/${String(result.blobId)}`, name: 'IMG 0001.png', mediaType: 'image/png', size: PNG.length });
    const file = path.join(attachmentsDir(host.config), sessionId, String(result.blobId), 'IMG 0001.png');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('the cookie authenticates too, from the host origin', async () => {
    const host = await startHost();
    const phone = host.device();
    const sessionId = await newSession(host, await host.connect(phone));
    const response = await upload(host, sessionId, { cookie: `nano_device=${phone.token}`, origin: host.base });
    expect(response.status).toBe(201);
  });

  it('no token, an unknown token, or a revoked device: 401 unauthorized, nothing stored', async () => {
    const host = await startHost();
    const phone = host.device();
    const sessionId = await newSession(host, await host.connect(phone));
    for (const token of [undefined, 'not-a-token']) {
      const response = await upload(host, sessionId, token === undefined ? {} : { token });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: 'unauthorized', message: 'device token missing, unknown or revoked' } });
    }
    expect(host.service.server.revokeDevice(phone.clientId)).toBe(true);
    expect((await upload(host, sessionId, { token: phone.token })).status).toBe(401);
    expect(existsSync(path.join(attachmentsDir(host.config), sessionId))).toBe(false);
  });

  it('a page of another origin is refused (403), even with the cookie', async () => {
    const host = await startHost();
    const phone = host.device();
    const sessionId = await newSession(host, await host.connect(phone));
    const response = await upload(host, sessionId, { cookie: `nano_device=${phone.token}`, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    // A bearer token from a page does not count either (only native clients send no Origin).
    expect((await upload(host, sessionId, { token: phone.token, origin: host.base })).status).toBe(401);
  });

  it('needs a known session: 400 without one, 404 for an unknown or deleted one', async () => {
    const host = await startHost();
    const phone = host.device();
    const client = await host.connect(phone);
    const missing = await upload(host, undefined, { token: phone.token });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'invalid_params', data: { path: 'sessionId' } } });
    expect((await upload(host, 'ses_0nothere', { token: phone.token })).status).toBe(404);
    expect((await upload(host, '../../x', { token: phone.token })).status).toBe(404);
    const sessionId = await newSession(host, client);
    await rpc(client, 'session/delete', { sessionId });
    const deleted = await upload(host, sessionId, { token: phone.token });
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('size limit: a declared length over 20 MiB is refused before reading, a streamed one once it passes the limit', async () => {
    const host = await startHost();
    const phone = host.device();
    const sessionId = await newSession(host, await host.connect(phone));
    const headers = { authorization: `Bearer ${phone.token}`, 'content-type': 'application/octet-stream' };
    const declared = await rawPost(host, `/v1/blob?sessionId=${sessionId}`, { ...headers, 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }, (req) => {
      // Only one byte of the declared 20 MiB is ever sent: the answer must come without the rest.
      req.write('x');
    });
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body)).toEqual({
      error: { code: 'invalid_params', message: `an attachment may have at most ${MAX_ATTACHMENT_BYTES} bytes`, data: { path: '', maxBytes: MAX_ATTACHMENT_BYTES } },
    });
    const chunk = Buffer.alloc(1024 * 1024);
    const streamed = await rawPost(host, `/v1/blob?sessionId=${sessionId}`, { ...headers, 'transfer-encoding': 'chunked' }, (req) => {
      for (let i = 0; i < 21; i += 1) req.write(chunk);
      req.end();
    });
    expect(streamed.status).toBe(413);
    expect(readdirSync(path.join(attachmentsDir(host.config), sessionId))).toEqual([]);
    // Exactly the limit is accepted.
    const atLimit = await upload(host, sessionId, { token: phone.token, type: 'application/octet-stream', body: Buffer.alloc(MAX_ATTACHMENT_BYTES) });
    expect(atLimit.status).toBe(201);
  });

  it('other methods answer 405 with Allow', async () => {
    const host = await startHost();
    const phone = host.device();
    const put = await upload(host, 'ses_0x', { token: phone.token, method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('POST');
    const post = await fetch(`${host.base}/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('GET /v1/blob/<id>', () => {
  it('serves the bytes to any paired device, never to an unpaired or revoked one', async () => {
    const host = await startHost();
    const phone = host.device('iPhone');
    const tablet = host.device('iPad');
    const sessionId = await newSession(host, await host.connect(phone));
    const { url } = (await (await upload(host, sessionId, { token: phone.token, name: 'shot.png' })).json()) as { url: string };

    const mine = await download(host, url, phone.token);
    expect(mine.status).toBe(200);
    expect(Buffer.from(await mine.arrayBuffer())).toEqual(PNG);
    expect(mine.headers.get('content-type')).toBe('image/png');
    expect(mine.headers.get('content-length')).toBe(String(PNG.length));
    expect(mine.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mine.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(mine.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.png");
    expect(mine.headers.get('cache-control')).toBe('private, max-age=86400');
    expect((await download(host, url, tablet.token)).status).toBe(200);
    const cookie = await fetch(`${host.base}${url}`, { headers: { cookie: `nano_device=${phone.token}` } });
    expect(cookie.status).toBe(200);

    const anonymous = await download(host, url);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain('PNG');
    expect((await download(host, url, 'forged')).status).toBe(401);
    host.service.server.revokeDevice(tablet.clientId);
    expect((await download(host, url, tablet.token)).status).toBe(401);
    const foreign = await fetch(`${host.base}${url}`, { headers: { cookie: `nano_device=${phone.token}`, origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
  });

  it('HEAD answers the headers only; unknown or malformed ids are 404', async () => {
    const host = await startHost();
    const phone = host.device();
    const sessionId = await newSession(host, await host.connect(phone));
    const { url } = (await (await upload(host, sessionId, { token: phone.token })).json()) as { url: string };
    const head = await download(host, url, phone.token, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(PNG.length));
    expect(await head.text()).toBe('');
    expect((await download(host, '/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA', phone.token)).status).toBe(404);
    expect((await download(host, '/v1/blob/..%2Fjournal.sqlite', phone.token)).status).toBe(404);
  });

  it('anything but a raster image downloads as an attachment, never inline (no stored page on the host origin)', async () => {
    const host = await startHost();
    const phone = host.device();
    const sessionId = await newSession(host, await host.connect(phone));
    for (const [name, type] of [
      ['x.html', 'text/html'],
      ['x.svg', 'image/svg+xml'],
      ['notes.txt', 'text/plain; charset=utf-8'],
    ] as const) {
      const { url, mediaType } = (await (await upload(host, sessionId, { token: phone.token, name, type, body: '<script>alert(1)</script>' })).json()) as {
        url: string;
        mediaType: string;
      };
      const response = await download(host, url, phone.token);
      expect(response.headers.get('content-type')).toBe(mediaType);
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${name}`);
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    }
  });
});

describe('attachments in turns', () => {
  it('turn/start hands the agent the stored path; the journal keeps the URLs; initialize states the limit', async () => {
    const host = await startHost();
    const phone = host.device();
    const client = await host.connect(phone);
    expect(initialized.get(client)).toMatchObject({ result: { limits: { maxAttachmentBytes: MAX_ATTACHMENT_BYTES } } });
    const sessionId = await newSession(host, client);
    const image = (await (await upload(host, sessionId, { token: phone.token, name: 'shot.png' })).json()) as { url: string; name: string };
    const file = (await (await upload(host, sessionId, { token: phone.token, name: 'log.txt', type: 'text/plain', body: 'E\n' })).json()) as {
      url: string;
      name: string;
      mediaType: string;
    };
    const input = [
      { type: 'text', text: 'look' },
      { type: 'image', url: image.url },
      { type: 'file', url: file.url, name: file.name, mediaType: file.mediaType },
    ];
    const { turn } = await rpc<{ turn: { items: string[] } }>(client, 'turn/start', { sessionId, input, clientMessageId: 'c1' });
    const call = host.agent.last.calls.find((c) => c.method === 'turnStart')!;
    const dir = path.join(attachmentsDir(host.config), sessionId);
    expect(call.args[0]).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', url: image.url, path: path.join(dir, image.url.split('/').pop()!, 'shot.png'), mediaType: 'image/png' },
      { type: 'file', url: file.url, name: 'log.txt', mediaType: 'text/plain', path: path.join(dir, file.url.split('/').pop()!, 'log.txt') },
    ]);
    const opened = await rpc<{ turns: { items: { type: string; content?: unknown }[] }[] }>(client, 'session/open', { sessionId });
    const userMessage = opened.turns.flatMap((t) => t.items).find((i) => i.type === 'userMessage');
    expect(userMessage?.content).toEqual(input);
    expect(turn.items).toBeDefined();
  });

  it('a URL of another session, an unknown blob, a non-image as image, or a file outside /v1/blob is invalid_params', async () => {
    const host = await startHost();
    const phone = host.device();
    const client = await host.connect(phone);
    const a = await newSession(host, client);
    const b = await newSession(host, client);
    const fromA = (await (await upload(host, a, { token: phone.token })).json()) as { url: string };
    const text = (await (await upload(host, b, { token: phone.token, type: 'text/plain', body: 'x' })).json()) as { url: string };
    const cases: [unknown[], string][] = [
      [[{ type: 'image', url: fromA.url }], 'params.input.0.url'],
      [[{ type: 'text', text: 'x' }, { type: 'image', url: '/v1/blob/blb_AAAAAAAAAAAAAAAAAAAAAA' }], 'params.input.1.url'],
      [[{ type: 'image', url: text.url }], 'params.input.0.url'],
      [[{ type: 'file', url: 'https://example.com/a.pdf', name: 'a.pdf', mediaType: 'application/pdf' }], 'params.input.0.url'],
      [[{ type: 'file', url: '/etc/passwd', name: 'p', mediaType: 'text/plain' }], 'params.input.0.url'],
    ];
    for (const [input, at] of cases) {
      const error = await rpcError(client, 'turn/start', { sessionId: b, input, clientMessageId: `c-${at}-${input.length}` });
      expect(error).toMatchObject({ code: 'invalid_params', data: { path: at } });
    }
    const badShape = await rpcError(client, 'turn/start', { sessionId: b, input: [{ type: 'file', url: text.url }], clientMessageId: 'c-x' });
    expect(badShape).toMatchObject({ code: 'invalid_params', data: { path: 'params.input.0' } });
    // session/start cannot refer to attachments: its session has none yet. No session is created.
    const before = (await rpc<{ sessions: unknown[] }>(client, 'session/list')).sessions.length;
    const start = await rpcError(client, 'session/start', { agentId: host.agent.id, cwd: home, input: [{ type: 'image', url: fromA.url }] });
    expect(start).toMatchObject({ code: 'invalid_params', data: { path: 'params.input.0.url' } });
    expect((await rpc<{ sessions: unknown[] }>(client, 'session/list')).sessions).toHaveLength(before);
    // Data URLs still pass as they are.
    await rpc(client, 'turn/start', { sessionId: b, input: [{ type: 'image', url: 'data:image/png;base64,AAAA' }], clientMessageId: 'c-data' });
    expect(host.agent.last.calls.find((c) => c.method === 'turnStart')!.args[0]).toEqual([{ type: 'image', url: 'data:image/png;base64,AAAA' }]);
  });

  it('session/delete deletes the attachments: the folder is gone and the URL answers 404', async () => {
    const host = await startHost();
    const phone = host.device();
    const client = await host.connect(phone);
    const sessionId = await newSession(host, client);
    const keep = await newSession(host, client);
    const { url } = (await (await upload(host, sessionId, { token: phone.token })).json()) as { url: string };
    const kept = (await (await upload(host, keep, { token: phone.token })).json()) as { url: string };
    const dir = path.join(attachmentsDir(host.config), sessionId);
    expect(existsSync(dir)).toBe(true);
    await rpc(client, 'session/archive', { sessionId });
    expect((await download(host, url, phone.token)).status).toBe(200); // archiving keeps them
    await rpc(client, 'session/delete', { sessionId });
    expect(existsSync(dir)).toBe(false);
    expect((await download(host, url, phone.token)).status).toBe(404);
    expect((await download(host, kept.url, phone.token)).status).toBe(200);
  });
});
