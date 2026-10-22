// The host's config file, `~/Library/Application Support/NanoHost/config.json`. Validated on every load;
// written with defaults on first start. The folder is created 0700 and the file is written 0600 (it
// names the TLS key and the Journal, and the folder holds the control secret).
//
//   {
//     "hostId": "host_…",                 // stable identity shown to paired devices
//     "listenAddresses": [],              // [] = this Mac's tailnet addresses from Tailscale
//     "port": 7420,
//     "tls": { "certPath": "…/tls-cert.pem", "keyPath": "…/tls-key.pem" },
//     "enabledAgents": ["codex"],
//     "codexBinary": "/Applications/ChatGPT.app/…/codex",
//     "claudeConfigDir": "/Users/me/.config/claude", // optional; Claude Code's login, default ~/.claude
//     "claudeExecutable": "/…/claude",  // optional; default the Claude Code build bundled with the SDK
//     "journalPath": "…/journal.sqlite",
//     "logFile": "~/Library/Logs/NanoHost/host.log",
//     "vapidContact": "mailto:me@example.org"  // optional; VAPID sub claim, default DEFAULT_VAPID_CONTACT
//   }
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import { DEFAULT_CODEX_BINARY } from '../config/codex.js';
import { ensurePrivateDir } from '../config/private-files.js';
import { DEFAULT_PORT, TLS_CERT_FILE, TLS_KEY_FILE } from '../http/server.js';
import { isValidVapidContact } from '../push/vapid-jwt.js';
import { configDir, logsDir } from './paths.js';

export const DEFAULT_HOST_PORT = DEFAULT_PORT;

/** Agents this host build can drive. */
export const KNOWN_AGENTS = ['codex', 'claude'] as const;
export type AgentId = (typeof KNOWN_AGENTS)[number];

export interface HostConfig {
  hostId: string;
  /** Literal IP addresses to listen on; empty means this Mac's tailnet addresses (from Tailscale). */
  listenAddresses: string[];
  port: number;
  tls: { certPath: string; keyPath: string };
  enabledAgents: AgentId[];
  codexBinary: string;
  /** Claude Code's config folder (its login); absent means defaultClaudeConfigDir() (~/.claude). */
  claudeConfigDir?: string;
  /** The Claude Code executable; absent means the build bundled with the Claude Agent SDK. */
  claudeExecutable?: string;
  journalPath: string;
  logFile: string;
  /** VAPID `sub` claim (`https:` or `mailto:` with a real domain); absent means DEFAULT_VAPID_CONTACT. */
  vapidContact?: string;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'ConfigError';
  }
}

export function newHostId(): string {
  return `host_${randomBytes(8).toString('hex')}`;
}

/** Defaults for a home folder: everything under Application Support and Logs, Codex from ChatGPT.app. */
export function defaultConfig(home?: string, hostId = newHostId()): HostConfig {
  const dir = configDir(home);
  return {
    hostId,
    listenAddresses: [],
    port: DEFAULT_HOST_PORT,
    tls: { certPath: path.join(dir, TLS_CERT_FILE), keyPath: path.join(dir, TLS_KEY_FILE) },
    enabledAgents: ['codex'],
    codexBinary: DEFAULT_CODEX_BINARY,
    journalPath: path.join(dir, 'journal.sqlite'),
    logFile: path.join(logsDir(home), 'host.log'),
  };
}

const KEYS: readonly (keyof HostConfig)[] = [
  'hostId',
  'listenAddresses',
  'port',
  'tls',
  'enabledAgents',
  'codexBinary',
  'claudeConfigDir',
  'claudeExecutable',
  'journalPath',
  'logFile',
  'vapidContact',
];

/**
 * Checks a parsed config. Missing keys take the default; unknown keys, wrong types, relative paths,
 * hostnames or wildcards in `listenAddresses`, ports outside 1..65535 and unknown agents are errors.
 */
