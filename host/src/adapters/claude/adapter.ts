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
// settings.effort goes in as the SDK's `effort` option, first fitted to the model's supportedEffortLevels
// the way Claude Code downgrades it (mapping.ts fitEffort), and left out for a model without effort control.
// Claude Code reports no applied level (probed with SDK 0.3.308 and Claude Code 2.1.308: system/init has
// no `effort` in SDK runs, and Query has no get_settings call), so the fitted level is what the session
// reports, and nothing when settings.effort is unset.
// Settings changes (spec 6 session/settings/update): changeSettings only stores them. Before the next user
// message that starts a turn (never during one, also not an engine-initiated one), the running query gets
// Query.setModel(model) and Query.applyFlagSettings({effortLevel}) for what differs from what it runs
// with (effortLevel null when the new model has no effort control: back to its default). Both are
// control requests that work on a live query in streaming-input mode (sdk.d.ts of SDK 0.3.308), so the
// effort needs no new query. Verified live on 2026-10-24 (live-settings.test.ts): a session on haiku
// switched to opus between turns, and the assistant messages named claude-haiku-5-5, then claude-opus-5-5.
// A query opened later (first turn, or a resume after the process died) starts with them as options.
//
// Supervision: the adapter spawns the Claude Code executable itself (spawnClaudeCodeProcess), detached in
// its own process group. When it dies on its own the adapter emits `status/changed {error}` and
// `agent/exited`; calls waiting on it reject with `agent_unavailable`; the next call starts a new query
// that resumes the session. `kill()` ends the process group, closes the inbox and the query, and silences
// the adapter for good.
//
// Hangs: a Claude Code process can stop answering while its pid lives on (seen 2026-10-23: main thread
// stuck in a synchronous openat(), children no longer reaped), so the exit never comes. Two guards end
// such a run the same way a death does, and the next turn resumes the session (--resume):
// - the watchdog: from a user message handed to the engine until the turn's `result`, requestTimeoutMs of
//   silence (no engine message of any kind) ends the run, unless the silence is expected: a tool is in
//   progress (long tools are quiet for minutes) or an approval or question waits on the user. While a
//   background task the engine runs has not reported in, the limit is backgroundQuietMs instead (default
//   10 minutes): such a task can keep the engine busy for a while, but a session with a long-lived
//   Monitor must not lose hang detection.
//   A live repro (2026-10-24, SDK 0.3.308, Claude Code 2.1.308) answered a message sent while background
//   subagents ran and the main thread was idle in 1-2 s, and folded one sent during a turn in at the next
//   tool boundary; the earlier belief that Claude Code holds such a message silently did not reproduce.
//   Before the first system/init of a query, the init timeout owns the wait instead;
// - interrupt(): Query.interrupt() gets requestTimeoutMs to answer; without an answer the turn ends
//   interrupted and the run ends, so Stop always settles.
//
// Background tasks (capabilities.backgroundTasks, `background/changed`; the hang watchdog reads the same
// set) come from the engine's own task events: system/task_started with is_backgrounded true adds a task
// (id: its tool_use id, title: the launching tool input's description); one registered in the foreground
// (is_backgrounded false) joins once task_updated {is_backgrounded: true} or the live set says it moved;
// task_updated with a final status (completed, failed, killed) or system/task_notification (completed:
// finished, failed: failed, stopped: cancelled) ends it; system/background_tasks_changed, the engine's
// full live set, adds a task it lists and ends a running one it no longer lists (cancelled, corrected by a
// notification that comes later). Pairing a launching call with its result (an Agent/Task call with
// run_in_background, a Bash result naming backgroundTaskId, a Monitor's taskId) is only the fallback for
// a task none of these announced. The latest system/task_progress line of a task is its activity.
// Query.interrupt() stops the background subagents too (live run below), and their notifications then
// say stopped. A run that ends reports its running tasks ended before it is cleared: cancelled on kill()
// or when Stop ended it, failed when it was lost. Ended tasks stay listed until the next turn starts.
// Every user message carries its clientMessageId as the SDK uuid; the first top-level reply stamped with
// it as user_message_uuid is `input/taken`.
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
// Verified by a background-task repro (2026-10-24, SDK 0.3.308, Claude Code 2.1.308, model haiku; a raw
// query() script, results in the commit message that added background tasks) and by
// live-background.test.ts through this adapter (launch, activity, input/taken, Stop cancels):
// - an Agent call with run_in_background: tool_use, then system/background_tasks_changed and
//   system/task_started (tool_use_id, description, is_backgrounded true), then the tool result
//   {status: async_launched, agentId}; the turn ends at once;
// - while it runs: one system/task_progress per subagent tool call (tool_use_id, description "Running
//   <the tool's description>", last_tool_name, usage; `summary` only with agentProgressSummaries, and none
//   came in 60 s with it on), the subagent's own messages (parent_tool_use_id set), and at the end
//   task_updated (patch.status), task_notification and background_tasks_changed;
// - a user message while the main thread is idle is answered at once (PONG after 1.2 to 1.6 s), stamped
//   with its uuid as user_message_uuid on the first assistant message; while the main thread is in a turn
//   it is folded in at the next tool boundary (4.3 s in the repro), so a long foreground tool holds it;
// - Query.interrupt() with the main thread idle answered in 23 ms and killed the background subagent
//   (task_updated status killed, task_notification status stopped); the next message ran normally;
// Verified by raw query() repros of Bash calls (2026-10-24, same versions, haiku; the cases of the
// "Brainstorm-BROCODE" session, testing/brainstorm-fixture.ts):
// - a Bash call without run_in_background that runs past about 3 s: task_started (is_backgrounded false,
//   task_type local_bash) and, when it finishes in the foreground, task_notification completed just
//   before its ordinary tool result; no background_tasks_changed. Such a call is no background task, and
//   its notification is not shown as one;
// - one that runs past its timeout: background_tasks_changed listing it, task_updated {is_backgrounded:
//   true} (or, timing out before the 3 s registration, task_started is_backgrounded true), then the tool
//   result naming backgroundTaskId;
// - TaskStop of it: task_updated {status: killed}, task_notification stopped, background_tasks_changed [];
// - priority 'now' on a user message aborts a running main turn (result success, empty) and answers the
//   message at once; the adapter does not use it.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type {
  CanUseTool,
  EffortLevel,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';

