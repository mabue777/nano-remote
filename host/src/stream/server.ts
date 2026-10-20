// The envelope stream server (spec 1, 2, 10): HTTP(S) listener, authentication at the upgrade, the
// registry of open streams, and the notification API the rest of the host uses.
//
// Authentication is injected: the pairing code supplies a function from device token to clientId.
// Rejections happen after the upgrade with a close code (4001, 4003, 4010), because a browser cannot
// read the HTTP status of a failed WebSocket upgrade but does see the close code and reason.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { Connection, type SendOptions } from './connection.js';
import {
  ACCEPTED_PROTOCOL_VERSIONS,
  CloseCode,
  DEVICE_COOKIE,
  MAX_FRAME_BYTES,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION_HEADER,
  STREAM_PATH,
} from './constants.js';
import { PresenceRegistry } from './presence.js';
import type { MethodRegistry } from './router.js';

/** Device token (from the cookie or the bearer header) to clientId, or null when unknown or revoked. */
export type Authenticate = (token: string) => string | null | Promise<string | null>;

export interface StreamServerOptions {
  authenticate: Authenticate;
  registry: MethodRegistry;
  /** Listen address. Default 127.0.0.1; production passes the tailnet address (spec 1). */
  host?: string;
  /** Default 0 (any free port). */
  port?: number;
  /** Serve wss:// with this certificate and key (PEM files). Plain ws:// when absent. */
  tls?: { certPath: string; keyPath: string };
  presence?: PresenceRegistry;
  /** Adapter health for pongs; `draining` is set by the server itself. Default `active`. */
  status?: () => 'active' | 'degraded';
  /** Handles plain HTTP requests (the web app, pairing). Default answers 404. */
  requestListener?: http.RequestListener;
  pingTimeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** The device token from `Authorization: Bearer` or the `nano_device` cookie (spec 1). */
export function tokenFrom(request: http.IncomingMessage): string | null {
  const auth = request.headers.authorization;
  if (auth) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (match) return match[1]!;
  }
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === DEVICE_COOKIE) {
      const value = part.slice(eq + 1).trim();
      if (value) return decodeURIComponent(value);
    }
  }
  return null;
}

export class StreamServer {
  readonly presence: PresenceRegistry;
  private readonly wss: WebSocketServer;
  private readonly server: http.Server;
  private readonly byStream = new Map<string, Connection>();
  private readonly connections = new Set<Connection>();
  private draining = false;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: StreamServerOptions) {
    this.presence = options.presence ?? new PresenceRegistry();
    this.log = options.log ?? (() => {});
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    const listener: http.RequestListener =
      options.requestListener ??
      ((_request, response) => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
      });
    this.server = options.tls
      ? https.createServer({ cert: readFileSync(options.tls.certPath), key: readFileSync(options.tls.keyPath) }, listener)
      : http.createServer(listener);
    this.server.on('upgrade', (request, socket, head) => void this.handleUpgrade(request, socket, head));
  }

  /** Starts listening; resolves with the bound address. */
  listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  /** `ws://` or `wss://` URL of the stream endpoint once listening. */
  get url(): string {
    const address = this.server.address() as AddressInfo;
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return `${this.options.tls ? 'wss' : 'ws'}://${host}:${address.port}${STREAM_PATH}`;
  }

  /** Upgrade handler; exposed so another HTTP server can mount the stream endpoint. */
  async handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== STREAM_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const reject = (code: number, reason: string) =>
      this.wss.handleUpgrade(request, socket, head, (ws) => ws.close(code, reason));

    if (this.draining) return reject(CloseCode.draining, 'host is draining; reconnect later');
    const version = request.headers[PROTOCOL_VERSION_HEADER];
    if (version !== undefined && !ACCEPTED_PROTOCOL_VERSIONS.includes(Number(version))) {
      return reject(
        CloseCode.unsupportedProtocol,
        `unsupported protocol version; accepted: ${ACCEPTED_PROTOCOL_VERSIONS.join(',')}`,
      );
    }
    const token = tokenFrom(request);
    let clientId: string | null = null;
    if (token !== null) {
      try {
        clientId = await this.options.authenticate(token);
      } catch (error) {
        this.log('stream authentication failed', error);
      }
    }
    if (clientId === null) return reject(CloseCode.unauthorized, 'device token missing, unknown or revoked');
    if (this.draining) return reject(CloseCode.draining, 'host is draining; reconnect later');
    const id = clientId;
    this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, id));
  }

  private accept(socket: WebSocket, clientId: string): void {
    const connection = new Connection({
      socket,
      clientId,
      registry: this.options.registry,
      presence: this.presence,
      status: () => (this.draining ? 'draining' : (this.options.status?.() ?? 'active')),
      pingTimeoutMs: this.options.pingTimeoutMs ?? PING_TIMEOUT_MS,
      claimStreamId: (conn, streamId) => {
        if (this.byStream.has(streamId)) return false;
        this.byStream.set(streamId, conn);
        return true;
      },
      onClosed: (conn) => {
        this.connections.delete(conn);
        if (this.byStream.get(conn.streamId) === conn) this.byStream.delete(conn.streamId);
      },
      log: this.log,
    });
    this.connections.add(connection);
  }

  /** Sends a notification on one stream. False when the stream is unknown, closed, uninitialized or opted out. */
  notifyStream(streamId: string, method: string, params?: Record<string, unknown>, options?: SendOptions): boolean {
    return this.byStream.get(streamId)?.notify(method, params, options) ?? false;
  }

  /**
   * Sends a notification on every stream of a client that finished the handshake (`initialized`
   * received, spec 4). Returns how many streams accepted it.
   */
  notifyClient(clientId: string, method: string, params?: Record<string, unknown>, options?: SendOptions): number {
    let count = 0;
    for (const connection of this.connections) {
      if (connection.clientId === clientId && connection.ready && connection.notify(method, params, options)) count += 1;
    }
    return count;
  }

  /** Open streams, optionally of one client. */
  streams(clientId?: string): Connection[] {
    return [...this.connections].filter((c) => clientId === undefined || c.clientId === clientId);
  }

  stream(streamId: string): Connection | undefined {
    return this.byStream.get(streamId);
  }

  /** Closes every stream of a revoked device with 4003 (spec 8). Returns how many were closed. */
  revokeClient(clientId: string): number {
    const streams = this.streams(clientId);
    for (const connection of streams) connection.close(CloseCode.unauthorized, 'device revoked');
    return streams.length;
  }

  /** Pongs report `draining` and new streams are refused with 4010; open streams keep working. */
  beginDrain(): void {
    this.draining = true;
  }

  /** Shutdown: closes every stream with 4010, waits for the sockets, and stops listening. */
  async close(): Promise<void> {
    this.beginDrain();
    const closed = [...this.wss.clients].map(
      (ws) => new Promise<void>((resolve) => (ws.readyState === ws.CLOSED ? resolve() : ws.once('close', () => resolve()))),
    );
    for (const connection of this.connections) connection.close(CloseCode.draining, 'host is shutting down');
    await Promise.all(closed);
    this.wss.close();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}
