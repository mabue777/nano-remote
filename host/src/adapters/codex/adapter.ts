// The Codex adapter: drives one Codex thread through `codex app-server` (protocol-v1.md section 11).
//
//   session/start  -> thread/start {cwd, approvalPolicy, sandbox, model}   (settings.approvalMode, settings.sandbox)
//   resume         -> thread/resume {threadId, ..., initialTurnsPage {limit 5, itemsView "full"}}
//   turn/start     -> turn/start {threadId, input, clientUserMessageId}
//   turn/steer     -> turn/steer {threadId, expectedTurnId, input, clientUserMessageId}
//   turn/interrupt -> turn/interrupt {threadId, turnId}
//   approvals      <- item/{commandExecution,fileChange,permissions}/requestApproval (engine decisions forwarded)
//   questions      <- item/tool/requestUserInput
//   items, deltas, thread/status/changed, thread/tokenUsage/updated, turn/completed -> adapter events
//
// Supervision: when the engine dies on its own the adapter emits `status/changed {error}` and
// `agent/exited`; calls in flight reject with `agent_unavailable`. The next call starts a new engine and
// resumes the thread. `kill()` ends the engine's process group and silences the adapter for good.
import type { Decision, FileChange, InputPart, Settings } from '../../generated/common.js';
import type {
  Adapter,
  AdapterApprovalRequest,
  AdapterEvent,
  AdapterListener,
} from '../../core/adapter.js';
import { newId } from '../../core/ids.js';
import {
  codexConfig,
  isApprovalPolicy,
  isSandbox,
  type CodexApprovalPolicy,
  type CodexConfig,
  type CodexSandbox,
} from '../../config/codex.js';
import { RpcError } from '../../errors.js';
import { Engine, unavailable, type RpcId } from './engine.js';
import {
  APPROVAL_METHODS,
  DELTA_METHODS,
  INPUT_METHOD,
  approvalResponse,
  decisionsFrom,
  defaultModel,
  inputResponse,
  toFileChanges,
  toFinalStatus,
  toItem,
  toModels,
  toSessionStatus,
  toTurnError,
  toUsage,
  toUserInput,
  type ApprovalMethod,
} from './mapping.js';

type Json = Record<string, unknown>;

/** How many turns `thread/resume` returns with the thread (the Codex desktop's own page size). */
export const RESUME_TURNS = 5;

export interface CodexAdapterOptions {
  config?: CodexConfig;
  /** The model for sessions whose settings name none. Asked for lazily; undefined falls back to `model/list`. */
  defaultModel?: () => string | undefined;
  /** Called with the engine's `initialize` userAgent every time an engine starts. */
  onEngine?: (userAgent: string) => void;
  log?: (message: string) => void;
}

interface PendingRequest {
  rpcId: RpcId;
  method: ApprovalMethod | typeof INPUT_METHOD;
  params: Json;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The approval policy and sandbox a session runs with. `settings.approvalMode` names a Codex approval
 * policy; anything else falls back to the config. `never` without an explicit `settings.sandbox` means
 * full access (Codex `--yolo`): under workspace-write an out-of-folder command would fail instead of asking.
 */
export function sessionPolicy(settings: Settings, config: CodexConfig): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandbox } {
  const approvalPolicy = isApprovalPolicy(settings.approvalMode) ? settings.approvalMode : config.approvalPolicy;
  const sandbox = isSandbox(settings.sandbox)
    ? settings.sandbox
    : settings.approvalMode === 'never'
      ? 'danger-full-access'
      : config.sandbox;
  return { approvalPolicy, sandbox };
}

export class CodexAdapter implements Adapter {
  private readonly config: CodexConfig;
  private readonly options: CodexAdapterOptions;
  private readonly listeners = new Set<AdapterListener>();
  private engine: Engine | undefined;
  private booting: Promise<Engine> | undefined;
  private killed = false;
  private threadId = '';
  private cwd = '';
  private settings: Settings = {};
  private model: string | undefined;
  /** The engine's id of the running turn, once known; `running` is true from `turnStart` to its end. */
  private turnId: string | undefined;
  private running = false;
  private turnStarting: Promise<unknown> | undefined;
  private readonly requests = new Map<string, PendingRequest>();
  /** Items of the running turn by id, for approvals that refer to them (file changes, command cwd). */
  private readonly items = new Map<string, Json>();

