// End-to-end tests of the host's HTTP(S) origin on loopback: pairing, static files, stream auth and the
// device methods, with real sockets.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DeviceStore } from '../devices/store.js';
import { PAIRING_CODE_LIFETIME_MS, PairingCodes } from '../pairing/codes.js';
import { CloseCode, MAX_MESSAGE_BYTES } from '../stream/constants.js';
import { MethodRegistry } from '../stream/router.js';
import { TestClient } from '../stream/testing/client.js';
import { BindRefused, HostServer, defaultConfigDir, tlsFilesIn, type HostServerOptions } from './index.js';

const HOST = { hostId: 'host_test', name: 'test-mac' };
const LOOPBACK = async () => ({ dnsName: '127.0.0.1', addresses: ['127.0.0.1'] });

let publicDir: string;
beforeAll(() => {
  publicDir = mkdtempSync(path.join(tmpdir(), 'nano-public-'));
  mkdirSync(path.join(publicDir, 'assets'));
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Nano</title>');
  writeFileSync(path.join(publicDir, 'assets', 'app-Abc12345.js'), 'console.log(1)');
  writeFileSync(path.join(publicDir, 'assets', 'style.css'), 'body{}');
  writeFileSync(path.join(publicDir, 'manifest.webmanifest'), '{}');
  writeFileSync(path.join(publicDir, 'icon.svg'), '<svg/>');
  writeFileSync(path.join(publicDir, 'blob.bin'), 'x');
  writeFileSync(path.join(publicDir, '.secret'), 'no');
  return () => rmSync(publicDir, { recursive: true, force: true });
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function registry(devices: DeviceStore): MethodRegistry {
  return new MethodRegistry().register('initialize', (_params, ctx) => ({
    protocolVersion: 1,
    host: { ...HOST, version: '0.0.0', os: 'darwin', arch: 'arm64' },
    device: { clientId: ctx.clientId, displayName: devices.get(ctx.clientId)?.displayName ?? '' },
    agents: [],
    push: { vapidPublicKey: 'k', subscribed: false },
    limits: { maxMessageBytes: MAX_MESSAGE_BYTES, snapshotTurns: 5 },
  }));
}

interface Started {
  server: HostServer;
  devices: DeviceStore;
  base: string;
  clock: { now: number };
}

async function start(overrides: Partial<HostServerOptions> = {}): Promise<Started> {
  const devices = new DeviceStore({ path: ':memory:' });
  const clock = { now: Date.now() };
  let origin = '';
  const server = await HostServer.start({
    registry: registry(devices),
    devices,
    host: () => HOST,
    port: 0,
    resolve: LOOPBACK,
    tls: null,
    insecureDev: true,
    publicDir,
    pairing: new PairingCodes({ origin: () => origin, now: () => clock.now }),
    ...overrides,
  });
  origin = server.origin;
  cleanup.push(async () => {
    await server.close();
    devices.close();
  });
  return { server, devices, base: server.origin, clock };
}

const CLIENT = { name: 'iPhone (Safari)', platform: 'ios-web', userAgent: 'Mozilla/5.0 (iPhone)' };

function pair(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function pairDevice(started: Started, name = CLIENT.name): Promise<{ clientId: string; deviceToken: string }> {
  const { code } = started.server.issuePairingCode();
  const response = await pair(started.base, { code, client: { ...CLIENT, name } });
  expect(response.status).toBe(200);
  return (await response.json()) as { clientId: string; deviceToken: string };
}

async function stream(started: Started, options: Parameters<typeof TestClient.connect>[1]): Promise<TestClient> {
  const url = `${started.base.replace(/^http/, 'ws')}/v1/stream`;
  const client = await TestClient.connect(url, options);
  cleanup.push(() => client.close());
  return client;
}

describe('pairing over HTTP', () => {
  it('pairs a device, answers the documented shape and sets the cookie', async () => {
    const started = await start();
    const issued = started.server.issuePairingCode();
    expect(issued.url).toBe(`${started.base}/pair#code=${issued.code}`);
    const response = await pair(started.base, { code: issued.code, client: CLIENT });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { clientId: string; deviceToken: string; host: unknown };
    expect(Object.keys(body).sort()).toEqual(['clientId', 'deviceToken', 'host']);
    expect(body.clientId).toMatch(/^dev_/);
    expect(body.host).toEqual(HOST);
    expect(started.devices.get(body.clientId)).toMatchObject({
      displayName: 'iPhone (Safari)',
      platform: 'ios-web',
      userAgent: 'Mozilla/5.0 (iPhone)',
    });

    const cookie = response.headers.get('set-cookie')!;
    const [pairPart, ...attributes] = cookie.split(';').map((s) => s.trim());
    expect(pairPart).toBe(`nano_device=${body.deviceToken}`);
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']));
    expect(attributes.some((a) => a.startsWith('Domain'))).toBe(false);
  });

  it('falls back to the User-Agent header', async () => {
    const started = await start();
    const { code } = started.server.issuePairingCode();
    const response = await pair(started.base, { code, client: { name: 'Mac', platform: 'macos' } }, { 'user-agent': 'curl/8' });
    const body = (await response.json()) as { clientId: string };
    expect(started.devices.get(body.clientId)!.userAgent).toBe('curl/8');
  });

  it('refuses an expired code', async () => {
    const started = await start();
    const { code } = started.server.issuePairingCode();
    started.clock.now += PAIRING_CODE_LIFETIME_MS;
    const response = await pair(started.base, { code, client: CLIENT });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'unauthorized', message: 'pairing code is wrong, expired or already used' },
    });
    expect(started.devices.list()).toEqual([]);
  });

  it('refuses a reused code', async () => {
    const started = await start();
    const { code } = started.server.issuePairingCode();
    expect((await pair(started.base, { code, client: CLIENT })).status).toBe(200);
    const again = await pair(started.base, { code, client: CLIENT });
    expect(again.status).toBe(403);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(started.devices.list()).toHaveLength(1);
  });

  it('refuses wrong codes and rate limits the source after 5 failures', async () => {
    const started = await start();
    const { code } = started.server.issuePairingCode();
    const wrong = code === '00000000' ? '00000001' : '00000000';
    for (let i = 0; i < 5; i += 1) {
      expect((await pair(started.base, { code: wrong, client: CLIENT })).status).toBe(403);
    }
    const limited = await pair(started.base, { code, client: CLIENT });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: { code: string; data: { retryAfterMs: number } } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.data.retryAfterMs).toBeGreaterThan(0);
    started.clock.now += 60_000;
    expect((await pair(started.base, { code, client: CLIENT })).status).toBe(200);
  });

  it('validates the request', async () => {
    const started = await start();
    const { code } = started.server.issuePairingCode();
    const cases: [unknown, string][] = [
      ['not json', ''],
      [[], ''],
      [{ client: CLIENT }, 'code'],
      [{ code, client: 'x' }, 'client'],
      [{ code, client: { platform: 'ios-web' } }, 'client.name'],
      [{ code, client: { name: ' ', platform: 'ios-web' } }, 'client.name'],
      [{ code, client: { name: 'a' } }, 'client.platform'],
      [{ code, client: { name: 'a', platform: 'b', userAgent: 5 } }, 'client.userAgent'],
    ];
    for (const [body, at] of cases) {
      const response = await pair(started.base, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_params', data: { path: at } } });
    }
    // None of those consumed the code or counted as a failure.
    expect((await pair(started.base, { code, client: CLIENT })).status).toBe(200);
  });

  it('requires POST, a JSON content type and a small body', async () => {
    const started = await start();
    const get = await fetch(`${started.base}/v1/pair`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const form = await fetch(`${started.base}/v1/pair`, { method: 'POST', body: 'code=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
    const big = await pair(started.base, { code: '1', pad: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it('answers 500 when the device store fails', async () => {
    const started = await start();
    const { code } = started.server.issuePairingCode();
    started.devices.close();
    const response = await pair(started.base, { code, client: CLIENT });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
  });
});

describe('stream authentication', () => {
  it('accepts the device token as a bearer token and as the cookie', async () => {
    const started = await start();
    const { clientId, deviceToken } = await pairDevice(started);
    const bearer = await stream(started, { token: deviceToken, clientId });
    expect(await bearer.handshake()).toMatchObject({ result: { device: { clientId, displayName: 'iPhone (Safari)' } } });
    const cookie = await stream(started, { token: null, cookie: `nano_device=${deviceToken}`, clientId });
    expect(await cookie.handshake()).toMatchObject({ result: { device: { clientId } } });
  });

  it('security: accepts the cookie from the host’s own origin and refuses other origins with 4003', async () => {
    const started = await start();
    const device = await pairDevice(started);
    const own = await stream(started, { token: null, cookie: `nano_device=${device.deviceToken}`, clientId: device.clientId, headers: { origin: started.server.origin } });
    expect(await own.handshake()).toMatchObject({ result: { device: { clientId: device.clientId } } });
    const otherPort = started.server.origin.replace(/:\d+$/, ':1');
    const foreign = await stream(started, { token: null, cookie: `nano_device=${device.deviceToken}`, clientId: device.clientId, headers: { origin: otherPort } });
    expect(await foreign.closed).toEqual({ code: CloseCode.unauthorized, reason: 'origin not allowed' });
  });

  it('closes unknown tokens with 4003', async () => {
    const started = await start();
    const client = await stream(started, { token: 'nope' });
    expect(await client.closed).toMatchObject({ code: CloseCode.unauthorized });
  });

  it('updates lastSeenAt when a device connects', async () => {
    const devices = new DeviceStore({ path: ':memory:', now: () => clock.value });
    const clock = { value: 100 };
    const started = await start({ devices, registry: registry(devices) });
    const { clientId, deviceToken } = await pairDevice(started);
    clock.value = 500;
    const client = await stream(started, { token: deviceToken, clientId });
    await client.handshake();
    expect(devices.get(clientId)).toMatchObject({ createdAt: 100, lastSeenAt: 500 });
  });
});

describe('device methods', () => {
  it('lists devices with the current flag', async () => {
    const started = await start();
    const phone = await pairDevice(started, 'Phone');
    const laptop = await pairDevice(started, 'Laptop');
    const client = await stream(started, { token: phone.deviceToken, clientId: phone.clientId });
    await client.handshake();
    const { result } = (await client.call('device/list')) as { result: { devices: Record<string, unknown>[] } };
    expect(result.devices).toHaveLength(2);
    expect(result.devices.find((d) => d.clientId === phone.clientId)).toMatchObject({ displayName: 'Phone', current: true, platform: 'ios-web' });
    expect(result.devices.find((d) => d.clientId === laptop.clientId)).toMatchObject({ displayName: 'Laptop', current: false });
    expect(Object.keys(result.devices[0]!).sort()).toEqual(['clientId', 'createdAt', 'current', 'displayName', 'lastSeenAt', 'platform']);
  });

  it('renames a device and validates the name', async () => {
    const started = await start();
    const phone = await pairDevice(started, 'Phone');
    const client = await stream(started, { token: phone.deviceToken, clientId: phone.clientId });
    await client.handshake();
    expect(await client.call('device/rename', { clientId: phone.clientId, displayName: '  My iPhone ' })).toMatchObject({ result: { ok: true } });
    expect(started.devices.get(phone.clientId)!.displayName).toBe('My iPhone');
    expect(await client.call('device/rename', { clientId: phone.clientId, displayName: ' ' })).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'params.displayName' } },
    });
    expect(await client.call('device/rename', { clientId: phone.clientId, displayName: 'x'.repeat(101) })).toMatchObject({
      error: { code: 'invalid_params' },
    });
    expect(await client.call('device/rename', { clientId: phone.clientId, displayName: 5 })).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'params.displayName' } },
    });
    expect(await client.call('device/rename', { clientId: 'dev_missing', displayName: 'x' })).toMatchObject({
      error: { code: 'not_found', data: { clientId: 'dev_missing' } },
    });
    expect(await client.call('device/rename', { displayName: 'x' })).toMatchObject({
      error: { code: 'invalid_params', data: { path: 'params.clientId' } },
    });
  });

  it('revoke closes the other device’s open stream with 4003 at once and invalidates its token', async () => {
    const started = await start();
    const phone = await pairDevice(started, 'Phone');
    const laptop = await pairDevice(started, 'Laptop');
    const phoneStream = await stream(started, { token: phone.deviceToken, clientId: phone.clientId });
    await phoneStream.handshake();
    const laptopStream = await stream(started, { token: laptop.deviceToken, clientId: laptop.clientId });
    await laptopStream.handshake();

    expect(await laptopStream.call('device/revoke', { clientId: phone.clientId })).toMatchObject({ result: { ok: true } });
    expect(await phoneStream.closed).toEqual({ code: CloseCode.unauthorized, reason: 'device revoked' });
    expect(started.devices.authenticate(phone.deviceToken)).toBeNull();
    const retry = await stream(started, { token: phone.deviceToken, clientId: phone.clientId });
    expect(await retry.closed).toMatchObject({ code: CloseCode.unauthorized });
    expect(await laptopStream.call('device/revoke', { clientId: phone.clientId })).toMatchObject({ error: { code: 'not_found' } });
    expect(laptopStream.isClosed).toBeUndefined();
  });

  it('a device that revokes itself gets its response before the stream closes', async () => {
    const started = await start();
    const phone = await pairDevice(started);
    const client = await stream(started, { token: phone.deviceToken, clientId: phone.clientId });
    await client.handshake();
    const id = client.request('device/revoke', { clientId: phone.clientId });
    expect(await client.closed).toMatchObject({ code: CloseCode.unauthorized });
    expect(client.messages.find((m) => m.id === id)).toMatchObject({ result: { ok: true } });
  });

  it('the internal API revokes a device for the CLI', async () => {
    const started = await start();
    const phone = await pairDevice(started);
    const client = await stream(started, { token: phone.deviceToken, clientId: phone.clientId });
    await client.handshake();
    expect(started.server.revokeDevice(phone.clientId)).toBe(true);
    expect(await client.closed).toMatchObject({ code: CloseCode.unauthorized });
    expect(started.server.revokeDevice(phone.clientId)).toBe(false);
  });
});

