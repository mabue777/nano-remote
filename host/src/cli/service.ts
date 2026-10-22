// The running host: the composition root that `nano-host start` builds from the config file.
//
//   Journal + device store (same SQLite file) -> agents -> HostCore -> router (+ initialize, provider relay)
//   -> HostServer (HTTPS on the tailnet: web app, /v1/pair, /v1/stream) -> control channel
//
// Shutdown (SIGTERM from launchd, or Ctrl-C): pongs report `draining` and new streams are refused with
// 4010, then every open stream closes with 4010, the engines stop, and the Journal is closed, which
// checkpoints its write-ahead log into the database file.
import os, { hostname } from 'node:os';
import path from 'node:path';

import { ClaudeAgent } from '../adapters/claude/provider.js';
import { CodexAgent } from '../adapters/codex/provider.js';
import { claudeConfig } from '../config/claude.js';
import { codexConfig } from '../config/codex.js';
import { ensurePrivateDir } from '../config/private-files.js';
import { describeAgent, type AgentProvider } from '../core/adapter.js';
import { HostCore } from '../core/host-core.js';
import { SessionStore } from '../core/store.js';
import { DeviceStore, MAX_DISPLAY_NAME_LENGTH } from '../devices/store.js';
import type { Host } from '../generated/common.js';
import { isLoopback, resolveTailnet, type TailnetSelf } from '../http/bind.js';
import { HostServer } from '../http/server.js';
import { DEFAULT_SNAPSHOT_TURNS, Journal } from '../journal/journal.js';
import { registerProviderMethods } from '../providers/methods.js';
import { ProviderRelay } from '../providers/relay.js';
import { PushNotifier } from '../push/notifier.js';
import { PushSender } from '../push/sender.js';
import { ensureVapidKeys } from '../push/vapid.js';
import { VapidSigner } from '../push/vapid-jwt.js';
import { MAX_MESSAGE_BYTES } from '../stream/constants.js';
import { PresenceRegistry } from '../stream/presence.js';
import { MethodRegistry } from '../stream/router.js';
import type { HostConfig } from './config.js';
import { ControlRequestError, ControlServer, ensureControlSecret, type ControlStatus } from './control.js';
import type { Logger } from './log.js';
import { controlSecretPath, controlSocketPath, vapidKeysPath } from './paths.js';
import { HOST_VERSION } from './version.js';

/** How long pongs say `draining` before the streams are closed. */
export const DEFAULT_DRAIN_MS = 1_000;

export interface ServiceOptions {
  config: HostConfig;
  /** The config file; the control socket and secret live next to it. */
  configPath: string;
  logger: Logger;
  /** Plain HTTP on loopback only (`--insecure-dev`). */
  insecureDev?: boolean;
  /** Overrides the agents built from `enabledAgents` (tests). */
  agents?: AgentProvider[];
  /** Overrides the Tailscale lookup (tests). */
  resolve?: () => Promise<TailnetSelf>;
  publicDir?: string;
  drainMs?: number;
  pingTimeoutMs?: number;
}

/** This Mac's short name: `mabue-mbp` from `mabue-mbp.local`. */
export function shortHostname(name = hostname()): string {
  return name.replace(/\.local$/i, '').split('.')[0] || 'mac';
}

export function buildAgents(config: HostConfig, logger: Logger): AgentProvider[] {
  return config.enabledAgents.map((id) => {
    switch (id) {
      case 'codex':
        return new CodexAgent({ config: codexConfig({ binary: config.codexBinary }), log: logger.forModule('codex') });
      case 'claude':
        // Only the keys the config sets: an absent one keeps claudeConfig()'s default.
        return new ClaudeAgent({
          config: claudeConfig({
            ...(config.claudeConfigDir !== undefined ? { configDir: config.claudeConfigDir } : {}),
            ...(config.claudeExecutable !== undefined ? { executable: config.claudeExecutable } : {}),
          }),
          log: logger.forModule('claude'),
        });
    }
  });
}

