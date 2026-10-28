// The host's HTTPS front door (protocol-v1.md sections 1 and 8, ADR 0004): one origin that serves the
// web app, the pairing endpoint and the stream upgrade, listening on this Mac's tailnet addresses only.
//
//   const server = await HostServer.start({ registry, devices, host: () => info });
//   const { code, url } = server.issuePairingCode();   // the CLI shows url as a QR plus the code
//
// One HTTP(S) server per tailnet address (IPv4 and IPv6), all on the same port. Upgrades on
// /v1/stream go to the StreamServer, which authenticates the device token against the device store.
// The StreamServer's own listener is never started; this class owns the sockets.
import { chmodSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { handleBlob, isBlobPath } from '../attachments/endpoint.js';
import type { AttachmentStore } from '../attachments/store.js';
import { PRIVATE_FILE_MODE } from '../config/private-files.js';
import { registerDeviceMethods } from '../devices/methods.js';
import type { DeviceStore } from '../devices/store.js';
import { FILE_PATH, handleFile } from '../files/endpoint.js';
import { defaultJournalPath } from '../journal/journal.js';
import { PairingCodes, type IssuedCode } from '../pairing/codes.js';
import { registerPushMethods } from '../push/methods.js';
import type { PushSender } from '../push/sender.js';
import { PAIR_ENDPOINT, handlePair } from '../pairing/endpoint.js';
import { STREAM_PATH } from '../stream/constants.js';
import type { MethodRegistry } from '../stream/router.js';
import { StreamServer, type StreamServerOptions } from '../stream/server.js';
import { checkBindAddresses, resolveTailnet, type TailnetSelf } from './bind.js';
import { PUBLIC_DIR, SECURITY_HEADERS, serveStatic } from './static.js';

/** Port the host listens on unless configured otherwise. */
export const DEFAULT_PORT = 7420;

/** Certificate and key the CLI writes with `tailscale cert --cert-file ... --key-file ...`. */
export const TLS_CERT_FILE = 'tls-cert.pem';
export const TLS_KEY_FILE = 'tls-key.pem';

/** The host's config folder: next to the Journal, `~/Library/Application Support/NanoHost`. */
export function defaultConfigDir(home?: string): string {
  return path.dirname(defaultJournalPath(home));
}

export interface TlsFiles {
  certPath: string;
  keyPath: string;
}

/** The certificate and key paths inside a config folder. */
export function tlsFilesIn(configDir: string): TlsFiles {
  return { certPath: path.join(configDir, TLS_CERT_FILE), keyPath: path.join(configDir, TLS_KEY_FILE) };
}

export interface HostServerOptions {
  /** The router with the core methods; the device methods are added to it. */
  registry: MethodRegistry;
  devices: DeviceStore;
  /** `host` of the pairing response. */
  host: () => { hostId: string; name: string };
  /** Default DEFAULT_PORT; 0 picks a free port (tests). */
  port?: number;
  /** This Mac's tailnet name and addresses. Default: the Tailscale CLI. Tests return 127.0.0.1. */
  resolve?: () => Promise<TailnetSelf>;
  /** Certificate and key. Default: `tlsFilesIn(defaultConfigDir())`. `null` serves plain HTTP (needs insecureDev). */
  tls?: TlsFiles | null;
  /** Allows plain HTTP on loopback. Never in production. */
  insecureDev?: boolean;
  /** Default PUBLIC_DIR (host/public). */
  publicDir?: string;
  /** Pairing codes; default a fresh PairingCodes using this server's origin. */
  pairing?: PairingCodes;
  /** Sends `push/test` (the event pushes go through the PushNotifier); without it `push/test` answers `not_supported`. */
  pushSender?: PushSender;
  /**
   * Attachments (spec 8.1): the store and a check that a session exists and is not deleted. Without
   * them `/v1/blob` answers 404 like any unknown endpoint.
   */
  attachments?: { store: AttachmentStore; sessionExists: (sessionId: string) => boolean };
  /**
   * Session files (spec 4.1): the folder of a session that exists and is not deleted, else undefined.
   * Without it `/v1/file` answers 404 like any unknown endpoint.
   */
  files?: { sessionFolder: (sessionId: string) => string | undefined };
  /** Passed to the StreamServer. */
  stream?: Pick<StreamServerOptions, 'presence' | 'status' | 'pingTimeoutMs'>;
  log?: (message: string, error?: unknown) => void;
}

/** Reads the certificate and key, tightening both to 0600 first (security pass item 4). */
function readTls(files: TlsFiles): { cert: Buffer; key: Buffer } {
  try {
    chmodSync(files.certPath, PRIVATE_FILE_MODE);
    chmodSync(files.keyPath, PRIVATE_FILE_MODE);
    return { cert: readFileSync(files.certPath), key: readFileSync(files.keyPath) };
  } catch (error) {
    throw new Error(
      `cannot read the TLS certificate (${files.certPath}) or key (${files.keyPath}); create them with ` +
        `\`tailscale cert --cert-file <cert> --key-file <key> <name>.ts.net\`: ${(error as Error).message}`,
    );
  }
}

export class HostServer {
  readonly streams: StreamServer;
  readonly pairing: PairingCodes;
  private readonly servers: (http.Server | https.Server)[] = [];
  private readonly log: (message: string, error?: unknown) => void;
  private self: TailnetSelf = { dnsName: '', addresses: [] };
  private secure = false;

  private constructor(private readonly options: HostServerOptions) {
    this.log = options.log ?? (() => {});
    this.pairing = options.pairing ?? new PairingCodes({ origin: () => this.origin });
    registerDeviceMethods(options.registry, {
      devices: options.devices,
      closeStreams: (clientId) => this.streams.revokeClient(clientId),
    });
    registerPushMethods(options.registry, {
      subscriptions: options.devices.push,
      log: (event, clientId) => this.log(`${event} clientId=${clientId}`),
      ...(options.pushSender ? { sender: options.pushSender } : {}),
      hostName: () => options.host().name,
    });
    this.streams = new StreamServer({
      ...options.stream,
      registry: options.registry,
      authenticate: (token) => options.devices.authenticate(token),
      // URL normalizes case and drops a default port, as browsers do in the Origin header.
      allowedOrigins: () => [new URL(this.origin).origin],
      log: this.log,
    });
  }

  /** Resolves the listen addresses, checks them (BindRefused), reads TLS, and listens on every address. */
  static async start(options: HostServerOptions): Promise<HostServer> {
    const server = new HostServer(options);
    await server.listen();
    return server;
  }

  private async listen(): Promise<void> {
    const tlsFiles = this.options.tls === undefined ? tlsFilesIn(defaultConfigDir()) : this.options.tls;
    this.self = await (this.options.resolve ?? (() => resolveTailnet()))();
    checkBindAddresses(this.self.addresses, { tls: tlsFiles !== null, insecureDev: this.options.insecureDev ?? false });
    const tls = tlsFiles === null ? null : readTls(tlsFiles);
    this.secure = tls !== null;
    let port = this.options.port ?? DEFAULT_PORT;
    const listener: http.RequestListener = (request, response) => void this.handle(request, response);
    try {
      for (const address of this.self.addresses) {
        const server = tls ? https.createServer(tls, listener) : http.createServer(listener);
        server.on('upgrade', (request, socket, head) => void this.streams.handleUpgrade(request, socket, head));
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, address, () => {
            server.off('error', reject);
            resolve();
          });
        });
        port = (server.address() as AddressInfo).port;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** `https://<host>.<tailnet>.ts.net:<port>` (or `http://` in insecureDev). */
  get origin(): string {
    const name = this.self.dnsName.includes(':') ? `[${this.self.dnsName}]` : this.self.dnsName;
    return `${this.secure ? 'https' : 'http'}://${name}:${this.port}`;
  }

  /** The bound port (the same on every address). */
  get port(): number {
    const address = this.servers[0]?.address() as AddressInfo | null | undefined;
    return address?.port ?? 0;
  }

  /** Addresses actually listened on. */
  get addresses(): AddressInfo[] {
    return this.servers.map((s) => s.address()).filter((a): a is AddressInfo => typeof a === 'object' && a !== null);
  }

  /** Internal API for the CLI: a fresh pairing code and the QR URL that carries it. */
  issuePairingCode(): IssuedCode {
    return this.pairing.issue();
  }

  /** Internal API for the CLI (a lost phone): revokes a device and closes its streams with 4003. */
  revokeDevice(clientId: string): boolean {
    const revoked = this.options.devices.revoke(clientId);
    if (revoked) this.streams.revokeClient(clientId);
    return revoked;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const urlPath = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (urlPath === PAIR_ENDPOINT) {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
        return await handlePair(request, response, {
          codes: this.pairing,
          devices: this.options.devices,
          host: this.options.host,
          log: this.log,
        });
      }
      if (urlPath === STREAM_PATH) {
        response.writeHead(426, { ...SECURITY_HEADERS, upgrade: 'websocket', 'content-type': 'text/plain; charset=utf-8' });
        response.end('upgrade required\n');
        return;
      }
      const attachments = this.options.attachments;
      if (attachments !== undefined && isBlobPath(urlPath)) {
        return await handleBlob(request, response, {
          ...attachments,
          authenticate: (token) => this.options.devices.authenticate(token),
          origin: () => this.origin,
          log: this.log,
        });
      }
      const files = this.options.files;
      if (files !== undefined && urlPath === FILE_PATH) {
        return await handleFile(request, response, {
          ...files,
          authenticate: (token) => this.options.devices.authenticate(token),
          origin: () => this.origin,
          log: this.log,
        });
      }
      if (urlPath.startsWith('/v1/')) {
        response.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { code: 'method_not_found', message: 'unknown endpoint' } }));
        return;
      }
      await serveStatic(request, response, this.options.publicDir ?? PUBLIC_DIR, urlPath);
    } catch (error) {
      this.log('http request failed', error);
      if (!response.headersSent) response.writeHead(500, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
      response.end();
    }
  }

  /** Closes every stream with 4010, then every listener. */
  async close(): Promise<void> {
    await this.streams.close();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  }
}
