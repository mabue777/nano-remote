// The Claude Code adapter: drives one Claude Code session through the Claude Agent SDK's `query()` in
// streaming-input mode (protocol-v1.md section 11, Claude column).
//
//   session/start  -> query({prompt: <inbox>, options: {cwd, model, permissionMode, settingSources: [],
//                     includePartialMessages: true, canUseTool, env, spawnClaudeCodeProcess, ...}})
//   resume         -> the same with options.resume = <engine session id>
//   turn/start     -> one SDKUserMessage pushed into the inbox (text parts joined, attached images as
//                     base64 image blocks, attached files as a path line, see mapping.ts)
//   turn/steer     -> not_supported (capabilities.steer false)
//   turn/interrupt -> Query.interrupt(); the next `result` ends the turn as interrupted
//   approvals      <- canUseTool (Bash: command, Write/Edit/MultiEdit/NotebookEdit: fileChange, others: permission)
//   questions      <- canUseTool for AskUserQuestion (answers keyed by question text; protocol ids are indexes)
//   items          <- assistant text/thinking/tool_use blocks, user tool_result blocks, stream_event deltas
//   turn end       <- result (usage/updated, then turn/completed)
//   engine turns   <- top-level output while no turn runs: turn/started, then the items as usual. Claude
//                     Code starts a turn by itself when a background task reports in (Monitor event,
//                     run_in_background Bash, async Agent); the system/task_notification before it becomes
//                     a "background task: <summary>" toolCall item. A turnStart during such a turn joins
//                     it: the message goes into the inbox and Claude Code takes it mid-turn.
//
// Settings: approvalMode `never` runs bypassPermissions (with allowDangerouslySkipPermissions), `acceptEdits`
// and `plan` the Claude modes of the same name, anything else `default`. Only `default` with
// `settingSources: []` sends every tool call to canUseTool: with the operator's own settings loaded, auto
// mode approves silently and a deny rule hides AskUserQuestion (spikes/host-drive/NOTES.md).
//
// Supervision: the adapter spawns the Claude Code executable itself (spawnClaudeCodeProcess), detached in
// its own process group. When it dies on its own the adapter emits `status/changed {error}` and
// `agent/exited`; calls waiting on it reject with `agent_unavailable`; the next call starts a new query
// that resumes the session. `kill()` ends the process group, closes the inbox and the query, and silences
// the adapter for good.
//
// SDK behaviors (0.3.308, Claude Code 2.1.x on the operator's Mac):
// Verified by the host-drive spike: system/init (carrying session_id) arrives only after the first user
// message; assistant messages carry text and tool_use blocks and the next user message the tool_result
// (is_error for failures); `result` ends every turn and carries the turn's usage; query({resume}) after a
// SIGKILL continues the same session (same session_id in its system/init); canUseTool fires for Bash,
// Write and AskUserQuestion under permissionMode default with settingSources [].
// Verified by a model-list probe without any user message: Query.supportedModels() answers in about 4 s
// before the first user message (no tokens spent), so the provider needs no static fallback for it.
// Verified by the live test (live.test.ts, NANO_LIVE_CLAUDE=1, 2026-10-22, SDK 0.3.308, Claude Code
// 2.1.308, model opus = claude-opus-5-5):
// - spawnClaudeCodeProcess is called inside query(), so the child (and its pid) exists right after start;
// - system/init comes once per user message, on every turn and on every new query, always with the same
//   session_id (also after query({resume}) on a new process); its claude_code_version is the CLI version;
// - a Write call reaches canUseTool with suggestions, so acceptForSession is offered; allow writes the file;
// - stream_event text_delta arrives before the complete assistant text block (deltas stream);
// - result success carries usage (input 3 + cache ~35k, output ~130 for the hello.txt turn);
// - after Query.interrupt() the turn ends with result subtype error_during_execution, is_error true;
// - SIGKILL of the child: the adapter reports agent/exited, the next turn resumes on a new query and the
//   model remembers the earlier turn.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';