  constructor(options: CodexAdapterOptions = {}) {
    this.options = options;
    this.config = options.config ?? codexConfig();
  }

  /** The engine's process id while one runs (tests and diagnostics). */
  get pid(): number | undefined {
    return this.engine?.alive ? this.engine.pid : undefined;
  }

  get engineSessionId(): string {
    return this.threadId;
  }

  onEvent(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(cwd: string, settings: Settings): Promise<string> {
    this.remember(cwd, settings);
    const engine = await this.connect();
    const result = (await engine.call('thread/start', { cwd, ...(await this.policy(engine)) })) as Json;
    this.threadId = str((result.thread as Json | undefined)?.id);
    if (this.threadId === '') throw unavailable('thread/start returned no thread id');
    return this.threadId;
  }

  async resume(engineSessionId: string, cwd: string, settings: Settings): Promise<void> {
    this.remember(cwd, settings);
    this.threadId = engineSessionId;
    await this.connect();
  }

  async turnStart(input: InputPart[], clientMessageId: string): Promise<void> {
    const engine = await this.ready();
    this.running = true;
    this.turnId = undefined;
    this.items.clear();
    const call = engine.call('turn/start', {
      threadId: this.threadId,
      input: toUserInput(input),
      clientUserMessageId: clientMessageId,
    });
    this.turnStarting = call;
    try {
      const result = (await call) as { turn?: { id?: unknown } };
      this.turnId = str(result?.turn?.id) || undefined;
    } catch (error) {
      this.running = false;
      throw error;
    } finally {
      this.turnStarting = undefined;
    }
  }

  async steer(input: InputPart[], clientMessageId: string): Promise<void> {
    const engine = await this.ready();
    await this.turnStarting?.catch(() => {});
    if (!this.running || this.turnId === undefined) {
      throw new RpcError('turn_mismatch', 'no Codex turn is running to steer', { turnId: null });
    }
    await engine.call('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: toUserInput(input),
      clientUserMessageId: clientMessageId,
    });
  }

  async interrupt(): Promise<void> {
    await this.turnStarting?.catch(() => {});
    if (!this.running || this.turnId === undefined) return;
    const engine = this.engine;
    if (!engine?.alive) throw unavailable('the engine is not running');
    await engine.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  async resolveApproval(requestId: string, decision: Decision): Promise<void> {
    const request = this.take(requestId);
    if (!request || request.method === INPUT_METHOD) return;
    this.engine!.respond(request.rpcId, approvalResponse(request.method, decision, request.params));
    // A permission grant has no "cancel"; the protocol's cancel interrupts the turn.
    if (decision === 'cancel' && request.method === 'item/permissions/requestApproval') await this.interrupt();
  }

  async answerInput(requestId: string, answers: Record<string, string[]>): Promise<void> {
    const request = this.take(requestId);
    if (!request || request.method !== INPUT_METHOD) return;
    this.engine!.respond(request.rpcId, inputResponse(answers));
  }

  async diff(): Promise<FileChange[]> {
    throw new RpcError('not_supported', 'the Codex adapter does not compute turn diffs', { agentId: 'codex' });
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.listeners.clear();
    const engine = this.engine;
    this.engine = undefined;
    await engine?.kill();
  }

  // ---- engine lifecycle ------------------------------------------------------------------------

  private remember(cwd: string, settings: Settings): void {
    this.cwd = cwd;
    this.settings = settings;
  }

  /** The running engine; a dead one is replaced and the thread resumed ("restart on the next call"). */
  private async ready(): Promise<Engine> {
    // A booting engine is alive before its handshake and thread/resume are done: wait for the boot.
    if (this.booting) return this.booting;
    if (this.engine?.alive) return this.engine;
    if (this.threadId === '') throw unavailable('no Codex thread is attached');
    return this.connect();
  }

  /** Starts an engine (shared by concurrent callers) and, with a known thread, resumes it. */
  private connect(): Promise<Engine> {
    if (this.killed) return Promise.reject(unavailable('the adapter was killed'));
    this.booting ??= this.boot().finally(() => {
      this.booting = undefined;
    });
    return this.booting;
  }

  private async boot(): Promise<Engine> {
    // An engine is replaced only after it is gone, and a gone engine reports nothing more, so its
    // messages always belong to the current engine. A death during the boot rejects the boot instead.
    let attached = false;
    const engine = new Engine(this.config, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (id, method, params) => this.onRequest(id, method, params),
      onExit: (reason) => {
        if (attached) this.onExit(reason);
      },
      log: this.options.log,
    });
    this.engine = engine;
    try {
      const info = await engine.start();
      this.options.onEngine?.(info.userAgent);
      if (this.threadId !== '') {
        await engine.call('thread/resume', {
          threadId: this.threadId,
          cwd: this.cwd,
          ...(await this.policy(engine)),
          initialTurnsPage: { limit: RESUME_TURNS, itemsView: 'full' },
        });
      }
      attached = true;
      return engine;
    } catch (error) {
      this.engine = undefined;
      await engine.kill();
      // Engine calls reject with an RpcError (unavailable) or an Error carrying the engine's message.
      throw error instanceof RpcError ? error : unavailable((error as Error).message);
    }
  }