describe('static files', () => {
  it('serves the web app with content types, and /pair, /chats, session and chat pages as client routes', async () => {
    const { base } = await start();
    const cases: [string, string][] = [
      ['/', 'text/html; charset=utf-8'],
      ['/pair', 'text/html; charset=utf-8'],
      ['/s/ses_01JFQ3K8M2XW7Z4R9VBNTH6C5D', 'text/html; charset=utf-8'],
      ['/chats', 'text/html; charset=utf-8'],
      ['/c/3f2a9c1e-6b7d-4e0a-9f1b-2c8d5e7a4b60', 'text/html; charset=utf-8'],
      ['/index.html', 'text/html; charset=utf-8'],
      ['/assets/app-Abc12345.js', 'text/javascript; charset=utf-8'],
      ['/assets/style.css', 'text/css; charset=utf-8'],
      ['/manifest.webmanifest', 'application/manifest+json'],
      ['/icon.svg', 'image/svg+xml'],
      ['/blob.bin', 'application/octet-stream'],
    ];
    for (const [urlPath, type] of cases) {
      const response = await fetch(`${base}${urlPath}`);
      expect(response.status, urlPath).toBe(200);
      expect(response.headers.get('content-type'), urlPath).toBe(type);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(await (await fetch(`${base}/pair`)).text()).toContain('<title>Nano</title>');
    expect(await (await fetch(`${base}/s/ses_fake_1`)).text()).toContain('<title>Nano</title>');
    expect(await (await fetch(`${base}/c/3f2a9c1e`)).text()).toContain('<title>Nano</title>');
    expect((await fetch(`${base}/s/a/b`)).status).toBe(404);
    expect((await fetch(`${base}/c/a/b`)).status).toBe(404);
    expect((await fetch(`${base}/assets/app-Abc12345.js`)).headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/`)).headers.get('cache-control')).toBe('no-cache');
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const { base } = await start();
    const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String('<!doctype html><title>Nano</title>'.length));
    expect(await head.text()).toBe('');
    const put = await fetch(`${base}/index.html`, { method: 'PUT' });
    expect(put.status).toBe(405);
  });

  it('answers 404 for missing files, directories, dotfiles and traversal', async () => {
    const { base } = await start();
    for (const urlPath of ['/missing.js', '/assets', '/.secret', '/%2e%2e/%2e%2e/etc/passwd', '/a%5c..%5c..%5cx', '/%E0%A4%A', '/x%00.js']) {
      expect((await fetch(`${base}${urlPath}`)).status, urlPath).toBe(404);
    }
    // fetch normalizes `..`; a raw request line does not.
    const raw = await new Promise<number>((resolve, reject) => {
      const request = http.request(`${base}/x`, { path: '/../../etc/passwd' }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.on('error', reject);
      request.end();
    });
    expect(raw).toBe(404);
  });

  it('routes /v1 paths', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/v1/stream`)).status).toBe(426);
    const unknown = await fetch(`${base}/v1/other`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'method_not_found' } });
  });

  it('answers 500 and logs when a request handler throws', async () => {
    const logged: string[] = [];
    const { base } = await start({ publicDir: 42 as unknown as string, log: (message) => logged.push(message) });
    expect((await fetch(`${base}/index.html`)).status).toBe(500);
    expect(logged).toContain('http request failed');
  });

  it('answers 404 when the public folder cannot be read', async () => {
    const { base } = await start({ publicDir: '\0bad' });
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });
});