import type { BackgroundTask, Decision, Settings } from '../../generated/common.js';
import type { Adapter, AdapterEvent, AdapterInputPart, AdapterItem, AdapterListener } from '../../core/adapter.js';
import { newId } from '../../core/ids.js';
import { claudeConfig, type ClaudeConfig } from '../../config/claude.js';
import { RpcError } from '../../errors.js';
import {
  CANCEL_MESSAGE,
  childEnv,
  completeToolItem,
  fitEffort,
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
export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'close' | 'supportedModels' | 'setModel' | 'applyFlagSettings'>;

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
  /**
   * The effort levels of a model as the engine listed them: [] for a model without effort control,
   * undefined while the model is not known (the request then goes through as it is).
   */
  efforts?: (model: string) => readonly string[] | undefined;
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
  /** A user message was handed to the engine and no `result` came since: its silence is watched. */
  watching: boolean;
  /** The hang watchdog, re-armed by every engine message. */
  watchdog: NodeJS.Timeout | undefined;
  /** Agent/Task/Bash/Monitor tool calls waiting for their result, by tool_use id. */
  launching: Map<string, Launch>;
  /** Background tasks running, in the order they joined. */
  background: RunningTask[];
  /** Tasks the engine registered in the foreground (task_started is_backgrounded false), by task id. */
  foreground: Map<string, RunningTask>;
  /** Task ids and tool_use ids of the tasks that ended in this run: never listed again. */
  settled: Set<string>;
  /** Tasks ended because the live set no longer listed them, by task id: a later notification corrects them. */
  reconciled: Map<string, BackgroundTask>;
  /** The model and effort the query runs with (its options, then setModel and applyFlagSettings). */
  applied: { model: string; effort: EffortLevel | undefined };
}

/** A tool call that may launch a background task, until its result says. */
interface Launch {
  /** The input asked for the background (or the tool always runs there). */
  asked: boolean;
  title: string;
  startedAt: number;
}