import type { Decision, Settings } from '../../generated/common.js';
import type { Adapter, AdapterEvent, AdapterInputPart, AdapterItem, AdapterListener } from '../../core/adapter.js';
import { newId } from '../../core/ids.js';
import { claudeConfig, type ClaudeConfig } from '../../config/claude.js';
import { RpcError } from '../../errors.js';
import {
  CANCEL_MESSAGE,
  childEnv,
  completeToolItem,
  permissionAnswer,
  questionAnswer,
  sessionModel,
  sessionPolicy,
  toRequest,
  toTurnEnd,
  toUsage,
  toUserContent,
  toolItem,
  type PermissionAnswer,
} from './mapping.js';

type Json = Record<string, unknown>;

/** The part of the SDK's Query the adapter and the provider use. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'close' | 'supportedModels'>;

/** The SDK's `query()`, or a fake with the same shape. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;

let sdkQuery: Promise<QueryFn> | undefined;

/** The SDK's `query()`, imported on first use (the host starts without loading the SDK). */
export function loadQuery(): Promise<QueryFn> {
  sdkQuery ??= import('@anthropic-ai/claude-agent-sdk').then((sdk) => sdk.query as unknown as QueryFn);
  return sdkQuery;
}

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
let bundled: string | null | undefined;

/**
 * The Claude Code executable bundled with the SDK (the platform package next to it), found from the SDK's
 * real folder; undefined when it is not there (the SDK's own lookup then reports the error).
 *
 * The SDK finds it itself with require.resolve from its module URL, but Node 26.5's cached realpath
 * returns a path unresolved when the last synchronous stat in the process hit a pipe or a socket (the
 * host's stdout under a supervisor, the control socket). The SDK is then loaded from the pnpm symlink
 * host/node_modules/@anthropic-ai/claude-agent-sdk, whose parent folders do not hold the platform
 * package, and every query fails with "Native CLI binary ... not found" (seen after a host restart in the
 * Phase 4 acceptance). realpathSync.native does not use that cache.
 */
export function bundledExecutable(): string | undefined {
  if (bundled === undefined) {
    bundled = null;
    try {
      const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
      const sdkDir = realpathSync.native(path.dirname(entry));
      const file = createRequire(path.join(sdkDir, 'package.json')).resolve(`${SDK_PACKAGE}-${process.platform}-${process.arch}/claude`);
      if (existsSync(file)) bundled = file;
    } catch {
      // Not installed for this platform: leave it to the SDK.
    }
  }
  return bundled ?? undefined;
}

/** `pathToClaudeCodeExecutable`: the configured executable, else the bundled one when it is found. */
export function executablePath(config: ClaudeConfig): string | undefined {
  return config.executable ?? bundledExecutable();
}

export function unavailable(reason: string): RpcError {
  return new RpcError('agent_unavailable', `agent claude is unavailable: ${reason}`, { agentId: 'claude', reason });
}

/** How long a lost child gets to report its exit code after the SDK's stream ended. */
const EXIT_GRACE_MS = 250;

export interface ClaudeAdapterOptions {
  config?: ClaudeConfig;
  /** Replaces the SDK's `query()` (tests). */
  query?: QueryFn;
  /** Called with `claude_code_version` from every system/init. */
  onVersion?: (version: string) => void;
  log?: (message: string) => void;
}

/** Push-based async iterable: the SDK's streaming-input prompt. Iterated once, by the SDK. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    this.items.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

/** One query and the Claude Code process behind it. A dead run is replaced, never revived. */
interface Run {
  inbox: Inbox;
  query: ClaudeQuery | undefined;
  child: ChildProcess | undefined;
  exited: Promise<void>;
  /** Why the run ended; set once. */
  gone: string | undefined;
  /** system/init arrived (the engine accepted its first user message). */
  initialized: boolean;
  initWaiters: Array<{ resolve(): void; reject(error: Error): void }>;
}

