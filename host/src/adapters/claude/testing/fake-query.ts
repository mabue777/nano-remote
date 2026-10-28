// A scripted stand-in for the Claude Agent SDK's query(), for the adapter's unit and end-to-end tests.
// It plays the message sequences the real engine sent in the host-drive spike (spikes/host-drive/logs)
// and the live test (live.test.ts): system/init once per user message (after it, never before),
// stream_event deltas then the complete assistant block, tool_use then canUseTool then tool_result, and a
// `result` with usage at the end of every turn (`error_during_execution` after an interrupt).
//
// Background tasks as the background-task repro saw them (adapter.ts): a tool result whose
// tool_use_result says async_launched (or names a backgroundTaskId, or a Monitor's taskId) starts a
// background task; interrupt() stops every one still running with task_updated killed and
// task_notification stopped, as Query.interrupt() did live. The first top-level assistant message after
// a user message with a uuid carries it as user_message_uuid.
//
// With `spawn` (the default) it asks the adapter's spawnClaudeCodeProcess for a real child (an idle node
// process), so process groups, exits and kills are real; the query fails when that child dies, like the SDK.
//
//   const fake = new FakeClaude({ turns: [[{ tool: 'Bash', input: { command: 'ls' } }, { text: 'Done.' }]] });
//   new ClaudeAdapter({ query: fake.query, config });
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

import type { Options, PermissionMode, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeQuery, QueryFn } from '../adapter.js';

type Json = Record<string, unknown>;

/** One step of a scripted turn. */
export type FakeClaudeStep =
  /** An assistant text block: stream events (one delta per chunk) when partial messages are on, then the block. */
  | { text: string; chunks?: number }
  /** An assistant thinking block, streamed the same way. */
  | { thinking: string }
  /**
   * A tool call: the tool_use block, then canUseTool (unless `ask` is false or the permission mode skips it),
   * then the tool_result (`result` text, `isError`). A denial becomes an error tool_result; one with
   * `interrupt` ends the turn.
   */
  | { tool: string; input?: Json; id?: string; result?: string; isError?: boolean; suggestions?: unknown[]; ask?: boolean }
  /** Send this SDK message as is. */
  | { message: Json }
  /** Wait until `release()` or an interrupt. */
  | { hold: true }
  /** The child process dies (SIGKILL), or without a child the query fails. */
  | { exit: true }
  /** End the turn with an error result. */
  | { fail: { subtype: string; errors?: string[]; isError?: boolean } };

export type FakeClaudeTurn = FakeClaudeStep[];

/** Picks a turn's steps from its text and its number (0-based, counted per FakeClaude across queries). */
export type FakeClaudeScript = (text: string, index: number) => FakeClaudeTurn;

export interface FakeClaudeOptions {
  turns?: FakeClaudeTurn[] | FakeClaudeScript;
  /** What supportedModels() answers, or an Error it rejects with. */
  models?: unknown[] | Error;
  /** Spawn a real child through options.spawnClaudeCodeProcess (default true). */
  spawn?: boolean;
  /** Never send system/init nor play turns (an engine that does not accept its messages). */
  noInit?: boolean;
  /** Turn numbers (as in FakeClaudeScript) the engine takes and never answers: no init, no output (a hung engine). */
  hang?: number[];
  /** interrupt() never settles (a hung engine). */
  interruptHangs?: boolean;
  /** query() throws this instead of returning. */
  throwOnQuery?: string;
  /** setModel() and applyFlagSettings() reject with this message. */
  controlFails?: string;
  /** setPermissionMode() rejects with this message. */
  permissionModeFails?: string;
  /** The query has no setPermissionMode() (an older Agent SDK). */
  noSetPermissionMode?: boolean;
}

export interface PermissionCall {
  toolName: string;
  input: Json;
  toolUseID: string;
  answer: Json;
}

/** Default turn: answers "You said: <text>". */
export const echo: FakeClaudeScript = (text) => [{ text: `You said: ${text}` }];

/** The idle child: a node process that waits on its stdin. */
const CHILD_ARGS = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1 << 30)'];