/** A background task the engine runs. */
interface RunningTask {
  /** The engine's task id ('' while unknown). */
  taskId: string;
  /** The launching tool_use id ('' while unknown): the protocol id, else the task id. */
  toolUseId: string;
  title: string;
  startedAt: number;
  lastActivity?: string;
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
  /** Background tasks that ended since the newest turn started (still listed for the phone). */
  private ended: BackgroundTask[] = [];
  /** The list last reported with `background/changed` (JSON), to report changes only. */
  private published = '[]';
  /** clientMessageIds of user messages pushed and not yet answered (`input/taken`). */
  private untaken = new Set<string>();
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
  async turnStart(input: AdapterInputPart[], clientMessageId: string): Promise<void> {
    const content = await toUserContent(input);
    const run = await this.ready();
    // A settings change reaches the engine only between turns.
    if (!this.turn) await this.applySettings(run);
    // During an engine-initiated turn the message joins it: Claude Code delivers it mid-turn.
    if (!this.turn) {
      this.turn = newTurn(false);
      this.notes = [];
      this.newTurnStarted();
    }
    this.emit({ method: 'status/changed', params: { status: 'running' } });
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: content as SDKUserMessage['message']['content'] }, parent_tool_use_id: null };
    if (UUID.test(clientMessageId)) {
      message.uuid = clientMessageId as SDKUserMessage['uuid'] & string;
      this.untaken.add(clientMessageId);
    }
    run.inbox.push(message);
    run.watching = true;
    this.touch(run);
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
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.config.requestTimeoutMs);
      timer.unref();
    });
    const answered = await Promise.race([run.query.interrupt().then(() => true as const), timeout]).finally(() => clearTimeout(timer));
    if (answered) return;
    const reason = `${HUNG}: Stop was not answered within ${seconds(this.config.requestTimeoutMs)}`;
    this.log(`claude ${reason}`);
    // The turn ends as the user asked; then the run ends like a lost one.
    if (this.turn === turn && this.run === run && !this.killed) {
      this.turn = undefined;
      this.emit({ method: 'turn/completed', params: { status: 'interrupted' } });
    }
    this.lost(run, reason, 'cancelled');
    throw unavailable(reason);
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
    // Its background tasks end with it, reported while the host still listens (spec 5.1).
    if (!this.killed && this.run) this.endAll(this.run, 'cancelled');
    this.killed = true;
    this.listeners.clear();
    await this.opening?.catch(() => {});
    this.denyAll(CANCEL_MESSAGE);
    this.turn = undefined;
    this.notes = [];
    this.ended = [];
    this.untaken.clear();
    const run = this.run;
    this.run = undefined;
    if (run) await this.end(run, 'killed by the host');
  }

  /** A settings change (spec 6): stored; the next turn start hands it to the query (applySettings). */
  changeSettings(settings: Settings): void {
    this.settings = settings;
  }

  /** Brings the running query to the session's model and effort, for what differs. */
  private async applySettings(run: Run): Promise<void> {
    const query = run.query;
    if (!query) return;
    const model = sessionModel(this.settings, this.config);
    const effort = this.effort();
    try {
      if (model !== run.applied.model) {
        await query.setModel(model);
        run.applied.model = model;
        this.log(`claude: model changed to ${model}`);
      }
      if (effort !== run.applied.effort) {
        await query.applyFlagSettings({ effortLevel: effort ?? null });
        run.applied.effort = effort;
        this.log(`claude: effort changed to ${effort ?? 'the model default'}`);
      }
    } catch (error) {
      throw unavailable(`cannot change the session settings: ${(error as Error).message}`);
    }
  }

  /** The settings the session runs with: `model` and `approvalMode` as mapped (spec 5.1 Session.settings). */
  effectiveSettings(): Settings {
    const settings: Settings = { model: sessionModel(this.settings, this.config), approvalMode: sessionPolicy(this.settings).approvalMode };
    const effort = this.effort();
    if (effort !== undefined) settings.effort = effort;
    return settings;
  }

  /** The effort the session runs at: settings.effort fitted to the model's levels (spec 5.1). */
  private effort(): EffortLevel | undefined {
    const model = sessionModel(this.settings, this.config);
    return fitEffort(this.settings.effort, this.options.efforts?.(model));
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
      watching: false,
      watchdog: undefined,
      launching: new Map(),
      background: [],
      foreground: new Map(),
      settled: new Set(),
      reconciled: new Map(),
      applied: { model: sessionModel(this.settings, this.config), effort: this.effort() },
    };
    const { permissionMode } = sessionPolicy(this.settings);
    const canUseTool: CanUseTool = (toolName, input, context) =>
      this.canUseTool(run, toolName, input, context) as Promise<PermissionResult>;
    const options: Options = {
      cwd: this.cwd,
      model: run.applied.model,
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
    if (run.applied.effort !== undefined) options.effort = run.applied.effort;
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

  /**
   * The run ended without `kill()`: report it once, unless it is an old run or the adapter was killed.
   * Its background tasks end with it (`tasks`: failed, or cancelled when Stop ended the run).
   */
  private lost(run: Run, reason: string, tasks: 'failed' | 'cancelled' = 'failed'): void {
    if (run.gone !== undefined) return;
    const current = this.run === run && !this.killed;
    // Reported before the run is cleared, so the host journals the end.
    if (current) this.endAll(run, tasks);
    void this.end(run, reason);
    if (!current) return;
    this.run = undefined;
    this.untaken.clear();
    this.denyAll(CANCEL_MESSAGE);
    this.turn = undefined;
    this.emit({ method: 'status/changed', params: { status: 'error' } });
    this.emit({ method: 'agent/exited', params: { reason } });
  }

  /** Closes a run: waiters reject, inbox and query close, the process group ends (SIGTERM, then SIGKILL). */
  private async end(run: Run, reason: string): Promise<void> {
    run.gone ??= reason;
    clearTimeout(run.watchdog);
    run.watchdog = undefined;
    run.background.length = 0;
    run.foreground.clear();
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
    // Any output shows the engine alive; a `result` ends the wait for the user message.
    if (message.type === 'result') run.watching = false;
    // A Bash call that runs a few seconds is registered as a task without leaving the foreground; its
    // notification is no background task's report (the command item already shows the result).
    const foregroundOnly = message.type === 'system' && message.subtype === 'task_notification' && run.foreground.has(str(message.task_id));
    // After trackBackground: the silence limit depends on the background tasks this message leaves.
    this.trackBackground(run, message);
    this.touch(run);
    this.trackTaken(message);
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.onInit(run, message);
        else if (message.subtype === 'task_notification' && !foregroundOnly) this.onTaskNotification(message);
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
    this.touch(run);
  }

  // ---- hang watchdog ---------------------------------------------------------------------------

  /** Re-arms the watchdog while a user message waits on an initialized, live run; else disarms it. */
  private touch(run: Run): void {
    clearTimeout(run.watchdog);
    run.watchdog = undefined;
    if (!run.watching || !run.initialized || run.gone !== undefined || run !== this.run || this.killed) return;
    const limit = this.silenceLimit(run);
    run.watchdog = setTimeout(() => this.bark(run, limit), limit);
    run.watchdog.unref();
  }

  /**
   * How long the engine may stay silent from now: backgroundQuietMs while background tasks run and
   * nothing in the foreground is pending (a foreground tool or a request re-arms at requestTimeoutMs).
   */
  private silenceLimit(run: Run): number {
    if (this.quietReason() === undefined && run.background.length > 0) return this.config.backgroundQuietMs;
    return this.config.requestTimeoutMs;
  }

  /** `limit` ms of silence: a hang, unless the engine has a reason to be quiet. */
  private bark(run: Run, limit: number): void {
    run.watchdog = undefined;
    if (!run.watching || run.gone !== undefined || run !== this.run || this.killed) return;
    const quiet = this.quietReason();
    if (quiet !== undefined) {
      this.log(`claude silent for ${seconds(limit)} while ${quiet}; still waiting`);
      this.touch(run);
      return;
    }
    const tasks = run.background.length > 0 ? ` while ${run.background.length} background task(s) run` : '';
    const reason = `${HUNG}: no output for ${seconds(limit)} after a message${tasks}`;
    this.log(`claude ${reason}`);
    this.lost(run, reason);
  }

  /** Why silence in the foreground is expected now, or undefined when it means a hang. */
  private quietReason(): string | undefined {
    if ((this.turn?.tools.size ?? 0) > 0) return 'a tool is in progress';
    if (this.requests.size > 0) return 'a request waits on the user';
    return undefined;
  }

  /**
   * Keeps run.background from the engine's own task events (SDK 0.3.308): system/task_started with
   * is_backgrounded adds a task (one started in the foreground joins once task_updated or the live set
   * says it moved to the background); task_updated with a final status or task_notification ends it;
   * system/background_tasks_changed, the engine's full live set, adds what it lists and ends what it no
   * longer lists. Launch pairing (an Agent/Task call with run_in_background or a Bash or Monitor call whose
   * result says it went to the background) is the fallback for a task the engine announced in none of
   * these. system/task_progress of a task updates its activity. Every change is published.
   */
  private trackBackground(run: Run, message: Json): void {
    if (message.parent_tool_use_id != null) return;
    if (message.type === 'assistant') {
      for (const raw of list(obj(message.message).content)) {
        const block = obj(raw);
        const name = str(block.name);
        if (block.type !== 'tool_use' || !BACKGROUND_TOOLS.has(name)) continue;
        const input = obj(block.input);
        run.launching.set(str(block.id), { asked: ALWAYS_BACKGROUND.has(name) || input.run_in_background === true, title: taskTitle(name, input), startedAt: nowSeconds() });
      }
    } else if (message.type === 'user') {
      this.pairLaunches(run, message);
    } else if (message.type === 'system') {
      switch (message.subtype) {
        case 'task_started':
          return this.onTaskStarted(run, message);
        case 'task_updated':
          return this.onTaskUpdated(run, message);
        case 'task_notification':
          return this.settle(run, str(message.task_id), str(message.tool_use_id), TASK_END[str(message.status)] ?? 'finished');
        case 'background_tasks_changed':
          return this.onLiveSet(run, list(message.tasks).map(obj));
        case 'task_progress': {
          const task = this.taskOf(run, str(message.task_id), str(message.tool_use_id));
          const activity = oneLine(str(message.summary) || str(message.description));
          if (task === undefined || activity === '' || task.lastActivity === activity) return;
          task.lastActivity = activity;
          this.publish(run);
          return;
        }
        default:
          return;
      }
    }
  }

  /** The fallback: a launching call's result confirms a background task the engine did not announce. */
  private pairLaunches(run: Run, message: Json): void {
    const results = list(obj(message.message).content).map(obj).filter((b) => b.type === 'tool_result');
    const output = obj(message.tool_use_result);
    let changed = false;
    for (const block of results) {
      const id = str(block.tool_use_id);
      const launch = run.launching.get(id);
      if (launch === undefined) continue;
      run.launching.delete(id);
      // tool_use_result belongs to the message's tool result; with several, only the input tells.
      const taskId = results.length === 1 ? str(output.agentId) || str(output.backgroundTaskId) || str(output.taskId) : '';
      const launched = output.status === 'async_launched' || str(output.backgroundTaskId) !== '';
      if (!(launch.asked || (results.length === 1 && launched)) || block.is_error === true) continue;
      // Already listed from the engine's own events, or already ended.
      if (run.settled.has(id) || (taskId !== '' && run.settled.has(taskId)) || this.taskOf(run, taskId, id) !== undefined) continue;
      const registered = taskId === '' ? undefined : run.foreground.get(taskId);
      run.foreground.delete(taskId);
      run.background.push({ taskId, toolUseId: id, title: launch.title, startedAt: registered?.startedAt ?? launch.startedAt });
      changed = true;
    }
    if (changed) this.publish(run);
  }

  /** system/task_started: a background task joins; a foreground one is remembered until it moves there. */
  private onTaskStarted(run: Run, message: Json): void {
    const taskId = str(message.task_id);
    const toolUseId = str(message.tool_use_id);
    if (taskId === '' || !ownTask(message) || run.settled.has(taskId)) return;
    const known = this.taskOf(run, taskId, toolUseId);
    if (known !== undefined) {
      // Listed from the live set (or the fallback) before: now it has both ids.
      if (known.toolUseId !== '' && known.taskId !== '') return;
      known.toolUseId ||= toolUseId;
      known.taskId ||= taskId;
      this.publish(run);
      return;
    }
    const launch = run.launching.get(toolUseId);
    const task: RunningTask = {
      taskId,
      toolUseId,
      title: launch?.title ?? (oneLine(str(message.description)) || str(message.task_type) || 'Background task'),
      startedAt: launch?.startedAt ?? nowSeconds(),
    };
    if (message.is_backgrounded !== true) {
      run.foreground.set(taskId, task);
      return;
    }
    run.background.push(task);
    this.publish(run);
  }

  /** system/task_updated: a final status ends the task; is_backgrounded moves a foreground one to the list. */
  private onTaskUpdated(run: Run, message: Json): void {
    const taskId = str(message.task_id);
    const patch = obj(message.patch);
    const status = UPDATE_END[str(patch.status)];
    if (status !== undefined) return this.settle(run, taskId, '', status);
    const registered = run.foreground.get(taskId);
    if (patch.is_backgrounded !== true || registered === undefined) return;
    run.foreground.delete(taskId);
    run.background.push(registered);
    this.publish(run);
  }

  /**
   * system/background_tasks_changed: the engine's whole live set. A task it lists joins (named by its
   * pending launch when one call carries the same title); a running task it no longer lists has ended,
   * as cancelled unless its notification says otherwise later.
   */
  private onLiveSet(run: Run, entries: Json[]): void {
    const live = new Set(entries.map((entry) => str(entry.task_id)).filter((id) => id !== ''));
    let changed = false;
    for (const entry of entries) {
      const taskId = str(entry.task_id);
      if (taskId === '' || !ownTask(entry) || run.settled.has(taskId) || run.background.some((t) => t.taskId === taskId)) continue;
      const registered = run.foreground.get(taskId);
      run.foreground.delete(taskId);
      const title = oneLine(str(entry.description));
      const launches = [...run.launching].filter(([id, launch]) => launch.title === title && !run.background.some((t) => t.toolUseId === id));
      const [toolUseId, launch] = launches.length === 1 ? launches[0]! : ['', undefined];
      run.background.push(
        registered ?? { taskId, toolUseId, title: title || str(entry.task_type) || 'Background task', startedAt: launch?.startedAt ?? nowSeconds() },
      );
      changed = true;
    }
    for (const task of [...run.background]) {
      if (task.taskId === '' || live.has(task.taskId)) continue;
      run.background.splice(run.background.indexOf(task), 1);
      const ended = endedTask(task, 'cancelled');
      this.ended.push(ended);
      run.reconciled.set(task.taskId, ended);
      this.markSettled(run, task);
      changed = true;
    }
    if (changed) this.publish(run);
  }

  /** A task ended (task_updated, task_notification): out of the list's running part, into its ended part. */
  private settle(run: Run, taskId: string, toolUseId: string, status: BackgroundTask['status']): void {
    if (taskId !== '') run.foreground.delete(taskId);
    const task = this.taskOf(run, taskId, toolUseId);
    if (task === undefined) {
      // Ended by the live set before its notification came: the notification's status wins.
      const ended = run.reconciled.get(taskId);
      run.reconciled.delete(taskId);
      if (ended === undefined || ended.status === status) return;
      ended.status = status;
      this.publish(run);
      return;
    }
    run.background.splice(run.background.indexOf(task), 1);
    this.markSettled(run, task);
    this.ended.push(endedTask(task, status));
    this.publish(run);
  }

  /** Every running task of the run ends with `status` (the run is going away), and the list is reported. */
  private endAll(run: Run, status: BackgroundTask['status']): void {
    for (const task of run.background.splice(0)) {
      this.markSettled(run, task);
      this.ended.push(endedTask(task, status));
    }
    run.foreground.clear();
    this.publish(run);
  }

  private markSettled(run: Run, task: RunningTask): void {
    if (task.taskId !== '') run.settled.add(task.taskId);
    if (task.toolUseId !== '') run.settled.add(task.toolUseId);
  }

  /** The running background task with this tool_use id, else with this task id. */
  private taskOf(run: Run, taskId: string, toolUseId: string): RunningTask | undefined {
    return (
      (toolUseId === '' ? undefined : run.background.find((t) => t.toolUseId === toolUseId)) ??
      (taskId === '' ? undefined : run.background.find((t) => t.taskId === taskId))
    );
  }

  /** Reports the background tasks (running ones of `run`, then the ended ones) when they changed. */
  private publish(run: Run | undefined): void {
    const running: BackgroundTask[] = (run?.background ?? []).map((task) => {
      const out: BackgroundTask = { id: taskIdOf(task), title: task.title, status: 'running', startedAt: task.startedAt };
      if (task.lastActivity !== undefined) out.lastActivity = task.lastActivity;
      return out;
    });
    const tasks = [...running, ...this.ended];
    const json = JSON.stringify(tasks);
    if (json === this.published || this.killed) return;
    this.published = json;
    this.emit({ method: 'background/changed', params: { tasks } });
  }

  /** A turn started: tasks that ended before it are no longer listed. */
  private newTurnStarted(): void {
    if (this.ended.length === 0) return;
    this.ended = [];
    this.publish(this.run);
  }

  /** The first top-level reply stamped with a pending message's uuid: the engine took that message. */
  private trackTaken(message: Json): void {
    if (this.untaken.size === 0 || message.parent_tool_use_id != null) return;
    if (message.type !== 'assistant' && message.type !== 'stream_event') return;
    const uuid = str(message.user_message_uuid);
    if (!this.untaken.delete(uuid)) return;
    this.emit({ method: 'input/taken', params: { clientMessageId: uuid } });
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
    this.newTurnStarted();
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

  /** The engine's answer to a request is due from now on: the watchdog counts from here. */
  private forget(request: PendingRequest): void {
    this.requests.delete(request.requestId);
    if (this.run) this.touch(this.run);
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

/** Start of every hang reason: the phone shows it as the turn error and the exit reason. */
export const HUNG = 'Claude stopped responding (restarted)';

/** Tools that can launch a background task. */
const BACKGROUND_TOOLS = new Set(['Agent', 'Task', 'Bash', 'Monitor']);
/** Tools whose calls always run in the background. */
const ALWAYS_BACKGROUND = new Set(['Monitor']);

/** How a task_notification status ends a task. */
const TASK_END: Record<string, BackgroundTask['status']> = { completed: 'finished', failed: 'failed', stopped: 'cancelled' };
/** How a task_updated patch.status ends a task. */
const UPDATE_END: Record<string, BackgroundTask['status']> = { completed: 'finished', failed: 'failed', killed: 'cancelled' };

/** A task's protocol id: its launching tool_use id, else the engine's task id. */
const taskIdOf = (task: RunningTask): string => task.toolUseId || task.taskId;

/** A task of the session's own (not a subagent's launch, not housekeeping the engine hides). */
const ownTask = (message: Json): boolean => message.ambient !== true && message.skip_transcript !== true && str(message.parent_task_id) === '';

/** A protocol clientMessageId (spec 7): a UUID, which the SDK takes as the message's uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest background task title and activity line. */
const TASK_LINE_MAX = 120;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Whitespace collapsed, cut at TASK_LINE_MAX characters. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TASK_LINE_MAX ? `${line.slice(0, TASK_LINE_MAX - 1).trimEnd()}…` : line;
}

/** A background task's title: the tool input's description, else the command or prompt, else the tool. */
function taskTitle(tool: string, input: Json): string {
  return oneLine(str(input.description)) || oneLine(str(input.command)) || oneLine(str(input.prompt)) || tool;
}

function endedTask(task: RunningTask, status: BackgroundTask['status']): BackgroundTask {
  const out: BackgroundTask = { id: taskIdOf(task), title: task.title, status, startedAt: task.startedAt, endedAt: Math.max(task.startedAt, nowSeconds()) };
  if (task.lastActivity !== undefined) out.lastActivity = task.lastActivity;
  return out;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

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
