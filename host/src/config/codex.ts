// Host configuration for the Codex agent: which engine binary to run, where its home (login, sessions)
// lives, and the defaults a session gets when its settings do not say otherwise.
//
// The engine is Codex app-server, bundled with ChatGPT.app. Its home (login, threads) is ~/.config/codex,
// the XDG-style layout of this Mac, passed to the engine as CODEX_HOME. XDG_CONFIG_HOME is deliberately
// not consulted: on this Mac it points at a dotfiles checkout that holds no Codex home, and the engine
// exits when CODEX_HOME names a missing folder. The default model is deliberately absent:
// the adapter asks the engine (`model/list`) instead of trusting the user's config.toml, whose model the
// ChatGPT plan may reject (spikes/host-drive/NOTES.md).
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_BINARY =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/** Codex `SandboxMode`. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export const CODEX_SANDBOXES: readonly CodexSandbox[] = ['read-only', 'workspace-write', 'danger-full-access'];

/** Codex `AskForApproval` (the string forms). */
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export const CODEX_APPROVAL_POLICIES: readonly CodexApprovalPolicy[] = ['untrusted', 'on-failure', 'on-request', 'never'];

export interface CodexConfig {
  /** The program to run. */
  binary: string;
  /** Arguments before nothing else: `["app-server"]` for the real engine. */
  args: string[];
  /** The engine's home, exported as CODEX_HOME. */
  home: string;
  /** Extra environment for the engine process (added on top of the host's environment). */
  env: Record<string, string>;
  /** Sandbox of a session whose settings name none. */
  sandbox: CodexSandbox;
  /** Approval policy of a session whose settings name none (`approvalMode`): the host wants to see approvals. */
  approvalPolicy: CodexApprovalPolicy;
  /** How long one JSON-RPC call may take before the engine counts as unavailable. */
  requestTimeoutMs: number;
  /** How long `kill()` waits after SIGTERM before it sends SIGKILL to the process group. */
  killGraceMs: number;
  /** Sent as `initialize.clientInfo`. */
  clientInfo: { name: string; title: string; version: string };
}

/** CODEX_HOME when the host's environment sets an absolute one, else ~/.config/codex. */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME;
  return home !== undefined && path.isAbsolute(home) ? home : path.join(homedir(), '.config', 'codex');
}

/**
 * The Codex configuration: defaults, then the environment (`NANO_CODEX_BIN`, `NANO_CODEX_HOME` or
 * `CODEX_HOME`, `NANO_CODEX_SANDBOX`), then explicit overrides.
 */
export function codexConfig(overrides: Partial<CodexConfig> = {}, env: NodeJS.ProcessEnv = process.env): CodexConfig {
  const sandbox = env.NANO_CODEX_SANDBOX;
  return {
    binary: env.NANO_CODEX_BIN || DEFAULT_CODEX_BINARY,
    args: ['app-server'],
    home: env.NANO_CODEX_HOME || defaultCodexHome(env),
    env: {},
    sandbox: isSandbox(sandbox) ? sandbox : 'workspace-write',
    approvalPolicy: 'on-request',
    requestTimeoutMs: 120_000,
    killGraceMs: 2_000,
    clientInfo: { name: 'nano-remote-host', title: 'Nano Remote', version: '0.0.0' },
    ...overrides,
  };
}

export function isSandbox(value: unknown): value is CodexSandbox {
  return typeof value === 'string' && (CODEX_SANDBOXES as readonly string[]).includes(value);
}

export function isApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return typeof value === 'string' && (CODEX_APPROVAL_POLICIES as readonly string[]).includes(value);
}