export const FAKE_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'The account default' },
  { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work' },
  { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Efficient' },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'Fast' },
];

export class FakeClaude {
  readonly queries: FakeQuery[] = [];
  readonly options: FakeClaudeOptions;
  turnCount = 0;
  private readonly script: FakeClaudeScript;

  constructor(options: FakeClaudeOptions = {}) {
    this.options = options;
    const turns = options.turns ?? echo;
    this.script = typeof turns === 'function' ? turns : (text, index) => turns[index] ?? echo(text, index);
  }

  /** The QueryFn to inject. */
  readonly query: QueryFn = (params) => {
    if (this.options.throwOnQuery !== undefined) throw new Error(this.options.throwOnQuery);
    const query = new FakeQuery(this, params.prompt, params.options);
    this.queries.push(query);
    return query;
  };

  /** The newest query. */
  get last(): FakeQuery {
    const query = this.queries[this.queries.length - 1];
    if (!query) throw new Error('FakeClaude: no query yet');
    return query;
  }

  steps(text: string): FakeClaudeTurn {
    return [...this.script(text, this.turnCount++)];
  }
}

export class FakeQuery implements ClaudeQuery {
  readonly options: Options;
  /** The permission mode in effect: the option, then setPermissionMode. */
  permissionMode: PermissionMode | undefined;
  readonly sessionId: string;
  readonly userMessages: SDKUserMessage[] = [];
  readonly permissions: PermissionCall[] = [];
  child: ChildProcess | undefined;
  interrupts = 0;
  closed = false;
  private readonly fake: FakeClaude;
  private readonly out: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  private ended = false;
  private interrupted = false;
  private abort: AbortController | undefined;
  private holding: (() => void) | undefined;
  private readonly spawnAbort = new AbortController();
  private counter = 0;
  /** An engine-initiated turn is playing: user messages arriving now are taken mid-turn. */
  private engineBusy = false;
  /** User messages the engine took mid-turn (during an engine-initiated turn). */
  readonly midTurn: SDKUserMessage[] = [];
  /** Background tasks running: task id by launching tool_use id. */
  readonly background = new Map<string, string>();
  /** The uuid of the user message the next top-level assistant message answers. */
  private answering: string | undefined;
  /**
   * User messages and settings control requests in the order they reached the engine: `user: <text>`,
   * `setModel: <model>`, `applyFlagSettings: <json>`, `setPermissionMode: <mode>`.
   */
  readonly timeline: string[] = [];

  constructor(fake: FakeClaude, prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.fake = fake;
    this.options = options;
    this.permissionMode = options.permissionMode;
    this.sessionId = options.resume ?? randomUUID();
    if (fake.options.spawn !== false && options.spawnClaudeCodeProcess) {
      const child = options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: CHILD_ARGS,
        cwd: options.cwd,
        env: options.env ?? {},
        signal: this.spawnAbort.signal,
      }) as ChildProcess;
      this.child = child;
      child.once('exit', (code, signal) => this.fail(new Error(`Claude Code process exited with code ${code} signal ${signal}`)));
    }
    void this.consume(prompt);
  }

  /** Ends a `hold` step. */
  release(): void {
    const holding = this.holding;
    if (!holding) throw new Error('FakeQuery: no hold step is waiting');
    this.holding = undefined;
    holding();
  }

  get holdingNow(): boolean {
    return this.holding !== undefined;
  }

  /** Sends an SDK message now, outside any script. */
  send(message: Json): void {
    this.push(message as unknown as SDKMessage);
  }

  /**
   * Plays a turn the engine starts by itself, as Claude Code does when a background task reports in:
   * system/task_notification (unless `notification` is null), system/init, the steps, then `result`.
   * User messages pushed meanwhile are taken mid-turn (recorded in `midTurn`, no turn of their own).
   */
  async engineTurn(steps: FakeClaudeTurn, notification: Json | null = { summary: 'Monitor event' }): Promise<void> {
    this.engineBusy = true;
    try {
      if (notification) {
        this.send({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task_fake',
          status: 'completed',
          output_file: '/tmp/task_fake.out',
          summary: '',
          uuid: randomUUID(),
          session_id: this.sessionId,
          ...notification,
        });
      }
      this.sendInit();
      await this.playSteps(steps);
    } finally {
      this.engineBusy = false;
    }
  }

  /** Ends the message stream as the SDK does when its process is gone. */
  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.wake?.();
  }

  /** Ends the message stream without an error. */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async interrupt(): Promise<undefined> {
    this.interrupts += 1;
    if (this.fake.options.interruptHangs) return new Promise<never>(() => {});
    // Stop ends the background subagents and commands too (the live repro).
    for (const [toolUseId, taskId] of [...this.background]) {
      this.send({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'killed' } });
      this.send({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status: 'stopped', output_file: '', summary: '' });
    }
    this.interrupted = true;
    this.abort?.abort();
    const holding = this.holding;
    this.holding = undefined;
    holding?.();
    return undefined;
  }

  async setModel(model?: string): Promise<void> {
    if (this.fake.options.controlFails !== undefined) throw new Error(this.fake.options.controlFails);
    this.timeline.push(`setModel: ${model}`);
  }

  /**
   * Like Claude Code: the mode applies to the tool calls from now on, also in a running turn, and
   * bypassPermissions only in a session launched with allowDangerouslySkipPermissions.
   */
  get setPermissionMode(): ((mode: PermissionMode) => Promise<void>) | undefined {
    if (this.fake.options.noSetPermissionMode) return undefined;
    return async (mode) => {
      if (this.fake.options.permissionModeFails !== undefined) throw new Error(this.fake.options.permissionModeFails);
      if (mode === 'bypassPermissions' && !this.options.allowDangerouslySkipPermissions) {
        throw new Error('Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions');
      }
      this.timeline.push(`setPermissionMode: ${mode}`);
      this.permissionMode = mode;
    };
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    if (this.fake.options.controlFails !== undefined) throw new Error(this.fake.options.controlFails);
    this.timeline.push(`applyFlagSettings: ${JSON.stringify(settings)}`);
  }

  close(): void {
    this.closed = true;
    this.spawnAbort.abort();
    this.end();
  }

  async supportedModels(): Promise<never> {
    const models = this.fake.options.models ?? FAKE_MODELS;
    if (models instanceof Error) throw models;
    return models as never;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      while (this.out.length > 0) yield this.out.shift()!;
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }

  // Unused parts of AsyncGenerator are not needed: the adapter only iterates.

  private push(message: SDKMessage): void {
    if (this.ended || this.failure) return;
    this.observe(message as unknown as Json);
    this.out.push(message);
    this.wake?.();
  }

  /** Keeps `background` and stamps the reply to a user message, as the engine does. */
  private observe(message: Json): void {
    if (message.parent_tool_use_id != null) return;
    if (message.type === 'assistant' && this.answering !== undefined) {
      message.user_message_uuid = this.answering;
      this.answering = undefined;
    }
    if (message.type === 'user') {
      const output = (message.tool_use_result ?? {}) as Json;
      const taskId = String(output.agentId ?? output.backgroundTaskId ?? output.taskId ?? '');
      const block = ((message.message as Json | undefined)?.content as Json[] | undefined)?.[0];
      const launched = output.status === 'async_launched' || output.backgroundTaskId !== undefined || output.taskId !== undefined;
      if (launched && taskId !== '' && block?.type === 'tool_result') this.background.set(String(block.tool_use_id), taskId);
    }
    if (message.type === 'system' && message.subtype === 'task_notification') {
      for (const [toolUseId, taskId] of [...this.background]) {
        if (toolUseId === message.tool_use_id || taskId === message.task_id) this.background.delete(toolUseId);
      }
    }
  }

  private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) {
      if (this.ended || this.failure) return;
      this.userMessages.push(message);
      const said = message.message.content;
      this.timeline.push(`user: ${typeof said === 'string' ? said : JSON.stringify(said)}`);
      if (typeof message.uuid === 'string') this.answering = message.uuid;
      const content = message.message.content;
      const text = typeof content === 'string' ? content : '';
      // An engine that never accepts: no init, no turn.
      if (this.fake.options.noInit) continue;
      if (this.fake.options.hang?.includes(this.fake.turnCount)) {
        this.fake.turnCount += 1;
        continue;
      }
      if (this.engineBusy) {
        this.midTurn.push(message);
        continue;
      }
      this.sendInit();
      await this.playSteps(this.fake.steps(text));
    }
  }

  private sendInit(): void {
    this.send({
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      claude_code_version: '2.1.999',
      model: 'claude-opus-5-5',
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      tools: ['Bash', 'Write', 'Edit', 'AskUserQuestion'],
    });
  }

  private async playSteps(steps: FakeClaudeTurn): Promise<void> {
    this.interrupted = false;
    let reply = '';
    for (const step of steps) {
      if (this.ended || this.failure) return;
      if (this.interrupted) break;
      if ('text' in step) {
        reply = step.text;
        this.block('text', step.text, step.chunks ?? 2);
      } else if ('thinking' in step) {
        this.block('thinking', step.thinking, 2);
      } else if ('tool' in step) {
        await this.tool(step);
      } else if ('message' in step) {
        this.send(step.message);
      } else if ('hold' in step) {
        await new Promise<void>((resolve) => (this.holding = resolve));
      } else if ('exit' in step) {
        if (this.child) this.child.kill('SIGKILL');
        else this.fail(new Error('Claude Code process exited with code 1'));
        return;
      } else {
        this.send({
          type: 'result',
          subtype: step.fail.subtype,
          is_error: step.fail.isError ?? true,
          errors: step.fail.errors ?? [],
          usage: { input_tokens: 1, output_tokens: 0 },
        });
        return;
      }
    }
    if (this.interrupted) {
      this.send({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
        usage: { input_tokens: 2, output_tokens: 1 },
      });
      return;
    }
    this.send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: reply,
      usage: { input_tokens: 3, cache_creation_input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 7 },
    });
  }

  /** Resolves once the adapter has taken every queued message. */
  private async drained(): Promise<void> {
    while (this.out.length > 0) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  private messageId(): string {
    return `msg_fake_${++this.counter}`;
  }

  /** A text or thinking block: message_start, block start, deltas, block stop (if streaming), then the assistant message. */
  private block(type: 'text' | 'thinking', value: string, chunks: number): void {
    const id = this.messageId();
    if (this.options.includePartialMessages) {
      const stream = (event: Json): void => this.send({ type: 'stream_event', event, parent_tool_use_id: null });
      stream({ type: 'message_start', message: { id } });
      stream({ type: 'content_block_start', index: 0, content_block: type === 'text' ? { type, text: '' } : { type, thinking: '' } });
      const size = Math.max(1, Math.ceil(value.length / Math.max(1, chunks)));
      for (let i = 0; i < value.length; i += size) {
        const piece = value.slice(i, i + size);
        stream({
          type: 'content_block_delta',
          index: 0,
          delta: type === 'text' ? { type: 'text_delta', text: piece } : { type: 'thinking_delta', thinking: piece },
        });
      }
      stream({ type: 'content_block_stop', index: 0 });
    }
    const content = type === 'text' ? { type, text: value } : { type, thinking: value, signature: 'sig' };
    this.send({ type: 'assistant', message: { id, role: 'assistant', content: [content] }, parent_tool_use_id: null });
  }

  private async tool(step: Extract<FakeClaudeStep, { tool: string }>): Promise<void> {
    const id = step.id ?? `toolu_fake_${++this.counter}`;
    const input = step.input ?? {};
    this.send({
      type: 'assistant',
      message: { id: this.messageId(), role: 'assistant', content: [{ type: 'tool_use', id, name: step.tool, input }] },
      parent_tool_use_id: null,
    });
    // The engine writes the tool_use message before it asks: let the adapter read it first.
    await this.drained();
    const asks = step.ask !== false && this.permissionMode !== 'bypassPermissions' && this.options.canUseTool !== undefined;
    let answer: Json = { behavior: 'allow', updatedInput: input };
    if (asks) {
      this.abort = new AbortController();
      answer = (await this.options.canUseTool!(step.tool, input, {
        signal: this.abort.signal,
        suggestions: (step.suggestions ?? []) as never,
        toolUseID: id,
        requestId: `ctl_${id}`,
      })) as unknown as Json;
      this.abort = undefined;
      this.permissions.push({ toolName: step.tool, input, toolUseID: id, answer });
    }
    if (answer.behavior === 'deny') {
      this.send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(answer.message), is_error: true }] },
        parent_tool_use_id: null,
      });
      if (answer.interrupt === true) this.interrupted = true;
      return;
    }
    this.send({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: step.result ?? 'ok' }], is_error: step.isError === true }],
      },
      parent_tool_use_id: null,
    });
  }
}

/** Resolves when `check` returns a value other than undefined (polls every 10 ms, up to `ms`). */
export async function until<T>(check: () => T | undefined, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
