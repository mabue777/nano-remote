// Session files end to end (spec 4.1) through the running host on loopback: `initialize` states the
// capability and limit, `fs/readFile` and scoped `fs/readDirectory` over the stream, and `GET /v1/file`
// with the attachment endpoint's auth and headers plus ETag, 304 and byte ranges. Every way out of the
// session folder, and a deleted session, is refused.
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, type HostConfig } from '../cli/config.js';
import { createLogger } from '../cli/log.js';
import { HostService } from '../cli/service.js';
import { FakeAgent } from '../core/testing/fake-adapter.js';
import { rpc, rpcError } from '../core/testing/harness.js';
import { TestClient } from '../stream/testing/client.js';
import { MAX_SERVED_FILE_BYTES, parseRange } from './endpoint.js';
import { MAX_FILE_READ_BYTES } from './read.js';

let home: string;
let service: HostService | undefined;
const clients: TestClient[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nano-file-'));
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await service?.shutdown('test');
  service = undefined;
  rmSync(home, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

interface Setup {
  base: string;
  token: string;
  clientId: string;
  client: TestClient;
  initialized: Record<string, unknown>;
  sessionId: string;
  cwd: string;
  get(query: Record<string, string>, headers?: Record<string, string>, method?: string): Promise<Response>;
}

/** A host with one paired device, its stream, and a session on a folder with a few files and a secret beside it. */
async function setup(): Promise<Setup> {
  const config: HostConfig = {
    ...defaultConfig(home, 'host_test'),
    listenAddresses: ['127.0.0.1'],
    port: 0,
    journalPath: path.join(home, 'journal.sqlite'),
    logFile: path.join(home, 'logs', 'host.log'),
  };
  const agent = new FakeAgent();
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
  const { device, token } = started.devices.create({ displayName: 'iPhone', platform: 'ios-web', userAgent: 'test' });
  const client = await TestClient.connect(`ws://127.0.0.1:${started.server.port}/v1/stream`, { token, clientId: device.clientId });
  clients.push(client);
  const initialized = await client.handshake();

  const cwd = path.join(home, 'repo');
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  writeFileSync(path.join(cwd, 'src', 'parser.ts'), 'export function parse() {\n  return 42;\n}\n');
  writeFileSync(path.join(cwd, 'shot.png'), PNG);
  writeFileSync(path.join(cwd, 'page.html'), '<script>alert(1)</script>');
  writeFileSync(path.join(cwd, '.env'), 'TOKEN=x\n');
  mkdirSync(path.join(home, 'secret'));
  writeFileSync(path.join(home, 'secret', 'key.txt'), 'TOP SECRET\n');
  symlinkSync(path.join(home, 'secret', 'key.txt'), path.join(cwd, 'escape'));
  const { session } = await rpc<{ session: { sessionId: string } }>(client, 'session/start', { agentId: agent.id, cwd });
  return {
    base,
    token,
    clientId: device.clientId,
    client,
    initialized,
    sessionId: session.sessionId,
    cwd,
    get(query, headers = {}, method = 'GET') {
      return fetch(`${base}/v1/file?${new URLSearchParams(query)}`, { method, headers: { authorization: `Bearer ${token}`, ...headers } });
    },
  };
}

async function errorOf(response: Response): Promise<{ code: string; data?: Record<string, unknown> }> {
  return ((await response.json()) as { error: { code: string; data?: Record<string, unknown> } }).error;
}

describe('initialize', () => {
  it('states the read capability and the per-read limit', async () => {
    const s = await setup();
    expect(s.initialized).toMatchObject({ result: { files: { read: true }, limits: { maxFileReadBytes: MAX_FILE_READ_BYTES } } });
    expect((s.initialized.result as { files: Record<string, unknown> }).files).not.toHaveProperty('write');
  });
});

describe('fs/readFile and fs/readDirectory over the stream', () => {
  it('reads a file and lists a folder of the session', async () => {
    const s = await setup();
    expect(await rpc(s.client, 'fs/readFile', { sessionId: s.sessionId, path: 'src/parser.ts' })).toEqual({
      path: 'src/parser.ts',
      size: 41,
      mtimeMs: expect.any(Number),
      mediaType: 'text/x-typescript',
      binary: false,
      encoding: 'utf8',
      content: 'export function parse() {\n  return 42;\n}\n',
      offset: 0,
      length: 41,
      truncated: false,
    });
    const { entries } = await rpc<{ entries: { name: string; path: string; hidden?: boolean }[] }>(s.client, 'fs/readDirectory', {
      sessionId: s.sessionId,
      path: '',
    });
    expect(entries.map((e) => [e.path, e.hidden])).toEqual([
      ['src', false],
      ['.env', true],
      ['page.html', false],
      ['shot.png', false],
    ]);
    // Without a sessionId the folder picker's listing is unchanged: absolute paths, no new fields.
    const picker = await rpc<{ entries: Record<string, unknown>[] }>(s.client, 'fs/readDirectory', { path: s.cwd });
    expect(picker.entries[0]).toEqual({ name: 'src', kind: 'dir', path: path.join(s.cwd, 'src') });
  });

  it('refuses .., absolute paths, symlinks out, unknown and deleted sessions with not_found', async () => {
    const s = await setup();
    const secret = path.join(home, 'secret', 'key.txt');
    for (const requested of ['../secret/key.txt', secret, 'escape', 'src/../../secret/key.txt']) {
      expect(await rpcError(s.client, 'fs/readFile', { sessionId: s.sessionId, path: requested })).toMatchObject({ code: 'not_found', data: { path: requested } });
    }
    expect(await rpcError(s.client, 'fs/readDirectory', { sessionId: s.sessionId, path: '..' })).toMatchObject({ code: 'not_found' });
    expect(await rpcError(s.client, 'fs/readFile', { sessionId: 'ses_0nothere', path: 'src/parser.ts' })).toMatchObject({ code: 'not_found' });
    await rpc(s.client, 'session/delete', { sessionId: s.sessionId });
    expect(await rpcError(s.client, 'fs/readFile', { sessionId: s.sessionId, path: 'src/parser.ts' })).toMatchObject({ code: 'not_found' });
    expect(await rpcError(s.client, 'fs/readDirectory', { sessionId: s.sessionId, path: '' })).toMatchObject({ code: 'not_found' });
  });

  it('checks params: sessionId and path required, offset and maxBytes integers', async () => {
    const s = await setup();
    expect(await rpcError(s.client, 'fs/readFile', { path: 'x' })).toMatchObject({ code: 'invalid_params', data: { path: 'params.sessionId' } });
    expect(await rpcError(s.client, 'fs/readFile', { sessionId: s.sessionId })).toMatchObject({ code: 'invalid_params', data: { path: 'params.path' } });
    expect(await rpcError(s.client, 'fs/readFile', { sessionId: s.sessionId, path: 'src/parser.ts', offset: -1 })).toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.offset' },
    });
    expect(await rpcError(s.client, 'fs/readFile', { sessionId: s.sessionId, path: 'src/parser.ts', maxBytes: 0 })).toMatchObject({
      code: 'invalid_params',
      data: { path: 'params.maxBytes' },
    });
    expect(await rpcError(s.client, 'fs/readDirectory', { sessionId: s.sessionId, path: 3 })).toMatchObject({ code: 'invalid_params', data: { path: 'params.path' } });
  });
});

