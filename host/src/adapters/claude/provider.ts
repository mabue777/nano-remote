// The Claude Code agent as the host registers it: health (does the Claude Agent SDK resolve, does the
// Claude config folder exist), its models (asked from the engine, cached), and a ClaudeAdapter per session.
//
// Models: Query.supportedModels() on a short-lived query that never gets a user message, closed
// afterwards. Probed on the operator's Mac with SDK 0.3.308: the control request is answered before any
// user message (about 4 s, no tokens spent), so no user message is needed. Only when the engine cannot
// answer at all (not installed, not signed in, timed out) does the provider fall back to a static list
// (opus, sonnet, haiku; not cached, so the next call asks again). The SDK's `default` row is left out:
// sessions get the configured default model (mapping.ts toModels). Each model carries its
// supportedEffortLevels as `efforts` (no `defaultEffort`: the engine reports none); adapters fit a
// session's effort to them.
//
// Version: the SDK package version until a session's system/init reports the Claude Code version.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

import type { ModelInfo } from '../../generated/common.js';
import type { AgentCapabilities, AgentProvider, AgentState } from '../../core/adapter.js';
import { claudeConfig, type ClaudeConfig } from '../../config/claude.js';
import { ClaudeAdapter, executablePath, Inbox, loadQuery, type ClaudeQuery, type QueryFn } from './adapter.js';
import { CLAUDE_APPROVAL_MODES, childEnv, staticModels, toModels } from './mapping.js';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** The installed SDK's version; throws when the package does not resolve. */
export function resolveSdkVersion(): string {
  const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}

/** Claude Code cannot steer a running turn (the SDK has no such call), has turn diffs (the host's), honours four approval modes, takes images (image blocks) and files (a path line), reports its background tasks, and changes model and effort in an open session. */
export const CLAUDE_CAPABILITIES: AgentCapabilities = { steer: false, diff: true, approvalModes: CLAUDE_APPROVAL_MODES, attachments: { images: true, files: true }, backgroundTasks: true, settingsUpdate: ['model', 'effort'] };

export interface ClaudeAgentOptions {
  config?: ClaudeConfig;
  /** Replaces the SDK's `query()` (tests). */
  query?: QueryFn;
  /** Replaces the SDK lookup (tests): returns the SDK version or throws. */
  sdkVersion?: () => string;
  log?: (message: string) => void;
}

export class ClaudeAgent implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly config: ClaudeConfig;
  private readonly options: ClaudeAgentOptions;
  private sdk: { version: string } | { error: string } | undefined;
  private cliVersion: string | undefined;
  private cached: ModelInfo[] | undefined;
  private loading: Promise<ModelInfo[]> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(options: ClaudeAgentOptions = {}) {
    this.options = options;
    this.config = options.config ?? claudeConfig();
  }

  state(): AgentState {
    const sdk = this.sdkState();
    if ('error' in sdk) return { status: 'unavailable', reason: `the Claude Agent SDK does not load: ${sdk.error}` };
    if (!existsSync(this.config.configDir)) {
      return { status: 'unavailable', reason: `Claude Code has no config folder at ${this.config.configDir} (sign in with claude first)` };
    }
    return { status: 'ready', version: this.cliVersion ?? sdk.version };
  }

  /** The engine's models, from one short-lived query the first time, then from the cache. */
  models(): Promise<ModelInfo[]> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= this.listModels().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  createAdapter(): ClaudeAdapter {
    return new ClaudeAdapter({
      config: this.config,
      ...(this.options.query ? { query: this.options.query } : {}),
      onVersion: (version) => this.learnVersion(version),
      efforts: (model) => {
        const listed = this.cached?.find((m) => m.id === model);
        return listed === undefined ? undefined : (listed.efforts ?? []);
      },
      ...(this.options.log ? { log: this.options.log } : {}),
    });
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private sdkState(): { version: string } | { error: string } {
    if (!this.sdk) {
      try {
        this.sdk = { version: (this.options.sdkVersion ?? resolveSdkVersion)() };
      } catch (error) {
        this.sdk = { error: (error as Error).message };
      }
    }
    return this.sdk;
  }

  private async listModels(): Promise<ModelInfo[]> {
    const inbox = new Inbox();
    let query: ClaudeQuery | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const queryFn = this.options.query ?? (await loadQuery());
      query = queryFn({
        prompt: inbox,
        options: {
          cwd: homedir(),
          settingSources: [],
          permissionMode: 'default',
          env: childEnv(this.config),
          ...(executablePath(this.config) !== undefined ? { pathToClaudeCodeExecutable: executablePath(this.config) } : {}),
        },
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no model list within ${this.config.requestTimeoutMs} ms`)), this.config.requestTimeoutMs);
      });
      const models = toModels(await Promise.race([query.supportedModels(), timeout]), this.config.defaultModel);
      if (models.length === 0) throw new Error('the engine listed no models');
      this.cached = models;
      return models;
    } catch (error) {
      this.options.log?.(`claude: cannot list models (${(error as Error).message}); using the static list`);
      return staticModels(this.config.defaultModel);
    } finally {
      clearTimeout(timer);
      inbox.close();
      try {
        query?.close();
      } catch {
        // Already closed.
      }
    }
  }

  private learnVersion(version: string): void {
    if (version === this.cliVersion) return;
    this.cliVersion = version;
    for (const listener of [...this.listeners]) listener();
  }
}
