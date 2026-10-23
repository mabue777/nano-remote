// One `pi --mode rpc` process and its JSONL connection (pi docs/rpc.md). Commands go to stdin as
// `{id, type, ...}` and are answered by a `response` record with the same id; session events and
// `extension_ui_request` records arrive on stdout in between. Records are split on LF only: Node's readline
// also splits on U+2028 and U+2029, which are valid inside JSON strings (pi docs/json.md, framing).
//
// The process runs in its own process group so `kill()` also ends the shells and tools it started. When it
// exits or closes its stdout on its own, every outstanding command rejects with `agent_unavailable` and
// `onExit` fires once, with pi's last stderr line in the reason (pi reports its startup failures there,
// for example "No session found matching ...").
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { childPath, type PiConfig } from '../../config/pi.js';
import { RpcError } from '../../stream/router.js';

type Json = Record<string, unknown>;

export interface PiEngineHandlers {
  /** A session event (`agent_start`, `message_update`, `tool_execution_end`, ...). */
  onEvent(event: Json): void;
  /** An `extension_ui_request` (a dialog that waits for `respondUi`, or a fire-and-forget notice). */
  onUiRequest(request: Json): void;
  /** The process is gone without `kill()`: it crashed, exited, or closed its stdout. */
  onExit(reason: string): void;
  log?(message: string): void;
}

interface Call {
  type: string;
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export function unavailable(reason: string): RpcError {
  return new RpcError('agent_unavailable', `agent pi is unavailable: ${reason}`, { agentId: 'pi', reason });
}

/** Splits a byte stream into LF-terminated records (a preceding CR is dropped). */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer | string, onLine: (line: string) => void): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }
}

export class PiEngine {
  private readonly config: PiConfig;
  private readonly handlers: PiEngineHandlers;
  private proc: ChildProcess | undefined;
  private readonly calls = new Map<string, Call>();
  private nextId = 1;
  private gone: string | undefined;
  private killing = false;
  private exited: Promise<void> = Promise.resolve();
  private lastStderr = '';

  constructor(config: PiConfig, handlers: PiEngineHandlers) {
    this.config = config;
    this.handlers = handlers;
  }

  get alive(): boolean {
    return this.proc !== undefined && this.gone === undefined;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Spawns `pi --mode rpc --no-extensions -e <extension> ...args` in `cwd`. pi has no handshake. */
  start(args: string[], cwd: string): void {
    const argv = [...this.config.args, '--mode', 'rpc', '--no-extensions', '-e', this.config.extensionPath, ...args];
    const proc = spawn(this.config.binary, argv, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: childPath(process.env.PATH), ...this.config.env },
      detached: true,
    });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once('exit', () => resolve()));
    proc.once('error', (error) => this.lost(`cannot run ${this.config.binary}: ${error.message}`));
    // Records and stderr lines still buffered are delivered first: the loss is reported on `close` (the
    // process exited and its pipes are drained), or shortly after the exit or the end of stdout when a
    // tool's child keeps a pipe open.
    let exitReason: string | undefined;
    const report = (): void => {
      const why = exitReason ?? 'pi closed its stdout';
      this.lost(this.lastStderr === '' ? why : `${why}: ${this.lastStderr}`);
    };
    proc.once('exit', (code, signal) => {
      exitReason = signal ? `pi killed by ${signal}` : `pi exited with code ${code}`;
      setTimeout(report, 500).unref();
    });
    proc.once('close', report);
    proc.stdout!.once('close', () => setTimeout(report, 500).unref());
    proc.stdin!.on('error', () => this.lost('pi closed its stdin'));
    const stdout = new LineSplitter();
    proc.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk, (line) => this.onLine(line)));
    const stderr = new LineSplitter();
    proc.stderr!.on('data', (chunk: Buffer) =>
      stderr.push(chunk, (line) => {
        if (line.trim() === '') return;
        this.lastStderr = line.trim().slice(0, 300);
        this.handlers.log?.(`pi stderr: ${this.lastStderr}`);
      }),
    );
  }

  /** Sends a command and resolves with its response `data` (undefined when it has none). */
  call(type: string, params: Json = {}): Promise<unknown> {
    if (this.gone !== undefined) return Promise.reject(unavailable(this.gone));
    const id = `nano-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(unavailable(`${type} timed out after ${this.config.requestTimeoutMs} ms`));
      }, this.config.requestTimeoutMs);
      this.calls.set(id, { type, resolve, reject, timer });
      this.send({ ...params, id, type });
    });
  }

  /** Answers a dialog (`extension_ui_response`): `{confirmed}`, `{value}` or `{cancelled: true}`. */
  respondUi(id: string, answer: Json): void {
    if (this.gone !== undefined) return;
    this.send({ type: 'extension_ui_response', id, ...answer });
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
      signalGroup(pid, 'SIGKILL');
    }
  }

  private send(record: Json): void {
    this.proc!.stdin!.write(`${JSON.stringify(record)}\n`);
  }

  private onLine(line: string): void {
    if (this.gone !== undefined || line.trim() === '') return;
    let record: Json;
    try {
      record = JSON.parse(line) as Json;
    } catch {
      // The line may be session content: its size goes to the log, never its text.
      this.handlers.log?.(`pi: unparsable line of ${line.length} characters dropped`);
      return;
    }
    if (record === null || typeof record !== 'object') return;
    // Record types only, never content (NANO_PI_TRACE=1, for live diagnosis).
    if (process.env.NANO_PI_TRACE === '1') this.handlers.log?.(`pi record ${String(record.type)}${record.method ? ` ${String(record.method)}` : ''}`);
    switch (record.type) {
      case 'response':
        return this.settle(record);
      case 'extension_ui_request':
        return this.handlers.onUiRequest(record);
      default:
        return this.handlers.onEvent(record);
    }
  }

  private settle(record: Json): void {
    const id = typeof record.id === 'string' ? record.id : undefined;
    const call = id === undefined ? undefined : this.calls.get(id);
    if (!call) {
      if (record.success === false) this.handlers.log?.(`pi: ${String(record.command)} failed: ${String(record.error)}`);
      return;
    }
    this.calls.delete(id!);
    clearTimeout(call.timer);
    if (record.success === false) call.reject(new Error(`${call.type} failed: ${String(record.error ?? 'unknown error')}`));
    else call.resolve(record.data);
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