  /** The settings the engine session runs with: `approvalMode` and `sandbox` (spec 5.1 Session.settings). */
  effectiveSettings(): Settings {
    const { approvalPolicy, sandbox } = sessionPolicy(this.settings, this.config);
    return { approvalMode: approvalPolicy, sandbox };
  }

  /** Approval policy, sandbox and model for thread/start and thread/resume. */
  private async policy(engine: Engine): Promise<Json> {
    const { approvalPolicy, sandbox } = sessionPolicy(this.settings, this.config);
    this.model ??= typeof this.settings.model === 'string' && this.settings.model !== '' ? this.settings.model : undefined;
    this.model ??= this.options.defaultModel?.();
    if (this.model === undefined) {
      // Never the user's config.toml model: the ChatGPT plan may reject it. The engine's default is safe.
      const result = (await engine.call('model/list', {})) as Json;
      this.model = defaultModel(toModels(result.data));
    }
    const out: Json = { approvalPolicy, sandbox };
    if (this.model !== undefined) out.model = this.model;
    return out;
  }

  private onExit(reason: string): void {
    this.engine = undefined;
    this.requests.clear();
    this.items.clear();
    this.running = false;
    this.turnId = undefined;
    this.emit({ method: 'status/changed', params: { status: 'error' } });
    this.emit({ method: 'agent/exited', params: { reason } });
  }

  // ---- engine messages -------------------------------------------------------------------------

