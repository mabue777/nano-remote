// The Codex adapter: drives one Codex thread through `codex app-server` (protocol-v1.md section 11).
//
//   session/start  -> thread/start {cwd, approvalPolicy, sandbox, model, config}   (settings.approvalMode, settings.sandbox,
//                     settings.effort as config.model_reasoning_effort)
//   resume         -> thread/resume {threadId, ..., initialTurnsPage {limit 5, itemsView "full"}}
//   turn/start     -> turn/start {threadId, input, clientUserMessageId, model, effort}
//                     (+ approvalPolicy, sandboxPolicy after the approval mode changed)
//
// Settings changes (spec 6 session/settings/update): turn/start takes `model` and `effort` "for this turn
// and subsequent turns" (app-server types of codex-cli 0.163.0-alpha.11.1, the ChatGPT.app engine, and
// 0.164.0), so changeSettings only stores them and every later turn/start carries them; a running turn
// keeps its own. thread/resume after an engine restart sends them too (model, config effort).
// An approval mode change goes the same way: turn/start also takes `approvalPolicy` and `sandboxPolicy`
// "for this turn and subsequent turns" (app-server schema, docs/research/rea/codex-app-server-schema), and
// app-server offers nothing that changes a running turn's policy (thread/settings/update also acts on
// "subsequent turns"), so changeSettings answers nextTurn and the next turn/start carries both once.
//
// Effort (spec 5.1 settings.effort): thread/start takes no effort field of its own (app-server types of
// codex-cli 0.163.0-alpha.11.1), so it goes in as the thread's model_reasoning_effort config; turn/start
// has `effort` ("for this turn and subsequent turns") and gets it on every turn. The level in effect is the
// `reasoningEffort` that thread/start and thread/resume answer with.
//   turn/steer     -> turn/steer {threadId, expectedTurnId, input, clientUserMessageId}
//   turn/interrupt -> turn/interrupt {threadId, turnId}
//   approvals      <- item/{commandExecution,fileChange,permissions}/requestApproval (engine decisions forwarded)
//   questions      <- item/tool/requestUserInput
//   items, deltas, thread/status/changed, thread/tokenUsage/updated, turn/completed -> adapter events
//
// Image limit: the model provider may cap the images one conversation holds (Ollama Cloud: 60), and Codex
// re-sends the whole thread on every model call, so a thread past the cap fails every turn with "Too many
// images were provided...". The adapter counts the images the thread gathered since its last compaction and
// compacts it (thread/compact/start) before a turn once the count reaches IMAGE_COMPACT_THRESHOLD. A turn
// that fails with that error anyway is recovered once per host turn: compact, note it in an agentMessage,
// and continue in a new engine turn the core sees as the same host turn. If that cannot help, the host turn
// fails with code `image_limit`.
//
// Supervision: when the engine dies on its own the adapter emits `status/changed {error}` and
// `agent/exited`; calls in flight reject with `agent_unavailable`. The next call starts a new engine and
// resumes the thread. `kill()` ends the engine's process group and silences the adapter for good.
import type { Decision, Settings, TurnError } from '../../generated/common.js';
import type {
  Adapter,
  AdapterApprovalRequest,
  AdapterEvent,
  AdapterInputPart,
  AdapterItem,
  AdapterListener,
  AppliesAt,
  FinalTurnStatus,
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

/**
 * Images the thread may gather before the next turn compacts it first. The model provider (Ollama Cloud)
 * rejects a conversation holding more than 60 images, and Codex re-sends the whole thread on every model
 * call; 50 leaves room for the images one more turn adds before the cap.
 */
export const IMAGE_COMPACT_THRESHOLD = 50;

/** How long a compaction (thread/compact/start until it ended) may take. */
export const COMPACT_TIMEOUT_MS = 180_000;

/** The agentMessage that tells the phone a turn was compacted and continues. */
export const COMPACTED_NOTE = 'The conversation held more images than the model accepts (60), so its context was compacted. Continuing.';

/** The input of the engine turn that continues a host turn after the image-limit compaction. */
export const CONTINUE_TEXT =
  'The previous turn stopped because the conversation held more images than the model accepts; its context has just been compacted. Continue the task from where you left off.';

/** The host turn's error when the image limit could not be recovered from. */
export const IMAGE_LIMIT_ERROR: TurnError = {
  code: 'image_limit',
  message: 'The conversation holds more images than the model accepts (60) and could not be compacted. Start a new session for this work.',
};

/** True for the model provider's "too many images in this conversation" rejection. */
export function isImageLimitError(message: string | undefined): boolean {
  const text = (message ?? '').toLowerCase();
  return text.includes('too many images') || text.includes('limit the number of images');
}

/** Images a protocol item adds to the model's context: image blocks of a tool result, a viewed image. */
export function imagesIn(item: AdapterItem): number {
  if (item.type !== 'toolCall') return 0;
  if (item.tool === 'imageView') return 1;
  const result = item.result as { content?: unknown } | unknown[] | undefined;
  const blocks = Array.isArray(result) ? result : Array.isArray(result?.content) ? result.content : [];
  return blocks.filter((b) => {
    const type = (b as Json | null)?.type;
    return type === 'image' || type === 'inputImage';
  }).length;
}

const inputImages = (input: readonly AdapterInputPart[]): number => input.filter((part) => part.type === 'image').length;

export interface CodexAdapterOptions {
  config?: CodexConfig;
  /** How long a compaction may take (default COMPACT_TIMEOUT_MS). */
  compactTimeoutMs?: number;
  /** The model for sessions whose settings name none. Asked for lazily; undefined falls back to `model/list`. */
  defaultModel?: () => string | undefined;
  /** Called with the engine's `initialize` userAgent every time an engine starts. */
  onEngine?: (userAgent: string) => void;
  log?: (message: string) => void;
}

/** A running thread/compact/start: settles once the compaction ended (or failed, or timed out). */
interface Compaction {
  /** The engine turn that carries the compaction, once its turn/started arrived. */
  turnId?: string;
  settle(error?: Error): void;
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

/** turn/start `sandboxPolicy` for a sandbox mode (thread/start takes the mode, turn/start a policy object). */
export function sandboxPolicy(sandbox: CodexSandbox): Json {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'read-only') return { type: 'readOnly' };
  return { type: 'workspaceWrite' };
}

/** The requested reasoning effort (settings.effort), when the session names one. */
export function sessionEffort(settings: Settings): string | undefined {
  return typeof settings.effort === 'string' && settings.effort !== '' ? settings.effort : undefined;
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
  /** The thread's reasoning effort as the engine last reported it (thread/start, thread/resume). */
  private reportedEffort: string | undefined;
  /** The engine's id of the running turn, once known; `running` is true from `turnStart` to its end. */
  private turnId: string | undefined;
  private running = false;
  private turnStarting: Promise<unknown> | undefined;
  /** The approval policy and sandbox the thread runs with (thread/start, thread/resume, a turn/start). */
  private appliedPolicy: { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandbox } | undefined;
  /**
   * Engine messages read while turn/start awaits its reply's turn id. The lines after the reply in one
   * stdout chunk are handled before `turnStart` resumes, so they wait here and replay, in order, once the
   * turn id is known (or turn/start failed): a turn/completed of another turn is then told apart.
   */
  private held: (() => void)[] | undefined;
  private readonly requests = new Map<string, PendingRequest>();
  /** Items of the running turn by id, for approvals that refer to them (file changes, command cwd). */
  private readonly items = new Map<string, Json>();
  /** Images the thread holds since its last compaction (inputs sent, tool results); 0 after a resume. */
  private imageCount = 0;
  /** The compaction in progress; engine messages go to it, not to the host turn. */
  private compaction: Compaction | undefined;
  /** Counts host turns, so a late step of an earlier turn's compaction does nothing. */
  private hostTurn = 0;
  /** The running host turn already compacted after the image-limit error. */
  private recovered = false;
  /** An interrupt arrived while the host turn waited for a compaction. */
  private interruptAsked = false;

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
    this.learnEffort(result);
    this.threadId = str((result.thread as Json | undefined)?.id);
    if (this.threadId === '') throw unavailable('thread/start returned no thread id');
    return this.threadId;
  }

  async resume(engineSessionId: string, cwd: string, settings: Settings): Promise<void> {
    this.remember(cwd, settings);
    this.threadId = engineSessionId;
    // What the thread held before is unknown; a turn that hits the image limit still recovers.
    this.imageCount = 0;
    await this.connect();
  }

  async turnStart(input: AdapterInputPart[], clientMessageId: string): Promise<void> {
    const engine = await this.ready();
    this.running = true;
    this.turnId = undefined;
    this.items.clear();
    this.hostTurn++;
    this.recovered = false;
    this.interruptAsked = false;
    if (this.imageCount < IMAGE_COMPACT_THRESHOLD) {
      try {
        return await this.engineTurnStart(engine, input, clientMessageId);
      } catch (error) {
        this.running = false;
        throw error;
      }
    }
    // Compacting can take a minute, longer than a client waits for turn/start: the host turn is open
    // from here, and the engine turn starts once the compaction ended.
    this.options.log?.(`codex: compacting thread ${this.threadId} before the turn (${this.imageCount} images)`);
    const hostTurn = this.hostTurn;
    const work = (async () => {
      try {
        await this.compact(engine);
      } catch (error) {
        // The count may overestimate what the provider holds: start the turn anyway; it recovers if needed.
        this.options.log?.(`codex: compaction failed: ${(error as Error).message}`);
      }
      if (hostTurn !== this.hostTurn || !this.running) return;
      if (this.interruptAsked) return this.endTurn('interrupted');
      await this.engineTurnStart(engine, input, clientMessageId);
    })();
    this.turnStarting = work;
    work
      .catch((error: unknown) => {
        if (hostTurn === this.hostTurn && this.running) {
          this.endTurn('failed', { code: 'agent_unavailable', message: (error as Error).message });
        }
      })
      .finally(() => {
        if (this.turnStarting === work) this.turnStarting = undefined;
      });
  }

  /** turn/start of an engine turn for the running host turn; rejects when the engine refuses it. */
  private async engineTurnStart(engine: Engine, input: AdapterInputPart[], clientMessageId?: string): Promise<void> {
    const params: Json = { threadId: this.threadId, input: toUserInput(input) };
    if (clientMessageId !== undefined) params.clientUserMessageId = clientMessageId;
    if (this.model !== undefined) params.model = this.model;
    const policy = sessionPolicy(this.settings, this.config);
    const policyChanged = policy.approvalPolicy !== this.appliedPolicy?.approvalPolicy || policy.sandbox !== this.appliedPolicy?.sandbox;
    if (policyChanged) {
      params.approvalPolicy = policy.approvalPolicy;
      params.sandboxPolicy = sandboxPolicy(policy.sandbox);
    }
    const effort = sessionEffort(this.settings);
    if (effort !== undefined) {
      params.effort = effort;
      // The thread runs at it from this turn on (Codex does not downgrade a level).
      this.reportedEffort = effort;
    }
    const call = engine.call('turn/start', params);
    const outer = this.turnStarting;
    this.turnStarting = call;
    this.held = [];
    try {
      const result = (await call) as { turn?: { id?: unknown } };
      this.turnId = str(result?.turn?.id) || undefined;
      if (policyChanged) this.appliedPolicy = policy;
      this.imageCount += inputImages(input);
    } finally {
      this.turnStarting = outer;
      this.replayHeld();
    }
  }

  private replayHeld(): void {
    const held = this.held ?? [];
    this.held = undefined;
    for (const handle of held) handle();
  }

  async steer(input: AdapterInputPart[], clientMessageId: string): Promise<void> {
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
    this.imageCount += inputImages(input);
  }

  async interrupt(): Promise<void> {
    if (this.running && this.compaction) {
      // The host turn waits for a compaction: it ends interrupted once the compaction stopped.
      this.interruptAsked = true;
      const turnId = this.compaction.turnId;
      if (turnId !== undefined && this.engine?.alive) await this.engine.call('turn/interrupt', { threadId: this.threadId, turnId });
      else this.compaction.settle(new Error('interrupted before the compaction turn started'));
      return;
    }
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
      onNotification: (method, params) => this.hold(() => this.onNotification(method, params)),
      onRequest: (id, method, params) => this.hold(() => this.onRequest(id, method, params)),
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
        const resumed = await engine.call('thread/resume', {
          threadId: this.threadId,
          cwd: this.cwd,
          ...(await this.policy(engine)),
          initialTurnsPage: { limit: RESUME_TURNS, itemsView: 'full' },
        });
        this.learnEffort(resumed as Json);
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

  /**
   * A settings change (spec 6): stored for the next turn/start, which sends the model, effort and, when
   * it changed, the approval policy and sandbox to the engine; nothing goes to the engine now, so a running
   * turn keeps its own.
   */
  changeSettings(settings: Settings): AppliesAt {
    this.settings = settings;
    if (typeof settings.model === 'string' && settings.model !== '') this.model = settings.model;
    return 'nextTurn';
  }

  /** The settings the engine session runs with: `approvalMode`, `sandbox`, `effort` (spec 5.1 Session.settings). */
  effectiveSettings(): Settings {
    const { approvalPolicy, sandbox } = sessionPolicy(this.settings, this.config);
    const settings: Settings = { approvalMode: approvalPolicy, sandbox };
    if (this.reportedEffort !== undefined) settings.effort = this.reportedEffort;
    return settings;
  }

  /** The `reasoningEffort` of a thread/start or thread/resume reply (null: the thread has none). */
  private learnEffort(result: Json | undefined): void {
    const effort = result?.reasoningEffort;
    this.reportedEffort = typeof effort === 'string' && effort !== '' ? effort : undefined;
  }

  /** Approval policy, sandbox, model and reasoning effort for thread/start and thread/resume. */
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
    this.appliedPolicy = { approvalPolicy, sandbox };
    if (this.model !== undefined) out.model = this.model;
    const effort = sessionEffort(this.settings);
    if (effort !== undefined) out.config = { model_reasoning_effort: effort };
    return out;
  }

  private onExit(reason: string): void {
    this.engine = undefined;
    this.held = undefined;
    this.requests.clear();
    this.items.clear();
    this.running = false;
    this.turnId = undefined;
    this.compaction?.settle(new Error(`the engine exited: ${reason}`));
    this.emit({ method: 'status/changed', params: { status: 'error' } });
    this.emit({ method: 'agent/exited', params: { reason } });
  }

  // ---- engine messages -------------------------------------------------------------------------

  /** Handles an engine message now, or after the pending turn/start reply was processed. */
  private hold(handle: () => void): void {
    if (this.held) this.held.push(handle);
    else handle();
  }

  private onNotification(method: string, params: Json): void {
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId) return;
    if (this.compaction) return this.onCompactionMessage(this.compaction, method, params);
    if (method === 'thread/compacted') {
      // Codex compacted the thread on its own (deprecated notification; the item says the same).
      this.imageCount = 0;
      return;
    }
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
    const completed = method === 'item/completed';
    // Codex's own compaction mid-turn: the thread starts over with a summary.
    if (completed && (raw as Json | null)?.type === 'contextCompaction') this.imageCount = 0;
    if (!this.running) return;
    const item = toItem(raw, completed);
    if (!item) return;
    if (completed) this.imageCount += imagesIn(item);
    this.items.set(item.itemId, raw as Json);
    this.emit({ method, params: { item } });
  }

  private onTurnCompleted(turn: Json | undefined): void {
    if (!this.running) return;
    const id = str(turn?.id);
    if (this.turnId !== undefined && id !== '' && id !== this.turnId) return;
    const status = toFinalStatus(turn?.status);
    if (status === 'failed') {
      const error = toTurnError(turn?.error);
      if (!isImageLimitError(error.message)) return this.endTurn(status, error);
      if (this.recovered) return this.endTurn(status, IMAGE_LIMIT_ERROR);
      return this.recover();
    }
    this.endTurn(status);
  }

  /** Ends the host turn and leaves the adapter idle. */
  private endTurn(status: FinalTurnStatus, error?: TurnError): void {
    this.running = false;
    this.turnId = undefined;
    this.items.clear();
    // Requests of the turn are void now; the core withdraws them from the Journal.
    this.requests.clear();
    const params: Extract<AdapterEvent, { method: 'turn/completed' }>['params'] = { status };
    if (error) params.error = error;
    this.emit({ method: 'turn/completed', params });
  }

  /**
   * The engine turn failed on the provider's image limit: compact the thread, tell the phone, and continue
   * in a new engine turn of the same host turn. Once per host turn; if it cannot help, the turn fails.
   */
  private recover(): void {
    this.options.log?.(`codex: image limit hit, compacting thread ${this.threadId} (${this.imageCount} images)`);
    this.recovered = true;
    this.turnId = undefined;
    this.items.clear();
    this.requests.clear();
    const hostTurn = this.hostTurn;
    const current = () => hostTurn === this.hostTurn && this.running;
    const engine = this.engine;
    if (!engine?.alive) return this.endTurn('failed', IMAGE_LIMIT_ERROR);
    const work = (async () => {
      try {
        await this.compact(engine);
      } catch (error) {
        this.options.log?.(`codex: compaction failed: ${(error as Error).message}`);
        if (!current()) return;
        return this.interruptAsked ? this.endTurn('interrupted') : this.endTurn('failed', IMAGE_LIMIT_ERROR);
      }
      if (!current()) return;
      if (this.interruptAsked) return this.endTurn('interrupted');
      this.emit({
        method: 'item/completed',
        params: { item: { itemId: newId('itm'), type: 'agentMessage', status: 'completed', text: COMPACTED_NOTE } },
      });
      try {
        await this.engineTurnStart(engine, [{ type: 'text', text: CONTINUE_TEXT }]);
      } catch (error) {
        if (current()) this.endTurn('failed', { code: 'agent_unavailable', message: (error as Error).message });
      }
    })();
    this.turnStarting = work;
    void work.finally(() => {
      if (this.turnStarting === work) this.turnStarting = undefined;
    });
  }

  /**
   * thread/compact/start, resolved once the compaction ended: its contextCompaction item completed or the
   * (deprecated) thread/compacted arrived, and the engine turn carrying it (if one started) completed.
   * Rejects when the engine refuses, the compaction turn fails, or it takes longer than the timeout.
   */
  private compact(engine: Engine): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.compactTimeoutMs ?? COMPACT_TIMEOUT_MS;
      const compaction: Compaction = {
        settle: (error) => {
          if (this.compaction !== compaction) return;
          this.compaction = undefined;
          clearTimeout(timer);
          if (error) return reject(error);
          this.imageCount = 0;
          resolve();
        },
      };
      const timer = setTimeout(() => compaction.settle(new Error(`the compaction took longer than ${timeoutMs} ms`)), timeoutMs);
      this.compaction = compaction;
      engine.call('thread/compact/start', { threadId: this.threadId }).catch((error: unknown) => compaction.settle(error as Error));
    });
  }

  /** Engine messages while a compaction runs: they belong to it, the host turn sees none of them. */
  private onCompactionMessage(compaction: Compaction, method: string, params: Json): void {
    const turn = (params.turn ?? {}) as Json;
    const item = (params.item ?? {}) as Json;
    if (method === 'turn/started') {
      compaction.turnId = str(turn.id) || undefined;
    } else if ((method === 'item/completed' && item.type === 'contextCompaction') || method === 'thread/compacted') {
      // With a compaction turn under way its turn/completed ends it, so it cannot leak into the next turn.
      if (compaction.turnId === undefined) compaction.settle();
    } else if (method === 'turn/completed') {
      const id = str(turn.id);
      if (compaction.turnId !== undefined && id !== '' && id !== compaction.turnId) return;
      const status = toFinalStatus(turn.status);
      if (status === 'completed') compaction.settle();
      else compaction.settle(new Error(status === 'failed' ? toTurnError(turn.error).message : 'the compaction was interrupted'));
    } else if (method === 'thread/tokenUsage/updated') {
      this.emit({ method: 'usage/updated', params: { usage: toUsage(params.tokenUsage) } });
    }
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