interface PendingRequest {
  requestId: string;
  toolUseID: string;
  kind: 'approval' | 'input';
  input: Json;
  suggestions: unknown;
  /** Question texts by protocol question id (AskUserQuestion). */
  questions: string[];
  resolve(answer: PermissionAnswer): void;
  promise: Promise<PermissionAnswer>;
}

/** A text or thinking block streaming in, until its assistant message completes it. */
interface StreamItem {
  itemId: string;
  type: 'agentMessage' | 'reasoning';
  messageId: string;
  index: number;
  text: string;
  started: boolean;
}

interface TurnState {
  /** Started by the engine itself (a background task reported in), not by turnStart. */
  engine: boolean;
  interrupted: boolean;
  messageId: string;
  streaming: StreamItem[];
  /** Tool items started and not yet completed, by tool_use id. */
  tools: Map<string, AdapterItem>;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const obj = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

const alive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

export class ClaudeAdapter implements Adapter {
  private readonly config: ClaudeConfig;
  private readonly options: ClaudeAdapterOptions;
  private readonly listeners = new Set<AdapterListener>();
  private run: Run | undefined;
  private opening: Promise<Run> | undefined;
  private killed = false;
  private sessionId = '';
  private cwd = '';
  private settings: Settings = {};
  private turn: TurnState | undefined;
  /** Background-task notifications that arrived while no turn ran: shown in the engine turn they start. */
  private notes: AdapterItem[] = [];
  private readonly requests = new Map<string, PendingRequest>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    this.config = options.config ?? claudeConfig();
  }

  /** The Claude Code process id while one runs (tests and diagnostics). */
  get pid(): number | undefined {
    const child = this.run?.gone === undefined ? this.run?.child : undefined;
    return child && alive(child) ? child.pid : undefined;
  }

  get engineSessionId(): string {
    return this.sessionId;
  }