  private onNotification(method: string, params: Json): void {
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId) return;
    const field = DELTA_METHODS[method];
    if (field !== undefined) {
      if (this.running) this.emit({ method: 'item/delta', params: { itemId: str(params.itemId), field, delta: str(params.delta) } });
      return;
    }
    switch (method) {
      case 'item/started':
      case 'item/completed':
        return this.onItem(method, params.item);
      case 'turn/completed':
        return this.onTurnCompleted(params.turn as Json | undefined);
      case 'thread/status/changed':
        return this.onStatus(params.status);
      case 'thread/tokenUsage/updated':
        this.emit({ method: 'usage/updated', params: { usage: toUsage(params.tokenUsage) } });
        return;
      case 'serverRequest/resolved':
        return this.onRequestResolved(params.requestId as RpcId);
      default:
        return;
    }
  }

  private onItem(method: 'item/started' | 'item/completed', raw: unknown): void {
    if (!this.running) return;
    const item = toItem(raw, method === 'item/completed');
    if (!item) return;
    this.items.set(item.itemId, raw as Json);
    this.emit({ method, params: { item } });
  }

  private onTurnCompleted(turn: Json | undefined): void {
    if (!this.running) return;
    const id = str(turn?.id);
    if (this.turnId !== undefined && id !== '' && id !== this.turnId) return;
    this.running = false;
    this.turnId = undefined;
    this.items.clear();
    // Requests of the turn are void now; the core withdraws them from the Journal.
    this.requests.clear();
    const status = toFinalStatus(turn?.status);
    const params: Extract<AdapterEvent, { method: 'turn/completed' }>['params'] = { status };
    if (status === 'failed') params.error = toTurnError(turn?.error);
    this.emit({ method: 'turn/completed', params });
  }

  /**
   * The engine's thread status. While a turn runs the core derives running and waiting from the pending
   * requests, so an engine `idle` is held back until the turn ends, and nothing but `error` is forwarded
   * outside a turn.
   */
  private onStatus(raw: unknown): void {
    const status = toSessionStatus(raw);
    if (status === undefined) return;
    if (status !== 'error' && (status === 'idle') === this.running) return;
    this.emit({ method: 'status/changed', params: { status } });
  }

  private onRequestResolved(rpcId: RpcId): void {
    for (const [requestId, request] of this.requests) {
      if (request.rpcId !== rpcId) continue;
      this.requests.delete(requestId);
      this.emit({ method: 'request/withdrawn', params: { requestId } });
      return;
    }
  }

  private onRequest(rpcId: RpcId, method: string, params: Json): void {
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId) {
      this.engine?.respondError(rpcId, -32602, `the host does not drive thread ${params.threadId}`);
      return;
    }
    if (method in APPROVAL_METHODS) return this.onApproval(rpcId, method as ApprovalMethod, params);
    if (method === INPUT_METHOD) return this.onInput(rpcId, params);
    this.engine?.respondError(rpcId, -32601, `the Nano host does not handle ${method}`);
  }

  private onApproval(rpcId: RpcId, method: ApprovalMethod, params: Json): void {
    const requestId = newId('req');
    const itemId = str(params.itemId);
    const item = this.items.get(itemId) ?? {};
    const base = { requestId, itemId, reason: str(params.reason), expiresAt: null };
    let request: AdapterApprovalRequest;
    if (method === 'item/commandExecution/requestApproval') {
      request = {
        ...base,
        kind: 'command',
        command: str(params.command) || str(item.command),
        cwd: str(params.cwd) || str(item.cwd) || this.cwd,
        availableDecisions: decisionsFrom(params.availableDecisions),
      };
    } else if (method === 'item/fileChange/requestApproval') {
      request = { ...base, kind: 'fileChange', changes: toFileChanges(item.changes), availableDecisions: decisionsFrom(undefined) };
      if (typeof params.grantRoot === 'string') request.grantRoot = params.grantRoot;
    } else {
      request = {
        ...base,
        kind: 'permission',
        permissions: (params.permissions ?? {}) as Json,
        scope: 'turn',
        availableDecisions: decisionsFrom(undefined),
      };
    }
    this.requests.set(requestId, { rpcId, method, params });
    this.emit({ method: 'approval/request', params: { request } });
  }

  private onInput(rpcId: RpcId, params: Json): void {
    const requestId = newId('req');
    const questions = (Array.isArray(params.questions) ? params.questions : []).map((raw) => {
      const q = (raw ?? {}) as Json;
      const question = {
        id: str(q.id),
        header: str(q.header),
        question: str(q.question),
        isOther: q.isOther === true,
        isSecret: q.isSecret === true,
      };
      return Array.isArray(q.options)
        ? {
            ...question,
            options: q.options.map((o) => ({ label: str((o as Json).label), description: str((o as Json).description) })),
          }
        : question;
    });
    this.requests.set(requestId, { rpcId, method: INPUT_METHOD, params });
    this.emit({
      method: 'input/request',
      params: { request: { requestId, kind: 'input', itemId: str(params.itemId), isBlocking: params.isBlocking !== false, questions } },
    });
  }

  private take(requestId: string): PendingRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request || !this.engine?.alive) return undefined;
    this.requests.delete(requestId);
    return request;
  }

  /** Silent after `kill()`: it clears the listeners. */
  private emit(event: AdapterEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
