// The pi agent as the host registers it (Phase 5b ruling R1): health (is the pi program there), its version
// (`pi --version`, asked once in the background), its models, and a PiAdapter per session.
//
// Models (ruling R4): pi's `get_available_models` lists only the providers it holds credentials for. They
// are asked from a short-lived `pi --mode rpc --no-session` (no session file is written) together with
// `get_state`, whose model is pi's own default. The list is cached briefly: the operator adds providers to
// pi, not to Nano, and the New session sheet should see them without a host restart.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';

import type { ModelInfo } from '../../generated/common.js';
import type { AgentProvider, AgentState } from '../../core/adapter.js';
import { childPath, piConfig, type PiConfig } from '../../config/pi.js';
import { PiAdapter } from './adapter.js';
import { PiEngine } from './engine.js';
import { obj, toModels, versionFrom } from './mapping.js';

export interface PiAgentOptions {
  config?: PiConfig;
  log?: (message: string) => void;
  /** Clock for the model cache (tests). */
  now?: () => number;
}

/** True when the pi program exists and may be run. */
export function piInstalled(config: PiConfig): boolean {
  try {
    accessSync(config.binary, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class PiAgent implements AgentProvider {
  readonly id = 'pi';
  readonly name = 'Pi';
  readonly config: PiConfig;
  private readonly log: ((message: string) => void) | undefined;
  private readonly now: () => number;
  private version: string | undefined;
  private versionAsked = false;
  private cached: { models: ModelInfo[]; at: number } | undefined;
  private loading: Promise<ModelInfo[]> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(options: PiAgentOptions = {}) {
    this.config = options.config ?? piConfig();
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  state(): AgentState {
    if (!piInstalled(this.config)) return { status: 'unavailable', reason: `pi is not installed at ${this.config.binary}` };
    this.askVersion();
    return this.version === undefined ? { status: 'ready' } : { status: 'ready', version: this.version };
  }

  models(): Promise<ModelInfo[]> {
    if (this.cached && this.now() - this.cached.at < this.config.modelsTtlMs) return Promise.resolve(this.cached.models);
    this.loading ??= this.listModels().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  createAdapter(): PiAdapter {
    return new PiAdapter({ config: this.config, ...(this.log ? { log: this.log } : {}) });
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `pi --version` once, in the background; a learned version is announced to the listeners. */
  private askVersion(): void {
    if (this.versionAsked) return;
    this.versionAsked = true;
    execFile(
      this.config.binary,
      [...this.config.args, '--version'],
      { env: { ...process.env, PATH: childPath(process.env.PATH), ...this.config.env }, timeout: this.config.requestTimeoutMs },
      (error, stdout) => {
        const version = error ? undefined : versionFrom(String(stdout));
        if (version === undefined) {
          this.log?.(`pi: no version from --version${error ? ` (${error.message})` : ''}`);
          return;
        }
        this.version = version;
        for (const listener of [...this.listeners]) listener();
      },
    );
  }

  private async listModels(): Promise<ModelInfo[]> {
    // A one-off pi: its events and dialogs are not for anyone, its death rejects the calls.
    const ignore = (): void => {};
    const engine = new PiEngine(this.config, { onEvent: ignore, onUiRequest: ignore, onExit: ignore, log: this.log });
    try {
      engine.start(['--no-session'], homedir());
      const [available, state] = await Promise.all([engine.call('get_available_models'), engine.call('get_state')]);
      const models = toModels(obj(available).models, obj(state).model);
      this.cached = { models, at: this.now() };
      return models;
    } finally {
      await engine.kill();
    }
  }
}