describe('binding and TLS', () => {
  it('refuses to bind 0.0.0.0', async () => {
    const devices = new DeviceStore({ path: ':memory:' });
    cleanup.push(() => devices.close());
    const options = () => ({ registry: registry(devices), devices, host: () => HOST, port: 0, tls: null, insecureDev: true });
    const wildcard = (address: string) => async () => ({ dnsName: 'x', addresses: [address] });
    await expect(HostServer.start({ ...options(), resolve: wildcard('0.0.0.0') })).rejects.toThrow(BindRefused);
    await expect(HostServer.start({ ...options(), resolve: wildcard('::') })).rejects.toThrow(BindRefused);
    await expect(HostServer.start({ ...options(), insecureDev: false, resolve: LOOPBACK })).rejects.toThrow(/plain HTTP/);
  });

  it('serves HTTPS and wss from the cert and key files, on every address', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nano-tls-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const files = tlsFilesIn(dir);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', files.keyPath, '-out', files.certPath,
    ], { stdio: 'ignore' });
    chmodSync(files.certPath, 0o644);
    chmodSync(files.keyPath, 0o644);
    const started = await start({
      tls: files,
      insecureDev: false,
      resolve: async () => ({ dnsName: 'localhost', addresses: ['127.0.0.1', '::1'] }),
    });
    expect(started.server.origin).toBe(`https://localhost:${started.server.port}`);
    // security: the certificate and key are tightened to 0600 before they are read.
    expect(statSync(files.certPath).mode & 0o777).toBe(0o600);
    expect(statSync(files.keyPath).mode & 0o777).toBe(0o600);
    expect(started.server.addresses.map((a) => a.address)).toEqual(['127.0.0.1', '::1']);
    expect(new Set(started.server.addresses.map((a) => a.port)).size).toBe(1);
    expect(started.server.issuePairingCode().url).toMatch(/^https:\/\/localhost:\d+\/pair#code=\d{8}$/);

    const { code } = started.server.issuePairingCode();
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = https.request(
        `https://127.0.0.1:${started.server.port}/v1/pair`,
        { method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json' } },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () => resolve({ status: response.statusCode!, text }));
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ code, client: CLIENT }));
    });
    expect(body.status).toBe(200);
    const { clientId, deviceToken } = JSON.parse(body.text) as { clientId: string; deviceToken: string };
    const client = await TestClient.connect(`wss://[::1]:${started.server.port}/v1/stream`, {
      token: deviceToken,
      clientId,
      ws: { rejectUnauthorized: false },
    });
    cleanup.push(() => client.close());
    expect(await client.handshake()).toMatchObject({ result: { device: { clientId } } });
  });

  it('brackets an IPv6 origin and reports port 0 once closed', async () => {
    const started = await start({ resolve: async () => ({ dnsName: '::1', addresses: ['::1'] }) });
    expect(started.server.origin).toBe(`http://[::1]:${started.server.port}`);
    expect((await fetch(`${started.base}/`)).status).toBe(200);
    await started.server.close();
    expect(started.server.port).toBe(0);
    expect(started.server.addresses).toEqual([]);
  });

  it('defaults to the config folder certificate and the Tailscale CLI, and refuses before reading either', async () => {
    const devices = new DeviceStore({ path: ':memory:' });
    cleanup.push(() => devices.close());
    const base = () => ({ registry: registry(devices), devices, host: () => HOST, port: 0 });
    // Default TLS files: the wildcard is refused before the files are read.
    await expect(HostServer.start({ ...base(), resolve: async () => ({ dnsName: 'x', addresses: ['0.0.0.0'] }) })).rejects.toThrow(BindRefused);
    // Default resolver: the Tailscale CLI either fails (not installed, not running) or yields tailnet
    // addresses, which plain HTTP refuses. Either way nothing listens.
    await expect(HostServer.start({ ...base(), tls: null, insecureDev: true })).rejects.toThrow();
  });

  it('explains missing TLS files', async () => {
    const devices = new DeviceStore({ path: ':memory:' });
    cleanup.push(() => devices.close());
    await expect(
      HostServer.start({
        registry: registry(devices),
        devices,
        host: () => HOST,
        port: 0,
        resolve: LOOPBACK,
        tls: tlsFilesIn('/nonexistent'),
      }),
    ).rejects.toThrow(/tailscale cert/);
    expect(defaultConfigDir('/Users/x')).toBe('/Users/x/Library/Application Support/NanoHost');
  });

  it('closes what it opened when a later address fails to listen', async () => {
    const first = await start();
    const devices = new DeviceStore({ path: ':memory:' });
    cleanup.push(() => devices.close());
    await expect(
      HostServer.start({
        registry: registry(devices),
        devices,
        host: () => HOST,
        port: first.server.port,
        resolve: LOOPBACK,
        tls: null,
        insecureDev: true,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