  onEvent(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Spawns the engine; its session id comes with the first turn's system/init (`engine/session`). */
  async start(cwd: string, settings: Settings): Promise<string> {
    this.remember(cwd, settings);
    this.sessionId = '';
    await this.connect();
    return '';
  }

  async resume(engineSessionId: string, cwd: string, settings: Settings): Promise<void> {
    this.remember(cwd, settings);
    this.sessionId = engineSessionId;
    await this.connect();
  }

  /** Pushes the user message; on a fresh query resolves once system/init shows the engine took it. */
  async turnStart(input: AdapterInputPart[], _clientMessageId: string): Promise<void> {
    const content = await toUserContent(input);
    const run = await this.ready();
    // During an engine-initiated turn the message joins it: Claude Code delivers it mid-turn.
    if (!this.turn) {
      this.turn = newTurn(false);
      this.notes = [];
    }
    this.emit({ method: 'status/changed', params: { status: 'running' } });
    run.inbox.push({ type: 'user', message: { role: 'user', content: content as SDKUserMessage['message']['content'] }, parent_tool_use_id: null });
    if (!run.initialized) await this.initialized(run);
  }

  async steer(): Promise<void> {
    throw new RpcError('not_supported', 'agent claude cannot steer a running turn', { agentId: 'claude' });
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    const run = this.run;
    if (!run?.query || run.gone !== undefined) throw unavailable('the engine is not running');
    turn.interrupted = true;
    await run.query.interrupt();
  }

  async resolveApproval(requestId: string, decision: Decision): Promise<void> {
    const request = this.take(requestId, 'approval');
    if (!request) return;
    // cancel denies with interrupt: true, which stops the turn.
    if (decision === 'cancel' && this.turn) this.turn.interrupted = true;
    request.resolve(permissionAnswer(decision, request.input, request.suggestions));
  }

  async answerInput(requestId: string, answers: Record<string, string[]>): Promise<void> {
    const request = this.take(requestId, 'input');
    if (!request) return;
    request.resolve(questionAnswer(request.input, request.questions, answers));
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.listeners.clear();
    await this.opening?.catch(() => {});
    this.denyAll(CANCEL_MESSAGE);
    this.turn = undefined;
    this.notes = [];
    const run = this.run;
    this.run = undefined;
    if (run) await this.end(run, 'killed by the host');
  }

  /** The settings the session runs with: `model` and `approvalMode` as mapped (spec 5.1 Session.settings). */
  effectiveSettings(): Settings {
    return { model: sessionModel(this.settings, this.config), approvalMode: sessionPolicy(this.settings).approvalMode };
  }

  // ---- engine lifecycle ------------------------------------------------------------------------

  private remember(cwd: string, settings: Settings): void {
    this.cwd = cwd;
    this.settings = settings;
  }

  /** The running query; a dead one is replaced by a query that resumes the session. */
  private async ready(): Promise<Run> {
    if (this.opening) return this.opening;
    if (this.run && this.run.gone === undefined) return this.run;
    return this.connect();
  }

  private connect(): Promise<Run> {
    if (this.killed) return Promise.reject(unavailable('the adapter was killed'));
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<Run> {
    let queryFn: QueryFn;
    try {
      queryFn = this.options.query ?? (await loadQuery());
    } catch (error) {
      throw unavailable(`cannot load the Claude Agent SDK: ${(error as Error).message}`);
    }
    const run: Run = {
      inbox: new Inbox(),
      query: undefined,
      child: undefined,
      exited: Promise.resolve(),
      gone: undefined,
      initialized: false,
      initWaiters: [],
    };
    const { permissionMode } = sessionPolicy(this.settings);
    const canUseTool: CanUseTool = (toolName, input, context) =>
      this.canUseTool(run, toolName, input, context) as Promise<PermissionResult>;
    const options: Options = {
      cwd: this.cwd,
      model: sessionModel(this.settings, this.config),
      permissionMode,
      settingSources: [],
      includePartialMessages: true,
      canUseTool,
      env: childEnv(this.config),
      stderr: (data) => this.log(`claude stderr: ${data.trimEnd().slice(0, 2000)}`),
      // stdio is piped, so stdin and stdout are never null.
      spawnClaudeCodeProcess: (spawnOptions) => this.spawn(run, spawnOptions) as SpawnedProcess,
    };
    if (permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    const executable = executablePath(this.config);
    if (executable !== undefined) options.pathToClaudeCodeExecutable = executable;
    if (this.config.attachmentsDir !== undefined) options.additionalDirectories = [this.config.attachmentsDir];
    if (this.sessionId !== '') options.resume = this.sessionId;
    try {
      run.query = queryFn({ prompt: run.inbox, options });
    } catch (error) {
      throw unavailable((error as Error).message);
    }
    this.run = run;
    void this.pump(run);
    return run;
  }

  private spawn(run: Run, options: SpawnOptions): ChildProcess {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    run.child = child;
    run.exited = new Promise((resolve) => child.once('close', () => resolve()));
    child.stderr!.on('data', (chunk: Buffer) => this.log(`claude stderr: ${String(chunk).trimEnd().slice(0, 2000)}`));
    child.once('error', (error) => this.lost(run, `cannot run ${options.command}: ${error.message}`));
    child.once('exit', (code, signal) => {
      const reason = signal ? `Claude Code killed by ${signal}` : `Claude Code exited with code ${code}`;
      // Messages still buffered in stdout are read first; the loss is reported on close or after a moment.
      child.once('close', () => this.lost(run, reason));
      setTimeout(() => this.lost(run, reason), EXIT_GRACE_MS).unref();
    });
    // The SDK aborts after its graceful close: end the whole group, not just the leader.
    options.signal?.addEventListener('abort', () => child.pid !== undefined && signalGroup(child.pid, 'SIGTERM'), { once: true });
    return child;
  }

  private async pump(run: Run): Promise<void> {
    let reason = 'the Claude Code query ended';
    try {
      for await (const message of run.query!) {
        if (run.gone !== undefined) return;
        this.onMessage(run, message as unknown as Json);
      }
    } catch (error) {
      reason = `the Claude Code query failed: ${(error as Error).message}`;
    }
    if (run.gone !== undefined) return;
    // A dying child reports its exit code shortly; without one the stream's end is the reason.
    setTimeout(() => this.lost(run, reason), run.child ? EXIT_GRACE_MS : 0).unref();
  }

  private initialized(run: Run): Promise<void> {
    if (run.gone !== undefined) return Promise.reject(unavailable(run.gone));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lost(run, `no system/init within ${this.config.requestTimeoutMs} ms`);
      }, this.config.requestTimeoutMs);
      timer.unref();
      run.initWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** The run ended without `kill()`: report it once, unless it is an old run or the adapter was killed. */
  private lost(run: Run, reason: string): void {
    if (run.gone !== undefined) return;
    void this.end(run, reason);
    if (this.run !== run || this.killed) return;
    this.run = undefined;
    this.denyAll(CANCEL_MESSAGE);
    this.turn = undefined;
    this.emit({ method: 'status/changed', params: { status: 'error' } });
    this.emit({ method: 'agent/exited', params: { reason } });
  }

  /** Closes a run: waiters reject, inbox and query close, the process group ends (SIGTERM, then SIGKILL). */
  private async end(run: Run, reason: string): Promise<void> {
    run.gone ??= reason;
    for (const waiter of run.initWaiters.splice(0)) waiter.reject(unavailable(run.gone));
    run.inbox.close();
    try {
      run.query?.close();
    } catch {
      // Already closed.
    }
    const child = run.child;
    if (!child || child.pid === undefined || !alive(child)) return;
    const pid = child.pid;
    signalGroup(pid, 'SIGTERM');
    const force = setTimeout(() => signalGroup(pid, 'SIGKILL'), this.config.killGraceMs);
    await run.exited;
    clearTimeout(force);
    // Children that ignored SIGTERM die with their group.
    signalGroup(pid, 'SIGKILL');
  }

  // ---- engine messages -------------------------------------------------------------------------

  private onMessage(run: Run, message: Json): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.onInit(run, message);
        else if (message.subtype === 'task_notification') this.onTaskNotification(message);
        return;
      case 'stream_event':
        if (message.parent_tool_use_id == null) this.onStreamEvent(obj(message.event));
        return;
      case 'assistant':
        if (message.parent_tool_use_id == null) this.onAssistant(obj(message.message));
        return;
      case 'user':
        if (message.parent_tool_use_id == null) this.onToolResults(obj(message.message));
        return;
      case 'result':
        return this.onResult(message);
      default:
        return;
    }
  }

