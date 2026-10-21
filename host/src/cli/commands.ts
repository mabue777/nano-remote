// What each nano-host command does. `runCli` is the testable core of the bin: argv, an environment of
// injectable effects, and an exit code. main.ts wires it to the real process.
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeviceRecord } from '../devices/store.js';
import { DEFAULT_TAILSCALE_CLI, resolveTailnet, tailscaleEnv, type TailnetSelf } from '../http/bind.js';
import type { IssuedCode } from '../pairing/codes.js';
import { parseArgs, USAGE, UsageError, type Command } from './args.js';
import { ensurePrivateDir, loadConfig } from './config.js';
import { controlRequest, HostNotRunning, type ControlStatus } from './control.js';
import * as launchd from './launchd.js';
import { createLogger } from './log.js';
import { controlSecretPath, controlSocketPath, defaultConfigPath, LAUNCHD_LABEL, launchAgentPath, logsDir } from './paths.js';
import { encodeQr, renderQr } from './qr.js';
import { HostService } from './service.js';
import { HOST_VERSION } from './version.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
/** `status` when the host is not running (like `launchctl print` for an unknown job). */
export const EXIT_NOT_RUNNING = 3;

export interface CliEnv {
  home: string;
  uid: number;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Where `start` writes its log lines besides the log file. Default process.stdout. */
  logStream: { write(text: string): unknown };
  /** Runs `launchctl` and `tailscale`. */
  run: launchd.Run;
  /** Tailscale lookup for `cert`. */
  tailnet: () => Promise<TailnetSelf>;
  /** Absolute node binary and bin script for the plist. */
  nodePath: string;
  binPath: string;
  /** `start` blocks until the returned promise resolves (the signal). Tests resolve it. */
  waitForStop: (service: HostService) => Promise<string>;
}

/** The built bin script: dist/cli/main.js next to this file once compiled. */
export function defaultBinPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');
}

/**
 * The node binary for the plist. Homebrew's process.execPath is the versioned Cellar path, which
 * disappears on `brew upgrade node`; the stable /opt/homebrew/bin/node link is used when it is the same
 * binary.
 */
export function stableNodePath(execPath = process.execPath, candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node']): string {
  for (const candidate of candidates) {
    try {
      if (realpathSync(candidate) === realpathSync(execPath)) return candidate;
    } catch {
      // not installed there
    }
  }
  return execPath;
}

export function defaultEnv(): CliEnv {
  return {
    home: homedir(),
    uid: process.getuid?.() ?? 501,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    logStream: process.stdout,
    run: launchd.run,
    tailnet: () => resolveTailnet(),
    nodePath: stableNodePath(),
    binPath: defaultBinPath(),
    waitForStop: () =>
      new Promise((resolve) => {
        process.once('SIGTERM', () => resolve('SIGTERM'));
        process.once('SIGINT', () => resolve('SIGINT'));
      }),
  };
}

function configPathOf(command: { config?: string }, env: CliEnv): string {
  return command.config ? path.resolve(command.config) : defaultConfigPath(env.home);
}