/**
 * Where to listen and which name the pairing URL uses. Empty `listenAddresses`: Tailscale's addresses
 * and MagicDNS name (in insecure-dev: 127.0.0.1). Explicit loopback addresses need no Tailscale.
 */
export function listenPlan(
  config: HostConfig,
  insecureDev: boolean,
  tailnet: () => Promise<TailnetSelf>,
): () => Promise<TailnetSelf> {
  return async () => {
    const addresses = config.listenAddresses.length > 0 ? config.listenAddresses : insecureDev ? ['127.0.0.1'] : [];
    if (addresses.length > 0 && addresses.every(isLoopback)) return { dnsName: addresses[0]!, addresses };
    const self = await tailnet();
    return addresses.length > 0 ? { dnsName: self.dnsName, addresses } : self;
  };
}

export class HostService {
  private stopping: Promise<void> | undefined;
  private draining = false;

  private constructor(
    readonly server: HostServer,
    readonly core: HostCore,
    readonly journal: Journal,
    readonly store: SessionStore,
    readonly devices: DeviceStore,
    readonly control: ControlServer,
    readonly notifier: PushNotifier,
    readonly relay: ProviderRelay,
    private readonly options: ServiceOptions,
    private readonly startedAt: number,
  ) {}

  static async start(options: ServiceOptions): Promise<HostService> {
    const { config, logger } = options;
    const insecureDev = options.insecureDev ?? false;
    const startedAt = Date.now();
    logger.info('host.start', {
      pid: process.pid,
      version: HOST_VERSION,
      node: process.version,
      hostId: config.hostId,
      configPath: options.configPath,
      insecureDev,
    });

    const host: Host = {
      hostId: config.hostId,
      name: shortHostname(),
      version: HOST_VERSION,
      os: process.platform,
      arch: os.arch(),
    };
    // The NanoHost folder holds the control secret, the VAPID key and usually the TLS key: 0700 (item 5).
    ensurePrivateDir(path.dirname(options.configPath));
    const vapid = ensureVapidKeys(vapidKeysPath(options.configPath));
    // One log line per push: clientId, outcome, status code, the push service's reason on a refusal,
    // duration. Never the endpoint, keys or payload.
    const signer = new VapidSigner({ keys: vapid, ...(config.vapidContact !== undefined ? { contact: config.vapidContact } : {}) });
    const pushSender = new PushSender({ signer, log: (fields) => logger.info('push.sent', { ...fields }) });
    const journal = new Journal({
      path: config.journalPath,
      onListenerError: (error, event) => logger.error('journal.listener_failed', { method: event.method, seq: event.params.seq, error }),
    });
    const devices = new DeviceStore({ path: config.journalPath });
    // The engine's session ids (to resume a thread after a restart), archive flags and turn/start
    // idempotency live beside the Journal in the same file, so they survive a restart too.
    const store = new SessionStore(config.journalPath);
    const agents = options.agents ?? buildAgents(config, logger);
    // Who has an open stream: the stream server fills it, the push rules (spec 9) read it.
    const presence = new PresenceRegistry();
    const notifier = new PushNotifier({
      subscriptions: devices.push,
      presence,
      sender: pushSender,
      title: (sessionId) => journal.summary(sessionId)?.title,
      isPaired: (clientId) => devices.get(clientId) !== undefined,
      log: (event, fields) => logger.info(event, { ...fields }),
    });
    const core = new HostCore({
      journal,
      agents,
      host,
      store,
      log: logger.forModule('core'),
      onJournalEvent: (event) => notifier.handle(event),
    });
    const registry = core.register(
      new MethodRegistry().register('initialize', (_params, context) => ({
        protocolVersion: 1,
        host,
        device: { clientId: context.clientId, displayName: devices.get(context.clientId)?.displayName ?? '' },
        agents: agents.map(describeAgent),
        // The key exists from the first start; `subscribed` says whether this device has a stored subscription (spec 9).
        push: { vapidPublicKey: vapid.publicKey, subscribed: devices.push.isSubscribed(context.clientId) },
        limits: { maxMessageBytes: MAX_MESSAGE_BYTES, snapshotTurns: DEFAULT_SNAPSHOT_TURNS },
      })),
    );

    let server: HostServer | undefined;
    let control: ControlServer | undefined;
    // The provider relay (protocol-v1.md section 15): stateless, its notifications go to the asking stream.
    const relay = new ProviderRelay({ providers: config.providers ?? [] });
    registerProviderMethods(registry, {
      relay,
      notify: (streamId, method, params) => server?.streams.notifyStream(streamId, method, params) ?? false,
      log: (event, fields) => logger.info(event, fields),
    });
    try {
      server = await HostServer.start({
        registry,
        devices,
        pushSender,
        host: () => ({ hostId: host.hostId, name: host.name }),
        port: config.port,
        resolve: listenPlan(config, insecureDev, options.resolve ?? (() => resolveTailnet())),
        tls: insecureDev ? null : config.tls,
        insecureDev,
        ...(options.publicDir ? { publicDir: options.publicDir } : {}),
        stream: {
          presence,
          status: () => (agents.every((a) => a.state().status === 'ready') ? 'active' : 'degraded'),
          ...(options.pingTimeoutMs ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
        },
        log: logger.forModule('http'),
      });
      core.attach(server.streams);
      const listening = server;
      let service: HostService | undefined;
      control = await ControlServer.start({
        socketPath: controlSocketPath(options.configPath),
        secret: ensureControlSecret(controlSecretPath(options.configPath)),
        handlers: {
          status: () => service!.status(),
          pair: () => listening.issuePairingCode(),
          listDevices: () => devices.list(),
          revokeDevice: (clientId) => listening.revokeDevice(clientId),
          renameDevice: (clientId, displayName) => {
            const name = displayName.trim();
            if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
              throw new ControlRequestError(400, `the name must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters`);
            }
            return devices.rename(clientId, name);
          },
        },
        log: (event, fields) => logger.info(event, fields),
      });
      service = new HostService(server, core, journal, store, devices, control, notifier, relay, options, startedAt);
      logger.info('host.listening', {
        origin: server.origin,
        addresses: server.addresses.map((a) => a.address),
        port: server.port,
        agents: agents.map((a) => ({ id: a.id, status: a.state().status })),
      });
      return service;
    } catch (error) {
      await control?.close();
      await server?.close();
      await core.close();
      await notifier.close();
      journal.close();
      store.close();
      devices.close();
      throw error;
    }
  }