  private onInit(run: Run, message: Json): void {
    const version = str(message.claude_code_version);
    this.log(`claude system/init session=${str(message.session_id)} version=${version} model=${str(message.model)}`);
    if (version !== '') this.options.onVersion?.(version);
    const sessionId = str(message.session_id);
    if (sessionId !== '' && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.emit({ method: 'engine/session', params: { engineSessionId: sessionId } });
    }
    run.initialized = true;
    for (const waiter of run.initWaiters.splice(0)) waiter.resolve();
  }

  /**
   * The running turn; without one the engine started a turn by itself (a background task reported in):
   * it is opened here, with the notifications that woke the engine as its first items.
   */
  private engineTurn(): TurnState | undefined {
    if (this.turn || this.killed) return this.turn;
    const turn = newTurn(true);
    this.turn = turn;
    this.log('claude engine-initiated turn');
    this.emit({ method: 'turn/started', params: {} });
    this.emit({ method: 'status/changed', params: { status: 'running' } });
    for (const item of this.notes.splice(0)) {
      this.emit({ method: 'item/started', params: { item } });
      this.emit({ method: 'item/completed', params: { item } });
    }
    return turn;
  }

  /** A background task settled: shown in the running turn, else kept for the turn it starts. */
  private onTaskNotification(message: Json): void {
    if (message.ambient === true || message.skip_transcript === true) return;
    const item = taskItem(message);
    if (!this.turn) {
      this.notes.push(item);
      return;
    }
    this.emit({ method: 'item/started', params: { item } });
    this.emit({ method: 'item/completed', params: { item } });
  }

