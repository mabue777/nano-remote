// Host configuration for the pi agent (Phase 5b, rulings R1 to R4): which pi program to run, Nano's
// approval extension, and the limits of one pi process.
//
// pi is installed per user at ~/.local/bin/pi, a shell script that execs the managed release under
// ~/.pi/agent; the release starts with `#!/usr/bin/env node`. launchd starts the host with a bare PATH that
// has no node, so the pi process gets the folder of the host's own node in front of its PATH (childPath).
// pi keeps its providers, keys and session files in ~/.pi/agent; the host never reads them.
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** pi's per-user install location. */
export function defaultPiBinary(home = homedir()): string {
  return path.join(home, '.local', 'bin', 'pi');
}

/**
 * Nano's approval extension (host/pi-extension/nano-approval.js). This module is host/src/config/pi.ts
 * in the source tree and host/dist/config/pi.js in the build: both are two folders below host/.
 */
export const NANO_APPROVAL_EXTENSION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'pi-extension',
  'nano-approval.js',
);

export interface PiConfig {
  /** The program to run. */
  binary: string;
  /** Arguments before pi's own (`[]` for the real pi; the fake engine's script path in tests). */
  args: string[];
  /** The extension pi loads with `-e` (the only one: pi runs with `--no-extensions`). */
  extensionPath: string;
  /** Extra environment for the pi process (added on top of the host's environment). */
  env: Record<string, string>;
  /** How long one RPC command may take before pi counts as unavailable. */
  requestTimeoutMs: number;
  /** How long `kill()` waits after SIGTERM before it sends SIGKILL to the process group. */
  killGraceMs: number;
  /** How long the model list stays cached (pi's providers change when the operator adds one). */
  modelsTtlMs: number;
}

/** The pi configuration: defaults, then the environment (`NANO_PI_BIN`), then explicit overrides. */
export function piConfig(overrides: Partial<PiConfig> = {}, env: NodeJS.ProcessEnv = process.env): PiConfig {
  return {
    binary: env.NANO_PI_BIN || defaultPiBinary(),
    args: [],
    extensionPath: NANO_APPROVAL_EXTENSION,
    env: {},
    requestTimeoutMs: 120_000,
    killGraceMs: 2_000,
    modelsTtlMs: 60_000,
    ...overrides,
  };
}

/** PATH for the pi process: the host's node first, so pi's `#!/usr/bin/env node` resolves under launchd. */
export function childPath(base: string | undefined, nodeBinary = process.execPath): string {
  const nodeDir = path.dirname(nodeBinary);
  const rest = (base ?? '/usr/bin:/bin').split(':').filter((dir) => dir !== '' && dir !== nodeDir);
  return [nodeDir, ...rest].join(':');
}
