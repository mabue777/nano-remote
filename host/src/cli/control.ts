// The control channel: how `nano-host status`, `pair` and `devices` talk to the running service.
//
// HTTP over a Unix socket in the config folder (`control.sock`, mode 0600, folder 0700). Every request
// carries the secret from `control.secret` (0600, created by the service) in the
// `x-nano-control-secret` header, compared in constant time. So only this user can reach it, and a
// process that can open the socket but not read the secret file still gets 401.
//
//   GET  /v1/status                                  -> ControlStatus
//   POST /v1/pair                                    -> {code, url, expiresAt}
//   GET  /v1/devices                                 -> {devices: DeviceRecord[]}
//   POST /v1/devices/revoke {clientId}               -> {ok: true}       404 when unknown
//   POST /v1/devices/rename {clientId, displayName}  -> {ok: true}       404 when unknown, 400 bad name
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

import type { DeviceRecord } from '../devices/store.js';
import type { IssuedCode } from '../pairing/codes.js';

export const CONTROL_SECRET_HEADER = 'x-nano-control-secret';
const MAX_BODY_BYTES = 16 * 1024;

export interface ControlStatus {
  state: 'running' | 'draining';
  pid: number;
  version: string;
  hostId: string;
  origin: string;
  addresses: string[];
  port: number;
  uptimeSeconds: number;
  devices: number;
  streams: number;
  sessionsActive: number;
  agents: { id: string; status: string; version?: string; reason?: string }[];
}

export interface ControlHandlers {
  status(): ControlStatus;
  pair(): IssuedCode;
  listDevices(): DeviceRecord[];
  /** False when unknown or already revoked. */
  revokeDevice(clientId: string): boolean;
  /** False when unknown. Throws ControlRequestError for a bad name. */
  renameDevice(clientId: string, displayName: string): boolean;
}

/** A client mistake the handler reports with an HTTP status and message. */
export class ControlRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ControlRequestError';
  }
}

/** Reads the secret, creating it (32 random bytes, hex, 0600) when missing. */
export function ensureControlSecret(file: string): string {
  try {
    const secret = readFileSync(file, 'utf8').trim();
    if (secret.length >= 32) {
      chmodSync(file, 0o600);
      return secret;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

function sameSecret(given: string | string[] | undefined, secret: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ControlRequestError(413, 'body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new ControlRequestError(400, 'body must be a JSON object'));
      }
    });
    request.on('error', reject);
  });
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) throw new ControlRequestError(400, `${key} must be a non-empty string`);
  return value;
}

/** True when something accepts connections on the socket (another host owns it). */
function socketInUse(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export class ControlServer {
  private constructor(
    private readonly server: http.Server,
    readonly socketPath: string,
  ) {}

  /**
   * Listens on `socketPath`. A stale socket file from a crashed host is removed; a live one means another
   * host is running, which is an error.
   */
  static async start(options: {
    socketPath: string;
    secret: string;
    handlers: ControlHandlers;
    log?: (event: string, fields: Record<string, unknown>) => void;
  }): Promise<ControlServer> {
    const { socketPath, secret, handlers } = options;
    if (await socketInUse(socketPath)) throw new Error(`another host is already running (control socket ${socketPath} answers)`);
    rmSync(socketPath, { force: true });
    const server = http.createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://control');
        const route = `${request.method ?? 'GET'} ${url.pathname}`;
        if (!sameSecret(request.headers[CONTROL_SECRET_HEADER], secret)) {
          options.log?.('control.unauthorized', { route });
          return send(response, 401, { error: 'wrong or missing control secret' });
        }
        try {
          switch (route) {
            case 'GET /v1/status':
              return send(response, 200, handlers.status());
            case 'POST /v1/pair': {
              const issued = handlers.pair();
              options.log?.('control.pair', { expiresAt: issued.expiresAt });
              return send(response, 200, issued);
            }
            case 'GET /v1/devices':
              return send(response, 200, { devices: handlers.listDevices() });
            case 'POST /v1/devices/revoke': {
              const clientId = stringField(await readJson(request), 'clientId');
              const ok = handlers.revokeDevice(clientId);
              options.log?.('control.device.revoke', { clientId, ok });
              return ok ? send(response, 200, { ok: true }) : send(response, 404, { error: `no such device: ${clientId}` });
            }
            case 'POST /v1/devices/rename': {
              const body = await readJson(request);
              const clientId = stringField(body, 'clientId');
              const ok = handlers.renameDevice(clientId, stringField(body, 'displayName'));
              options.log?.('control.device.rename', { clientId, ok });
              return ok ? send(response, 200, { ok: true }) : send(response, 404, { error: `no such device: ${clientId}` });
            }
            default:
              return send(response, 404, { error: `unknown control route ${route}` });
          }
        } catch (error) {
          if (error instanceof ControlRequestError) return send(response, error.status, { error: error.message });
          options.log?.('control.error', { route, error });
          return send(response, 500, { error: 'internal error' });
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    return new ControlServer(server, socketPath);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    rmSync(this.socketPath, { force: true });
  }
}

/** The host is not running (no socket, nobody listening, or no secret file). */
export class HostNotRunning extends Error {
  constructor(detail: string) {
    super(`the host is not running (${detail}); start it with \`nano-host start\` or \`nano-host install\``);
    this.name = 'HostNotRunning';
  }
}

export interface ControlClientOptions {
  socketPath: string;
  secretPath: string;
  timeoutMs?: number;
}

/** Calls the running host. Throws HostNotRunning, or an Error with the host's message on a non-2xx answer. */
export async function controlRequest<T>(
  options: ControlClientOptions,
  method: 'GET' | 'POST',
  route: string,
  body?: Record<string, unknown>,
): Promise<T> {
  let secret: string;
  try {
    secret = readFileSync(options.secretPath, 'utf8').trim();
  } catch {
    throw new HostNotRunning(`cannot read ${options.secretPath}`);
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const request = http.request(
      {
        socketPath: options.socketPath,
        // One connection per call: a pooled keep-alive socket would outlive a restarted host (EPIPE).
        agent: false,
        path: route,
        method,
        timeout: options.timeoutMs ?? 10_000,
        headers: {
          [CONTROL_SECRET_HEADER]: secret,
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new Error(`control channel: answer is not JSON (HTTP ${response.statusCode})`));
          }
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(parsed as T);
          const message = (parsed as { error?: unknown }).error;
          reject(new Error(typeof message === 'string' ? message : `control channel: HTTP ${status}`));
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('control channel: no answer within the timeout')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') reject(new HostNotRunning(`nobody listens on ${options.socketPath}`));
      else reject(error);
    });
    request.end(payload);
  });
}