  /** Raw API stream events: text and thinking deltas of the top-level assistant message. */
  private onStreamEvent(event: Json): void {
    const turn = this.engineTurn();
    if (!turn) return;
    if (event.type === 'message_start') {
      turn.messageId = str(obj(event.message).id);
      return;
    }
    const index = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'content_block_start') {
      const type = obj(event.content_block).type;
      if (type !== 'text' && type !== 'thinking') return;
      turn.streaming.push({
        itemId: newId('itm'),
        type: type === 'text' ? 'agentMessage' : 'reasoning',
        messageId: turn.messageId,
        index,
        text: '',
        started: false,
      });
      return;
    }
    if (event.type !== 'content_block_delta') return;
    const delta = obj(event.delta);
    const text = delta.type === 'text_delta' ? str(delta.text) : delta.type === 'thinking_delta' ? str(delta.thinking) : '';
    const item = turn.streaming.find((s) => s.messageId === turn.messageId && s.index === index);
    if (!item || text === '') return;
    if (!item.started) {
      item.started = true;
      this.emit({ method: 'item/started', params: { item: streamItem(item, 'inProgress') } });
    }
    item.text += text;
    this.emit({ method: 'item/delta', params: { itemId: item.itemId, field: 'text', delta: text } });
  }

  private onAssistant(message: Json): void {
    const turn = this.engineTurn();
    if (!turn) return;
    const messageId = str(message.id);
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = obj(raw);
      if (block.type === 'text' || block.type === 'thinking') {
        const type = block.type === 'text' ? 'agentMessage' : 'reasoning';
        const text = str(block.type === 'text' ? block.text : block.thinking);
        const at = turn.streaming.findIndex((s) => s.messageId === messageId && s.type === type);
        const item: StreamItem =
          at >= 0 ? turn.streaming.splice(at, 1)[0]! : { itemId: newId('itm'), type, messageId, index: -1, text: '', started: false };
        if (text === '' && !item.started) continue;
        item.text = text;
        if (!item.started) this.emit({ method: 'item/started', params: { item: streamItem(item, 'inProgress') } });
        this.emit({ method: 'item/completed', params: { item: streamItem(item, 'completed') } });
      } else if (block.type === 'tool_use') {
        const item = toolItem(block, this.cwd);
        turn.tools.set(item.itemId, item);
        this.emit({ method: 'item/started', params: { item } });
      }
    }
  }

  private onToolResults(message: Json): void {
    if (!Array.isArray(message.content) || !message.content.some((b) => obj(b).type === 'tool_result')) return;
    const turn = this.engineTurn();
    if (!turn) return;
    for (const raw of message.content) {
      const block = obj(raw);
      if (block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      const started = turn.tools.get(id);
      if (!started) continue;
      turn.tools.delete(id);
      this.emit({ method: 'item/completed', params: { item: completeToolItem(started, block) } });
    }
  }

  private onResult(result: Json): void {
    const turn = this.turn;
    this.log(
      `claude result subtype=${str(result.subtype)} is_error=${String(result.is_error)} turn=${turn ? (turn.engine ? 'engine' : 'host') : 'empty'}`,
    );
    // No turn: the engine ended one that produced no output at all, so there is nothing to show.
    if (!turn) return;
    // Requests the engine stopped waiting for are void now.
    for (const request of [...this.requests.values()]) {
      this.forget(request);
      request.resolve({ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true });
      this.emit({ method: 'request/withdrawn', params: { requestId: request.requestId } });
    }
    const end = toTurnEnd(result, turn.interrupted);
    // Items cut off by the end of the turn are closed with what they have.
    for (const item of turn.streaming) {
      if (item.started) this.emit({ method: 'item/completed', params: { item: streamItem(item, 'completed') } });
    }
    for (const item of turn.tools.values()) {
      this.emit({ method: 'item/completed', params: { item: { ...item, status: end.status === 'completed' ? 'completed' : 'failed' } } });
    }
    this.turn = undefined;
    this.emit({ method: 'usage/updated', params: { usage: toUsage(result.usage) } });
    this.emit({ method: 'turn/completed', params: end });
    this.emit({ method: 'status/changed', params: { status: 'idle' } });
  }

  // ---- approvals and questions -----------------------------------------------------------------

  private canUseTool(
    run: Run,
    toolName: string,
    input: Json,
    context: { signal?: AbortSignal; suggestions?: unknown; toolUseID: string; title?: string; decisionReason?: string },
  ): Promise<PermissionAnswer> {
    if (this.killed || run !== this.run || run.gone !== undefined || !this.engineTurn()) {
      return Promise.resolve({ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true });
    }
    const existing = [...this.requests.values()].find((r) => r.toolUseID === context.toolUseID);
    if (existing) return existing.promise;
    const requestId = newId('req');
    const mapped = toRequest(requestId, toolName, input, { ...context, cwd: this.cwd });
    let resolve!: (answer: PermissionAnswer) => void;
    const promise = new Promise<PermissionAnswer>((r) => (resolve = r));
    const request: PendingRequest = {
      requestId,
      toolUseID: context.toolUseID,
      kind: mapped.event.method === 'input/request' ? 'input' : 'approval',
      input,
      suggestions: context.suggestions,
      questions: mapped.questions,
      resolve,
      promise,
    };
    this.requests.set(requestId, request);
    context.signal?.addEventListener(
      'abort',
      () => {
        if (this.requests.get(requestId) !== request) return;
        this.forget(request);
        resolve({ behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true });
        this.emit({ method: 'request/withdrawn', params: { requestId } });
      },
      { once: true },
    );
    if (mapped.event.method === 'input/request') {
      this.emit({ method: 'input/request', params: { request: mapped.event.request } });
    } else {
      this.emit({ method: 'approval/request', params: { request: mapped.event.request } });
    }
    return promise;
  }

  private take(requestId: string, kind: PendingRequest['kind']): PendingRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request || request.kind !== kind) return undefined;
    this.forget(request);
    return request;
  }

  private forget(request: PendingRequest): void {
    this.requests.delete(request.requestId);
  }

  /** Answers every open canUseTool call with a denial (the run or the adapter is going away). */
  private denyAll(message: string): void {
    for (const request of this.requests.values()) request.resolve({ behavior: 'deny', message, interrupt: true });
    this.requests.clear();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Silent after `kill()`: it clears the listeners. */
  private emit(event: AdapterEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function newTurn(engine: boolean): TurnState {
  return { engine, interrupted: false, messageId: '', streaming: [], tools: new Map() };
}

/** Longest task summary shown in a "background task" item's name. */
const TASK_SUMMARY_MAX = 120;

/** A system/task_notification as a finished toolCall item: "background task: <summary>". */
function taskItem(message: Json): AdapterItem {
  const summary = str(message.summary).replace(/\s+/g, ' ').trim();
  const short = summary.length > TASK_SUMMARY_MAX ? `${summary.slice(0, TASK_SUMMARY_MAX - 1).trimEnd()}…` : summary;
  const status = str(message.status);
  const item: AdapterItem = {
    itemId: newId('itm'),
    type: 'toolCall',
    status: status === 'failed' ? 'failed' : 'completed',
    tool: short === '' ? 'background task' : `background task: ${short}`,
    arguments: { taskId: str(message.task_id), status, summary },
  };
  if (status === 'failed') item.error = summary === '' ? 'the background task failed' : summary;
  return item;
}

function streamItem(item: StreamItem, status: 'inProgress' | 'completed'): AdapterItem {
  return item.type === 'agentMessage'
    ? { itemId: item.itemId, type: 'agentMessage', status, text: item.text }
    : { itemId: item.itemId, type: 'reasoning', status, summary: '', text: item.text };
}
