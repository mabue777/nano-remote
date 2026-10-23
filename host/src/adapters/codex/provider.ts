// The Codex agent as the host registers it: health (is the engine binary there), its models (asked from
// the engine with `model/list`, cached), and a CodexAdapter per session.
import { accessSync, constants } from 'node:fs';

import type { ModelInfo } from '../../generated/common.js';
import type { AgentCapabilities, AgentProvider, AgentState } from '../../core/adapter.js';
import { CODEX_APPROVAL_POLICIES, codexConfig, type CodexConfig } from '../../config/codex.js';
import { CodexAdapter } from './adapter.js';
import { Engine } from './engine.js';
import { defaultModel, toModels, versionFrom } from './mapping.js';

/** Codex steers a running turn (`turn/steer`), has turn diffs (the host's), honours its four approval policies, and takes images (localImage) and files (a path line). */
export const CODEX_CAPABILITIES: AgentCapabilities = { steer: true, diff: true, approvalModes: CODEX_APPROVAL_POLICIES, attachments: { images: true, files: true } };

export interface CodexAgentOptions {
  config?: CodexConfig;
  log?: (message: string) => void;
}

export class CodexAgent implements AgentProvider {
  readonly id = 'codex';
  readonly name = 'Codex';
  readonly capabilities = CODEX_CAPABILITIES;
  readonly config: CodexConfig;
  private readonly log: ((message: string) => void) | undefined;
  private version: string | undefined;
  private cached: ModelInfo[] | undefined;
  private loading: Promise<ModelInfo[]> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(options: CodexAgentOptions = {}) {
    this.config = options.config ?? codexConfig();
    this.log = options.log;
  }

  state(): AgentState {
    try {
      accessSync(this.config.binary, constants.X_OK);
    } catch {
      return { status: 'unavailable', reason: `Codex is not installed at ${this.config.binary}` };
    }
    return this.version === undefined ? { status: 'ready' } : { status: 'ready', version: this.version };
  }

  /** The engine's models, from one short-lived engine the first time, then from the cache. */
  models(): Promise<ModelInfo[]> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= this.listModels().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  createAdapter(): CodexAdapter {
    return new CodexAdapter({
      config: this.config,
      defaultModel: () => (this.cached ? defaultModel(this.cached) : undefined),
      onEngine: (userAgent) => this.learnVersion(userAgent),
      log: this.log,
    });
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async listModels(): Promise<ModelInfo[]> {
    // A one-off engine: its notifications and requests are not for anyone, its death rejects the call.
    const ignore = (): void => {};
    const engine = new Engine(this.config, { onNotification: ignore, onRequest: ignore, onExit: ignore, log: this.log });
    try {
      this.learnVersion((await engine.start()).userAgent);
      const models: ModelInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = (await engine.call('model/list', cursor === undefined ? {} : { cursor })) as {
          data?: unknown;
          nextCursor?: unknown;
        };
        models.push(...toModels(page.data));
        cursor = typeof page.nextCursor === 'string' && page.nextCursor !== '' ? page.nextCursor : undefined;
      } while (cursor !== undefined);
      this.cached = models;
      return models;
    } finally {
      await engine.kill();
    }
  }

  private learnVersion(userAgent: string): void {
    const version = versionFrom(userAgent);
    if (version === undefined || version === this.version) return;
    this.version = version;
    for (const listener of [...this.listeners]) listener();
  }
}