describe('GET /v1/file', () => {
  it('serves a session file with the blob headers plus ETag, Last-Modified and Accept-Ranges', async () => {
    const s = await setup();
    const response = await s.get({ sessionId: s.sessionId, path: 'shot.png' });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(PNG.length));
    expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.png");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers.get('last-modified')).toMatch(/GMT$/);
    const cookie = await fetch(`${s.base}/v1/file?${new URLSearchParams({ sessionId: s.sessionId, path: 'shot.png' })}`, {
      headers: { cookie: `nano_device=${s.token}` },
    });
    expect(cookie.status).toBe(200);
  });

  it('anything but a raster image is an attachment; text says its charset', async () => {
    const s = await setup();
    const html = await s.get({ sessionId: s.sessionId, path: 'page.html' });
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''page.html");
    expect(html.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    const ts = await s.get({ sessionId: s.sessionId, path: 'src/parser.ts' });
    expect(ts.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''parser.ts");
  });

  it('the same auth as /v1/blob: 401 without or with a bad or revoked token, 403 from another origin', async () => {
    const s = await setup();
    const query = new URLSearchParams({ sessionId: s.sessionId, path: 'shot.png' });
    const anonymous = await fetch(`${s.base}/v1/file?${query}`);
    expect(anonymous.status).toBe(401);
    expect(await errorOf(anonymous)).toMatchObject({ code: 'unauthorized' });
    expect((await fetch(`${s.base}/v1/file?${query}`, { headers: { authorization: 'Bearer forged' } })).status).toBe(401);
    const foreign = await fetch(`${s.base}/v1/file?${query}`, { headers: { cookie: `nano_device=${s.token}`, origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect((await s.get({ sessionId: s.sessionId, path: 'shot.png' }, { origin: s.base })).status).toBe(401);
    service!.server.revokeDevice(s.clientId);
    expect((await s.get({ sessionId: s.sessionId, path: 'shot.png' })).status).toBe(401);
  });

  it('400 without sessionId or path; 404 for an unknown or malformed session; 405 for other methods', async () => {
    const s = await setup();
    const noSession = await s.get({ path: 'shot.png' });
    expect(noSession.status).toBe(400);
    expect(await errorOf(noSession)).toMatchObject({ code: 'invalid_params', data: { path: 'sessionId' } });
    const noPath = await s.get({ sessionId: s.sessionId });
    expect(noPath.status).toBe(400);
    expect(await errorOf(noPath)).toMatchObject({ code: 'invalid_params', data: { path: 'path' } });
    expect((await s.get({ sessionId: 'ses_0nothere', path: 'shot.png' })).status).toBe(404);
    expect((await s.get({ sessionId: '../../x', path: 'shot.png' })).status).toBe(404);
    const folder = await s.get({ sessionId: s.sessionId, path: 'src' });
    expect(folder.status).toBe(400);
    expect(await errorOf(folder)).toMatchObject({ code: 'invalid_params', data: { path: 'path' } });
    const post = await s.get({ sessionId: s.sessionId, path: 'shot.png' }, {}, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('404 with the same body for .., an absolute path, a symlink out and a missing file', async () => {
    const s = await setup();
    const bodies = new Set<string>();
    for (const requested of ['../secret/key.txt', path.join(home, 'secret', 'key.txt'), 'escape', 'missing.txt', '/etc/hosts']) {
      const response = await s.get({ sessionId: s.sessionId, path: requested });
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).not.toContain('TOP SECRET');
      bodies.add(text.replace(JSON.stringify(requested).slice(1, -1), '<path>'));
    }
    expect(bodies.size).toBe(1);
  });

  it('a deleted session serves nothing', async () => {
    const s = await setup();
    expect((await s.get({ sessionId: s.sessionId, path: 'shot.png' })).status).toBe(200);
    await rpc(s.client, 'session/delete', { sessionId: s.sessionId });
    const gone = await s.get({ sessionId: s.sessionId, path: 'shot.png' });
    expect(gone.status).toBe(404);
    expect(await errorOf(gone)).toMatchObject({ code: 'not_found' });
  });

  it('HEAD answers headers only; If-None-Match with the ETag answers 304; a change makes a new ETag', async () => {
    const s = await setup();
    const head = await s.get({ sessionId: s.sessionId, path: 'src/parser.ts' }, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('41');
    expect(await head.text()).toBe('');
    const etag = head.headers.get('etag')!;
    const cached = await s.get({ sessionId: s.sessionId, path: 'src/parser.ts' }, { 'if-none-match': etag });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe(etag);
    writeFileSync(path.join(s.cwd, 'src', 'parser.ts'), 'export function parse() {\n  return 43;\n}\n// changed\n');
    const changed = await s.get({ sessionId: s.sessionId, path: 'src/parser.ts' }, { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('serves single byte ranges (206), refuses unsatisfiable ones (416), and ignores a stale If-Range', async () => {
    const s = await setup();
    const file = { sessionId: s.sessionId, path: 'src/parser.ts' };
    const etag = (await s.get(file, {}, 'HEAD')).headers.get('etag')!;
    const part = await s.get(file, { range: 'bytes=7-14' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 7-14/41');
    expect(part.headers.get('content-length')).toBe('8');
    expect(await part.text()).toBe('function');
    const tail = await s.get(file, { range: 'bytes=-2' });
    expect(await tail.text()).toBe('}\n');
    const open = await s.get(file, { range: 'bytes=39-' });
    expect(open.headers.get('content-range')).toBe('bytes 39-40/41');
    const beyond = await s.get(file, { range: 'bytes=41-' });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */41');
    expect(await errorOf(beyond)).toMatchObject({ code: 'invalid_params', data: { path: 'range' } });
    expect((await s.get(file, { range: 'bytes=0-1, 4-5' })).status).toBe(200);
    expect((await s.get(file, { range: 'bytes=0-3', 'if-range': etag })).status).toBe(206);
    expect((await s.get(file, { range: 'bytes=0-3', 'if-range': '"stale"' })).status).toBe(200);
  });

  it('a file over 20 MiB is refused with 413 and the limit', async () => {
    const s = await setup();
    const fd = openSync(path.join(s.cwd, 'huge.bin'), 'w');
    ftruncateSync(fd, MAX_SERVED_FILE_BYTES + 1);
    closeSync(fd);
    const response = await s.get({ sessionId: s.sessionId, path: 'huge.bin' });
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_params', data: { path: 'path', maxBytes: MAX_SERVED_FILE_BYTES } });
  });
});

describe('parseRange', () => {
  it('reads one bytes= range and leaves anything else to a whole-file answer', () => {
    expect(parseRange(undefined, 10)).toBeUndefined();
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-100', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 10)).toBeUndefined();
    expect(parseRange('bytes=-', 10)).toBeUndefined();
    expect(parseRange('items=0-1', 10)).toBeUndefined();
  });
});