function control(configPath: string) {
  return { socketPath: controlSocketPath(configPath), secretPath: controlSecretPath(configPath) };
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** The `devices list` table. */
export function formatDevices(devices: DeviceRecord[]): string {
  if (devices.length === 0) return 'no paired devices; pair one with `nano-host pair`';
  const rows = [
    ['CLIENT ID', 'NAME', 'PLATFORM', 'PAIRED', 'LAST SEEN'],
    ...devices.map((d) => [d.clientId, d.displayName, d.platform, formatTime(d.createdAt), formatTime(d.lastSeenAt)]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

export function formatStatus(status: ControlStatus): string {
  const agents = status.agents.map((a) => `${a.id} ${a.status}${a.version ? ` ${a.version}` : ''}${a.reason ? ` (${a.reason})` : ''}`);
  return [
    `state:     ${status.state} (pid ${status.pid}, version ${status.version}, up ${status.uptimeSeconds}s)`,
    `origin:    ${status.origin}`,
    `listening: ${status.addresses.join(', ')} port ${status.port}`,
    `devices:   ${status.devices} paired, ${status.streams} streams open`,
    `sessions:  ${status.sessionsActive} active`,
    `agents:    ${agents.join('; ') || 'none'}`,
  ].join('\n');
}

export function formatPairing(issued: IssuedCode): string {
  const minutes = Math.max(1, Math.round((issued.expiresAt - Date.now()) / 60_000));
  return [
    renderQr(encodeQr(issued.url)),
    '',
    'Scan the code with the phone camera, or open the URL and enter the code.',
    `code: ${issued.code}`,
    `url:  ${issued.url}`,
    `The code works once and expires in ${minutes} minutes.`,
  ].join('\n');
}

async function start(command: Extract<Command, { name: 'start' }>, env: CliEnv): Promise<number> {
  const configPath = configPathOf(command, env);
  const { config, created } = loadConfig(configPath, { home: env.home, create: true });
  const logger = createLogger({ file: config.logFile, stdout: env.logStream });
  if (created) logger.info('config.created', { configPath });
  let service: HostService;
  try {
    service = await HostService.start({ config, configPath, logger, insecureDev: command.insecureDev });
  } catch (error) {
    logger.error('host.start_failed', { error });
    return EXIT_FAILURE;
  }
  const signal = await env.waitForStop(service);
  await service.shutdown(signal);
  return EXIT_OK;
}

async function cert(command: Extract<Command, { name: 'cert' }>, env: CliEnv): Promise<number> {
  const configPath = configPathOf(command, env);
  const { config } = loadConfig(configPath, { home: env.home, create: true });
  const self = await env.tailnet();
  ensurePrivateDir(path.dirname(config.tls.certPath));
  ensurePrivateDir(path.dirname(config.tls.keyPath));
  const args = ['cert', '--cert-file', config.tls.certPath, '--key-file', config.tls.keyPath, self.dnsName];
  env.out(`running: tailscale ${args.join(' ')}`);
  const result = await env.run(DEFAULT_TAILSCALE_CLI, args, { env: tailscaleEnv() });
  if (result.code !== 0) {
    env.err(`tailscale cert failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
    env.err('HTTPS certificates must be enabled for the tailnet: https://login.tailscale.com/admin/dns');
    return EXIT_FAILURE;
  }
  for (const file of [config.tls.certPath, config.tls.keyPath]) if (existsSync(file)) chmodSync(file, 0o600);
  env.out(`certificate for ${self.dnsName} written to ${config.tls.certPath} (key ${config.tls.keyPath})`);
  env.out('restart the host to use it: launchctl kickstart -k gui/$(id -u)/' + LAUNCHD_LABEL);
  return EXIT_OK;
}

async function install(command: Extract<Command, { name: 'install' }>, env: CliEnv): Promise<number> {
  const configPath = configPathOf(command, env);
  // Validate (and on first install, write) the config now, so a broken file fails here, not in a crash loop.
  const { config } = loadConfig(configPath, { home: env.home, create: true });
  const logs = logsDir(env.home);
  const plistPath = launchAgentPath(env.home);
  const programArguments = [env.nodePath, env.binPath, 'start'];
  if (configPath !== defaultConfigPath(env.home)) programArguments.push('--config', configPath);
  await launchd.install({
    plistPath,
    uid: env.uid,
    run: env.run,
    plist: {
      programArguments,
      stdoutPath: path.join(logs, 'stdout.log'),
      stderrPath: path.join(logs, 'stderr.log'),
      workingDirectory: path.dirname(configPath),
    },
  });
  env.out(`installed ${plistPath} and loaded it into gui/${env.uid}`);
  env.out(`log: ${config.logFile}`);
  env.out('check it with: nano-host status');
  return EXIT_OK;
}

async function run(command: Command, env: CliEnv): Promise<number> {
  switch (command.name) {
    case 'help':
      env.out(USAGE);
      return EXIT_OK;
    case 'version':
      env.out(HOST_VERSION);
      return EXIT_OK;
    case 'start':
      return start(command, env);
    case 'status': {
      const configPath = configPathOf(command, env);
      const installed = existsSync(launchAgentPath(env.home));
      try {
        const status = await controlRequest<ControlStatus>(control(configPath), 'GET', '/v1/status');
        env.out(formatStatus(status));
        env.out(`launchd:   ${installed ? `installed (${LAUNCHD_LABEL})` : 'not installed'}`);
        return EXIT_OK;
      } catch (error) {
        if (!(error instanceof HostNotRunning)) throw error;
        env.out(`not running${installed ? ` (launchd job ${LAUNCHD_LABEL} is installed; see ${logsDir(env.home)})` : ''}`);
        return EXIT_NOT_RUNNING;
      }
    }
    case 'pair': {
      const issued = await controlRequest<IssuedCode>(control(configPathOf(command, env)), 'POST', '/v1/pair');
      env.out(formatPairing(issued));
      return EXIT_OK;
    }
    case 'devices': {
      const target = control(configPathOf(command, env));
      if (command.action === 'list') {
        const { devices } = await controlRequest<{ devices: DeviceRecord[] }>(target, 'GET', '/v1/devices');
        env.out(formatDevices(devices));
      } else if (command.action === 'revoke') {
        await controlRequest(target, 'POST', '/v1/devices/revoke', { clientId: command.clientId });
        env.out(`revoked ${command.clientId}; its streams are closed and its token no longer works`);
      } else {
        await controlRequest(target, 'POST', '/v1/devices/rename', { clientId: command.clientId, displayName: command.displayName });
        env.out(`renamed ${command.clientId} to ${JSON.stringify(command.displayName.trim())}`);
      }
      return EXIT_OK;
    }
    case 'cert':
      return cert(command, env);
    case 'install':
      return install(command, env);
    case 'uninstall': {
      const plistPath = launchAgentPath(env.home);
      const removed = await launchd.uninstall({ plistPath, uid: env.uid, run: env.run });
      env.out(removed ? `unloaded ${LAUNCHD_LABEL} and removed ${plistPath}` : 'not installed; nothing to do');
      return EXIT_OK;
    }
  }
}

/** Parses argv, runs the command, and turns known failures into a message and an exit code. */
export async function runCli(argv: readonly string[], env: CliEnv = defaultEnv()): Promise<number> {
  let command: Command;
  try {
    command = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    env.err(`nano-host: ${error.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    return await run(command, env);
  } catch (error) {
    if (error instanceof Error) {
      env.err(`nano-host: ${error.message}`);
      return error instanceof HostNotRunning ? EXIT_NOT_RUNNING : EXIT_FAILURE;
    }
    throw error;
  }
}
