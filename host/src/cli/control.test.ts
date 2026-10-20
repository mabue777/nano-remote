import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeviceRecord } from '../devices/store.js';
import {
  CONTROL_SECRET_HEADER,
  ControlRequestError,
  ControlServer,
  HostNotRunning,
  controlRequest,
  ensureControlSecret,
  type ControlHandlers,
  type ControlStatus,
} from './control.js';

let dir: string;
let server: ControlServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nano-ctl-'));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const DEVICE: DeviceRecord = { clientId: 'dev_1', displayName: 'iPhone', platform: 'ios-web', userAgent: '', createdAt: 1, lastSeenAt: 2 };

function handlers(): ControlHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: () => ({ state: 'running', pid: 1, version: '0.0.0' }) as ControlStatus,
    pair: () => ({ code: '12345678', expiresAt: 99, url: 'https://mac:7420/pair#code=12345678' }),
    listDevices: () => [DEVICE],
    revokeDevice: (clientId) => {
      calls.push(`revoke ${clientId}`);
      return clientId === 'dev_1';
    },
    renameDevice: (clientId, name) => {
      if (name === 'bad') throw new ControlRequestError(400, 'the name must be 1 to 100 characters');
      calls.push(`rename ${clientId} ${name}`);
      return clientId === 'dev_1';
    },
  };
}

async function start(h = handlers(), log?: (event: string, fields: Record<string, unknown>) => void) {
  const socketPath = path.join(dir, 'control.sock');
  const secretPath = path.join(dir, 'control.secret');
  server = await ControlServer.start({ socketPath, secret: ensureControlSecret(secretPath), handlers: h, ...(log ? { log } : {}) });
  return { socketPath, secretPath };
}

function rawRequest(socketPath: string, route: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method: 'GET', headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
}

describe('control secret', () => {
  it('is created once with mode 0600 and reused', () => {
    const file = path.join(dir, 'control.secret');
    const secret = ensureControlSecret(file);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(ensureControlSecret(file)).toBe(secret);
  });

  it('replaces a truncated secret', () => {
    const file = path.join(dir, 'control.secret');
    writeFileSync(file, 'short\n');
    expect(ensureControlSecret(file)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('control channel round trip', () => {
  it('serves status, pair and the device commands over the socket', async () => {
    const h = handlers();
    const events: string[] = [];
    const target = await start(h, (event) => events.push(event));
    expect(statSync(target.socketPath).mode & 0o777).toBe(0o600);

    expect(await controlRequest<ControlStatus>(target, 'GET', '/v1/status')).toMatchObject({ state: 'running', pid: 1 });
    expect(await controlRequest(target, 'POST', '/v1/pair')).toEqual({
      code: '12345678',
      expiresAt: 99,
      url: 'https://mac:7420/pair#code=12345678',
    });
    expect(await controlRequest(target, 'GET', '/v1/devices')).toEqual({ devices: [DEVICE] });
    expect(await controlRequest(target, 'POST', '/v1/devices/revoke', { clientId: 'dev_1' })).toEqual({ ok: true });
    expect(await controlRequest(target, 'POST', '/v1/devices/rename', { clientId: 'dev_1', displayName: 'Work' })).toEqual({ ok: true });
    expect(h.calls).toEqual(['revoke dev_1', 'rename dev_1 Work']);
    expect(events).toEqual(['control.pair', 'control.device.revoke', 'control.device.rename']);
  });

  it('answers errors with the handler message', async () => {
    const target = await start();
    await expect(controlRequest(target, 'POST', '/v1/devices/revoke', { clientId: 'dev_x' })).rejects.toThrow('no such device: dev_x');
    await expect(controlRequest(target, 'POST', '/v1/devices/rename', { clientId: 'dev_1', displayName: 'bad' })).rejects.toThrow(
      'the name must be 1 to 100 characters',
    );
    await expect(controlRequest(target, 'POST', '/v1/devices/revoke', {})).rejects.toThrow('clientId must be a non-empty string');
    await expect(controlRequest(target, 'GET', '/v1/nothing')).rejects.toThrow('unknown control route GET /v1/nothing');
  });

  it('refuses a request without the right secret', async () => {
    const events: string[] = [];
    const target = await start(handlers(), (event) => events.push(event));
    expect(await rawRequest(target.socketPath, '/v1/status')).toBe(401);
    expect(await rawRequest(target.socketPath, '/v1/status', { [CONTROL_SECRET_HEADER]: 'x'.repeat(64) })).toBe(401);
    const secret = readFileSync(target.secretPath, 'utf8').trim();
    expect(await rawRequest(target.socketPath, '/v1/status', { [CONTROL_SECRET_HEADER]: secret })).toBe(200);
    expect(events).toEqual(['control.unauthorized', 'control.unauthorized']);
  });

  it('reports a host that is not running', async () => {
    const target = { socketPath: path.join(dir, 'control.sock'), secretPath: path.join(dir, 'control.secret') };
    await expect(controlRequest(target, 'GET', '/v1/status')).rejects.toThrow(HostNotRunning);
    ensureControlSecret(target.secretPath);
    await expect(controlRequest(target, 'GET', '/v1/status')).rejects.toThrow(/nobody listens/);
  });

  it('replaces a stale socket file but refuses to start next to a live host', async () => {
    const socketPath = path.join(dir, 'control.sock');
    // A socket file nobody listens on, as a crashed host leaves it.
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(socketPath, resolve));
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    writeFileSync(socketPath, '');
    const target = await start();
    expect(await controlRequest(target, 'GET', '/v1/status')).toMatchObject({ state: 'running' });
    await expect(
      ControlServer.start({ socketPath, secret: 's'.repeat(64), handlers: handlers() }),
    ).rejects.toThrow(/another host is already running/);
    await server!.close();
    server = undefined;
    expect(() => statSync(socketPath)).toThrow();
  });
});
