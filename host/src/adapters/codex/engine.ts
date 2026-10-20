// One Codex app-server process and its JSON-RPC connection: newline-delimited JSON over stdio (the
// engine's `JSONRPCMessage`, without the "jsonrpc" field). The process runs in its own process group so
// `kill()` also ends the shells and tools it started. When the process exits or its stdout closes on its
// own, every outstanding call rejects with `agent_unavailable` and `onExit` fires once.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { CodexConfig } from '../../config/codex.js';
import { RpcError } from '../../stream/router.js';

export type RpcId = number | string;

export interface EngineHandlers {
  onNotification(method: string, params: Record<string, unknown>): void;
  onRequest(id: RpcId, method: string, params: Record<string, unknown>): void;
  /** The process is gone without `kill()`: it crashed, exited, or closed its stdout. */
  onExit(reason: string): void;
  log?(message: string): void;
}

interface Call {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** The `initialize` response fields the host uses. */
export interface EngineInfo {
  userAgent: string;
  codexHome?: string;
}

export function unavailable(reason: string): RpcError {
  return new RpcError('agent_unavailable', `agent codex is unavailable: ${reason}`, { agentId: 'codex', reason });
}

export class Engine {
  info: EngineInfo = { userAgent: '' };
  private readonly config: CodexConfig;
  private readonly handlers: EngineHandlers;
  private proc: ChildProcess | undefined;
  private readonly calls = new Map<RpcId, Call>();
  private nextId = 1;
  private gone: string | undefined;
  private killing = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(config: CodexConfig, handlers: EngineHandlers) {
    this.config = config;
    this.handlers = handlers;
  }

  get alive(): boolean {
    return this.proc !== undefined && this.gone === undefined;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Spawns the engine and runs the `initialize` / `initialized` handshake. */
  async start(): Promise<EngineInfo> {
    const proc = spawn(this.config.binary, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: this.config.home, ...this.config.env },
      detached: true,
    });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once('close', () => resolve()));
    proc.once('error', (error) => this.lost(`cannot run ${this.config.binary}: ${error.message}`));
    // Lines still buffered in stdout are delivered first: the loss is reported when stdout closes, or
    // shortly after the exit if something else keeps stdout open.
    // With both events seen the loss is reported at once, with the exit code or signal; with one of them
    // it is reported after a short wait.
    let exitReason: string | undefined;
    let stdoutClosed = false;
    const settle = (): void => {
      if (stdoutClosed && exitReason !== undefined) this.lost(exitReason);
      else setTimeout(() => this.lost(exitReason ?? 'engine closed its stdout'), 250).unref();
    };
    proc.once('exit', (code, signal) => {
      exitReason = signal ? `engine killed by ${signal}` : `engine exited with code ${code}`;
      settle();
    });
    proc.stdout!.once('close', () => {
      stdoutClosed = true;
      settle();
    });
    proc.stdin!.on('error', () => this.lost('engine closed its stdin'));
    proc.stderr!.on('data', (chunk: Buffer) => this.handlers.log?.(`codex stderr: ${String(chunk).trimEnd()}`));
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));

    const result = (await this.call('initialize', {
      clientInfo: this.config.clientInfo,
      capabilities: { experimentalApi: true },
    })) as Partial<EngineInfo>;
    this.notify('initialized');
    this.info = { userAgent: typeof result?.userAgent === 'string' ? result.userAgent : '' };
    if (typeof result?.codexHome === 'string') this.info.codexHome = result.codexHome;
    return this.info;
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.gone !== undefined) return Promise.reject(unavailable(this.gone));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(unavailable(`${method} timed out after ${this.config.requestTimeoutMs} ms`));
      }, this.config.requestTimeoutMs);
      this.calls.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  /** A notification without params (the engine's client notifications are `initialized` only). */
  notify(method: string): void {
    this.send({ method });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  /** Ends the process group: SIGTERM, then SIGKILL after the grace period. Resolves when it is gone. */
  async kill(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.killing = true;
    this.lost('killed by the host');
    if (proc.exitCode === null && proc.signalCode === null && proc.pid !== undefined) {
      const pid = proc.pid;
      signalGroup(pid, 'SIGTERM');
      const force = setTimeout(() => signalGroup(pid, 'SIGKILL'), this.config.killGraceMs);
      await this.exited;
      clearTimeout(force);
      // Children that ignored SIGTERM die with their group.
      signalGroup(pid, 'SIGKILL');
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.gone !== undefined) throw unavailable(this.gone);
    this.proc!.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    // A gone engine reports nothing more: its loss was already reported.
    if (this.gone !== undefined || line.trim() === '') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.handlers.log?.(`codex: unparsable line: ${line.slice(0, 200)}`);
      return;
    }
    if (message === null || typeof message !== 'object') return;
    const id = message.id as RpcId | undefined;
    const method = message.method;
    if (typeof method !== 'string') {
      if (id !== undefined) this.settle(id, message);
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (id !== undefined) this.handlers.onRequest(id, method, params);
    else this.handlers.onNotification(method, params);
  }

  private settle(id: RpcId, message: Record<string, unknown>): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    clearTimeout(call.timer);
    const error = message.error as { code?: number; message?: string } | undefined;
    if (error) call.reject(new Error(`${call.method} failed: ${error.message ?? JSON.stringify(error)}`));
    else call.resolve(message.result);
  }

  /** The first reason the connection ended wins; calls reject and `onExit` fires unless the host killed it. */
  private lost(reason: string): void {
    if (this.gone !== undefined) return;
    this.gone = reason;
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(unavailable(reason));
    }
    this.calls.clear();
    if (!this.killing) {
      // stdout closed but the process may still run: make sure it does not linger.
      const pid = this.proc?.pid;
      if (pid !== undefined) signalGroup(pid, 'SIGKILL');
      this.handlers.onExit(reason);
    }
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}