export function validateConfig(value: unknown, file: string, defaults: HostConfig): HostConfig {
  const fail = (message: string): never => {
    throw new ConfigError(file, message);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be a JSON object');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key)) fail(`unknown key ${JSON.stringify(key)}`);
  }
  const absolute = (v: unknown, key: string): string => {
    if (typeof v !== 'string' || v.length === 0) return fail(`${key} must be a non-empty string`);
    if (!path.isAbsolute(v)) fail(`${key} must be an absolute path`);
    return v;
  };

  const hostId = raw.hostId ?? defaults.hostId;
  if (typeof hostId !== 'string' || !/^host_[A-Za-z0-9_-]{1,64}$/.test(hostId)) fail('hostId must look like host_<letters or digits>');

  const listenAddresses = raw.listenAddresses ?? defaults.listenAddresses;
  if (!Array.isArray(listenAddresses)) fail('listenAddresses must be an array of IP addresses');
  for (const [i, address] of (listenAddresses as unknown[]).entries()) {
    if (typeof address !== 'string' || isIP(address) === 0) fail(`listenAddresses[${i}] must be a literal IP address`);
    if (address === '0.0.0.0' || address === '::') fail(`listenAddresses[${i}] must not be a wildcard`);
  }

  const port = raw.port ?? defaults.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) fail('port must be an integer from 1 to 65535');

  const tlsRaw = raw.tls ?? defaults.tls;
  if (typeof tlsRaw !== 'object' || tlsRaw === null || Array.isArray(tlsRaw)) fail('tls must be an object {certPath, keyPath}');
  const tlsObj = tlsRaw as Record<string, unknown>;
  for (const key of Object.keys(tlsObj)) if (key !== 'certPath' && key !== 'keyPath') fail(`unknown key tls.${key}`);
  const tls = {
    certPath: absolute(tlsObj.certPath ?? defaults.tls.certPath, 'tls.certPath'),
    keyPath: absolute(tlsObj.keyPath ?? defaults.tls.keyPath, 'tls.keyPath'),
  };

  const enabledAgents = raw.enabledAgents ?? defaults.enabledAgents;
  if (!Array.isArray(enabledAgents)) fail('enabledAgents must be an array');
  for (const agent of enabledAgents as unknown[]) {
    if (typeof agent !== 'string' || !(KNOWN_AGENTS as readonly string[]).includes(agent)) {
      fail(`enabledAgents: unknown agent ${JSON.stringify(agent)} (known: ${KNOWN_AGENTS.join(', ')})`);
    }
  }

  const vapidContact = raw.vapidContact ?? defaults.vapidContact;
  if (vapidContact !== undefined && (typeof vapidContact !== 'string' || !isValidVapidContact(vapidContact))) {
    fail('vapidContact must be an https: URL or a mailto: address with a real domain (not localhost)');
  }

  const claudeConfigDir = raw.claudeConfigDir ?? defaults.claudeConfigDir;
  const claudeExecutable = raw.claudeExecutable ?? defaults.claudeExecutable;

  return {
    hostId: hostId as string,
    listenAddresses: [...(listenAddresses as string[])],
    port: port as number,
    tls,
    enabledAgents: [...new Set(enabledAgents as AgentId[])],
    codexBinary: absolute(raw.codexBinary ?? defaults.codexBinary, 'codexBinary'),
    ...(claudeConfigDir !== undefined ? { claudeConfigDir: absolute(claudeConfigDir, 'claudeConfigDir') } : {}),
    ...(claudeExecutable !== undefined ? { claudeExecutable: absolute(claudeExecutable, 'claudeExecutable') } : {}),
    journalPath: absolute(raw.journalPath ?? defaults.journalPath, 'journalPath'),
    logFile: absolute(raw.logFile ?? defaults.logFile, 'logFile'),
    ...(vapidContact !== undefined ? { vapidContact: vapidContact as string } : {}),
  };
}

/** Creates the folder 0700 (and tightens it if it already exists) and writes the file 0600. */
export function writeConfig(file: string, config: HostConfig): void {
  ensurePrivateDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export { ensurePrivateDir };

export interface LoadedConfig {
  config: HostConfig;
  /** True when the file did not exist and was written with defaults. */
  created: boolean;
}

/**
 * Loads and validates the config file. A missing file is written with defaults when `create` is set
 * (`start`), else the defaults are returned without touching the disk (read-only commands).
 */
export function loadConfig(file: string, options: { home?: string; create?: boolean } = {}): LoadedConfig {
  const defaults = defaultConfig(options.home);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(file, (error as Error).message);
    if (options.create) writeConfig(file, defaults);
    return { config: defaults, created: options.create ?? false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(file, `not valid JSON: ${(error as Error).message}`);
  }
  const config = validateConfig(parsed, file, defaults);
  // A config written by hand may lack hostId; persist the generated one so the identity stays stable.
  if (options.create && (parsed as Record<string, unknown>).hostId === undefined) writeConfig(file, config);
  return { config, created: false };
}
