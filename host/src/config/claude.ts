// Host configuration for the Claude Code agent: where the child's Claude config folder (login, sessions)
// lives, which executable runs, and the defaults a session gets when its settings do not say otherwise.
//
// The engine is the Claude Code executable the Claude Agent SDK ships (a platform optional dependency of
// @anthropic-ai/claude-agent-sdk); `executable` overrides it. The login on the operator's Mac lives in the
// folder their shell exports as CLAUDE_CONFIG_DIR, but launchd starts the host with a bare environment
// (PATH only), so the folder is part of the host config and always handed to the child explicitly.
import { homedir } from 'node:os';
import path from 'node:path';

export interface ClaudeConfig {
  /** The child's Claude config folder (login, settings, session transcripts), exported as CLAUDE_CONFIG_DIR. */
  configDir: string;
  /** `pathToClaudeCodeExecutable`; undefined runs the executable bundled with the SDK. */
  executable: string | undefined;
  /** Model of a session whose settings name none (an alias such as "opus"). */
  defaultModel: string;
  /** Extra environment for the child (added on top of the cleaned host environment). */
  env: Record<string, string>;
  /**
   * How long the engine may take to accept a call (the first turn's system/init, a model list, Stop), and
   * how long it may stay silent after a user message before the adapter takes it for hung.
   */
  requestTimeoutMs: number;
  /** How long `kill()` waits after SIGTERM before it sends SIGKILL to the process group. */
  killGraceMs: number;
  /**
   * The host's attachments folder (spec 8.1), given to the SDK as an additional directory so that reading
   * an attached file outside the session folder asks for no approval. Undefined: none.
   */
  attachmentsDir?: string;
}

/** NANO_CLAUDE_CONFIG_DIR or CLAUDE_CONFIG_DIR when absolute, else ~/.claude (Claude Code's own default). */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  for (const value of [env.NANO_CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR]) {
    if (value !== undefined && path.isAbsolute(value)) return value;
  }
  return path.join(homedir(), '.claude');
}

/**
 * The Claude configuration: defaults, then the environment (`NANO_CLAUDE_CONFIG_DIR` or
 * `CLAUDE_CONFIG_DIR`, `NANO_CLAUDE_BIN`), then explicit overrides.
 */
export function claudeConfig(overrides: Partial<ClaudeConfig> = {}, env: NodeJS.ProcessEnv = process.env): ClaudeConfig {
  return {
    configDir: defaultClaudeConfigDir(env),
    executable: env.NANO_CLAUDE_BIN || undefined,
    defaultModel: 'opus',
    env: {},
    requestTimeoutMs: 120_000,
    killGraceMs: 2_000,
    ...overrides,
  };
}