  status(): ControlStatus {
    const hostStatus = this.core.hostStatus();
    return {
      state: this.draining ? 'draining' : 'running',
      pid: process.pid,
      version: HOST_VERSION,
      hostId: this.options.config.hostId,
      origin: this.server.origin,
      addresses: this.server.addresses.map((a) => a.address),
      port: this.server.port,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      devices: this.devices.list().length,
      streams: this.server.streams.streams().length,
      sessionsActive: hostStatus.sessionsActive,
      agents: hostStatus.agents,
      providers: this.relay.names(),
    };
  }

  /** Graceful shutdown; safe to call more than once (later calls wait for the first). */
  shutdown(reason = 'shutdown'): Promise<void> {
    this.stopping ??= this.stop(reason);
    return this.stopping;
  }

  private async stop(reason: string): Promise<void> {
    const { logger } = this.options;
    const streams = this.server.streams.streams().length;
    logger.info('host.draining', { reason, streams });
    this.draining = true;
    this.server.streams.beginDrain();
    const drainMs = this.options.drainMs ?? DEFAULT_DRAIN_MS;
    if (drainMs > 0 && streams > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
    await this.server.close(); // every stream closes with 4010, then the listeners
    logger.info('host.streams_closed', { streams });
    await this.core.close();
    // Queued pushes read the subscriptions: let them finish before the device store closes.
    await this.notifier.close();
    await this.control.close();
    this.journal.close();
    this.store.close();
    this.devices.close();
    logger.info('host.stopped', { reason });
  }
}
