// The pi adapter: drives one pi session through `pi --mode rpc` (protocol-v1.md section 11, Phase 5b
// rulings R2 to R4). One pi process per session, started in the session's folder.
//
//   session/start  -> pi --mode rpc --no-extensions -e <Nano's approval extension> --session-id <new id>,
//                     then set_model {provider, modelId} when settings.model names `provider/id`, then
//                     set_thinking_level {level} when settings.effort is one of pi's levels (after the model:
//                     pi fits the level to the model it runs), then get_state for the model and level in effect
//   resume         -> the same command with the stored --session-id (pi reloads its session file)
//   turn/start     -> prompt {message, images} (attachments: images read from their path, files as a path line)
//   turn/steer     -> steer {message, images}
//   turn/interrupt -> open dialogs declined, clear_queue, abort
//   items          <- message_update text and thinking deltas, message_end, tool_execution_start/update/end
//   approvals      <- extension_ui_request confirm titled "nano-approval" (bash: command, write/edit:
//                     fileChange, other tools: permission); answered with extension_ui_response {confirmed}
//   questions      <- any other dialog (select, input, editor, a foreign confirm)
//   turn end       <- agent_settled (aborted: interrupted; an assistant error: failed)
//   usage          <- get_session_stats after every turn
//
// Sessions use `--session-id`, not `--session`: pi writes a session file only with the first message, and
// `--session <id>` exits with "No session found" for a session that never got one (probed with pi 1.3.0),
// while `--session-id` reloads an existing session and creates a missing one.
//
// Supervision: when pi dies on its own the adapter emits `status/changed {error}` and `agent/exited`;
// calls in flight reject with `agent_unavailable`. The next call starts a new pi process on the same
// session. `kill()` ends the process group and silences the adapter for good.
import { randomUUID } from 'node:crypto';

import type { Decision, Settings } from '../../generated/common.js';
import type { Adapter, AdapterEvent, AdapterInputPart, AdapterItem, AdapterListener } from '../../core/adapter.js';
import { newId } from '../../core/ids.js';
import { piConfig, type PiConfig } from '../../config/pi.js';
import { RpcError } from '../../errors.js';
import { PiEngine, unavailable } from './engine.js';
import {
  DIALOG_METHODS,
  approvalAnswer,
  dialogAnswer,
  finishToolItem,
  isThinkingLevel,
  modelKey,
  obj,
  parseApproval,
  resultText,
  splitModel,
  thinkingLevels,
  toApproval,
  toPrompt,
  toQuestion,
  toToolItem,
  toUsage,
} from './mapping.js';

type Json = Record<string, unknown>;

export interface PiAdapterOptions {
  config?: PiConfig;
  log?: (message: string) => void;
}

/** A dialog pi waits on, by protocol request id. */
interface PendingDialog {
  uiId: string;
  method: string;
  /** The tool call a Nano approval is about. */
  toolCallId?: string;
  timer?: NodeJS.Timeout;
}

/** A text or thinking block of the assistant message being streamed, by content index. */
interface Block {
  itemId: string;
  kind: 'text' | 'thinking';
}

interface OpenTool {
  item: AdapterItem;
  output: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export class PiAdapter implements Adapter {
  private readonly config: PiConfig;
  private readonly options: PiAdapterOptions;
  private readonly listeners = new Set<AdapterListener>();
  private engine: PiEngine | undefined;
  private booting: Promise<PiEngine> | undefined;
  private killed = false;
  private sessionId = '';
  private cwd = '';
  private settings: Settings = {};
  private model: string | undefined;
  /** The thinking level get_state reported, for a model that takes one. */
  private effort: string | undefined;
  /** True from `turnStart` until the turn ended. */
  private running = false;
  private readonly dialogs = new Map<string, PendingDialog>();
  /** Tool calls the user declined: their error result is a declined item. */
  private readonly declined = new Set<string>();
  private blocks = new Map<number, Block>();
  private readonly tools = new Map<string, OpenTool>();
  /** The error of the turn's last assistant message, if it ended with one. */
  private lastError: string | undefined;

  constructor(options: PiAdapterOptions = {}) {
    this.options = options;
    this.config = options.config ?? piConfig();
  }

  /** pi's process id while one runs (tests and diagnostics). */
  get pid(): number | undefined {
    return this.engine?.alive ? this.engine.pid : undefined;
  }

  get engineSessionId(): string {
    return this.sessionId;
  }

  onEvent(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(cwd: string, settings: Settings): Promise<string> {
    this.remember(cwd, settings);
    this.sessionId = randomUUID();
    await this.connect();
    return this.sessionId;
  }

  async resume(engineSessionId: string, cwd: string, settings: Settings): Promise<void> {
    this.remember(cwd, settings);
    this.sessionId = engineSessionId;
    await this.connect();
  }

  /** The model the session runs on, as `provider/id`, and its thinking level (spec 5.1 Session.settings). */
  effectiveSettings(): Settings {
    const settings: Settings = {};
    if (this.model !== undefined) settings.model = this.model;
    if (this.effort !== undefined) settings.effort = this.effort;
    return settings;
  }

  async turnStart(input: AdapterInputPart[], _clientMessageId: string): Promise<void> {
    const prompt = await toPrompt(input);
    const engine = await this.ready();
    this.running = true;
    this.lastError = undefined;
    this.blocks = new Map();
    this.tools.clear();
    this.declined.clear();
    let result: Json;
    try {
      result = obj(await engine.call('prompt', prompt));
    } catch (error) {
      this.running = false;
      throw error;
    }
    // An extension command or input handler consumed the prompt: no run starts, the turn is over.
    if (result.disposition === 'handled' && this.running) void this.finishTurn(false);
  }

  async steer(input: AdapterInputPart[], _clientMessageId: string): Promise<void> {
    const prompt = await toPrompt(input);
    const engine = await this.ready();
    if (!this.running) throw new RpcError('turn_mismatch', 'no pi turn is running to steer', { turnId: null });
    await engine.call('steer', prompt);
  }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    const engine = this.engine;
    if (!engine?.alive) throw unavailable('pi is not running');
    // Queued steering would start the next run right after the abort: clear it first. pi's abort waits
    // for the run to go idle, which never happens while a dialog is open, so the open dialogs are declined
    // after the abort is sent: the run then ends aborted (probed with pi 1.3.0).
    const cleared = engine.call('clear_queue').catch(() => {});
    const aborted = engine.call('abort');
    for (const [requestId, dialog] of [...this.dialogs]) {
      this.dropDialog(requestId);
      engine.respondUi(dialog.uiId, dialog.toolCallId !== undefined ? { confirmed: false } : { cancelled: true });
      if (dialog.toolCallId !== undefined) this.declined.add(dialog.toolCallId);
    }
    await cleared;
    await aborted;
  }

  async resolveApproval(requestId: string, decision: Decision): Promise<void> {
    const open = this.dialogs.get(requestId);
    if (!open || open.toolCallId === undefined || !this.engine?.alive) return;
    // Cancel declines the call and interrupts the turn: the interrupt declines every open dialog, this
    // one included, after its abort is on the way, so the model gets no further step.
    if (decision === 'cancel') return this.interrupt();
    const dialog = this.take(requestId)!;
    const answer = approvalAnswer(decision);
    if (answer.confirmed !== true) this.declined.add(open.toolCallId);
    this.engine.respondUi(dialog.uiId, answer);
  }

  async answerInput(requestId: string, answers: Record<string, string[]>): Promise<void> {
    const dialog = this.take(requestId);
    if (!dialog || dialog.toolCallId !== undefined) return;
    this.engine!.respondUi(dialog.uiId, dialogAnswer(dialog.method, answers));
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.listeners.clear();
    for (const requestId of [...this.dialogs.keys()]) this.dropDialog(requestId);
    const engine = this.engine;
    this.engine = undefined;
    await engine?.kill();
  }

  // ---- engine lifecycle ------------------------------------------------------------------------

  private remember(cwd: string, settings: Settings): void {
    this.cwd = cwd;
    this.settings = settings;
  }

  /** The running pi; a dead one is replaced and the session reloaded ("restart on the next call"). */
  private async ready(): Promise<PiEngine> {
    if (this.booting) return this.booting;
    if (this.engine?.alive) return this.engine;
    if (this.sessionId === '') throw unavailable('no pi session is attached');
    return this.connect();
  }

  private connect(): Promise<PiEngine> {
    if (this.killed) return Promise.reject(unavailable('the adapter was killed'));
    this.booting ??= this.boot().finally(() => {
      this.booting = undefined;
    });
    return this.booting;
  }

  private async boot(): Promise<PiEngine> {
    let attached = false;
    const engine = new PiEngine(this.config, {
      onEvent: (event) => this.onPiEvent(event),
      onUiRequest: (request) => this.onUiRequest(request),
      onExit: (reason) => {
        if (attached) this.onExit(reason);
      },
      log: this.options.log,
    });
    this.engine = engine;
    try {
      engine.start(['--session-id', this.sessionId], this.cwd);
      const wanted = typeof this.settings.model === 'string' ? this.settings.model : '';
      if (wanted !== '') {
        const target = splitModel(wanted);
        if (!target) throw unavailable(`model ${wanted} is not of the form provider/id`);
        await engine.call('set_model', target);
      }
      // pi turns a level it does not know into `off`, so only its own levels are sent.
      if (isThinkingLevel(this.settings.effort)) await engine.call('set_thinking_level', { level: this.settings.effort });
      const state = obj(await engine.call('get_state'));
      this.model = modelKey(state.model) ?? this.model;
      const level = state.thinkingLevel;
      this.effort = thinkingLevels(state.model).length > 0 && typeof level === 'string' && level !== '' ? level : undefined;
      attached = true;
      return engine;
    } catch (error) {
      this.engine = undefined;
      await engine.kill();
      throw error instanceof RpcError ? error : unavailable((error as Error).message);
    }
  }

  private onExit(reason: string): void {
    this.engine = undefined;
    for (const requestId of [...this.dialogs.keys()]) this.dropDialog(requestId);
    this.running = false;
    this.emit({ method: 'status/changed', params: { status: 'error' } });
    this.emit({ method: 'agent/exited', params: { reason } });
  }

  // ---- pi events -------------------------------------------------------------------------------

  private onPiEvent(event: Json): void {
    // Outside a turn nothing is reported: the core journals only what belongs to a running turn.
    if (!this.running) return;
    switch (event.type) {
      case 'message_start':
        // Content indexes count from 0 in every message; the snapshot in message_start repeats the
        // first delta, so blocks start from the deltas.
        if (obj(event.message).role === 'assistant') this.blocks = new Map();
        return;
      case 'message_update':
        return this.onUpdate(obj(event.assistantMessageEvent));
      case 'message_end':
        return this.onMessageEnd(obj(event.message));
      case 'tool_execution_start':
        return this.onToolStart(event);
      case 'tool_execution_update':
        return this.onToolUpdate(event);
      case 'tool_execution_end':
        return this.onToolEnd(event);
      case 'agent_settled':
        void this.finishTurn(event.aborted === true);
        return;
      default:
        return;
    }
  }

  private onUpdate(update: Json): void {
    const index = typeof update.contentIndex === 'number' ? update.contentIndex : -1;
    switch (update.type) {
      case 'text_start':
        this.block(index, 'text');
        return;
      case 'thinking_start':
        this.block(index, 'thinking');
        return;
      case 'text_delta':
      case 'thinking_delta': {
        const kind = update.type === 'text_delta' ? 'text' : 'thinking';
        const delta = str(update.delta);
        if (delta === '') return;
        this.emit({ method: 'item/delta', params: { itemId: this.block(index, kind).itemId, field: 'text', delta } });
        return;
      }
      default:
        return;
    }
  }

  /** The item of a content block, started (item/started) the first time it is seen. */
  private block(index: number, kind: Block['kind']): Block {
    const known = this.blocks.get(index);
    if (known && known.kind === kind) return known;
    const block: Block = { itemId: newId('itm'), kind };
    this.blocks.set(index, block);
    const item: AdapterItem =
      kind === 'text'
        ? { itemId: block.itemId, status: 'inProgress', type: 'agentMessage', text: '' }
        : { itemId: block.itemId, status: 'inProgress', type: 'reasoning', summary: '', text: '' };
    this.emit({ method: 'item/started', params: { item } });
    return block;
  }

  /** The final assistant message: every text and thinking block completes with its full content. */
  private onMessageEnd(message: Json): void {
    if (message.role !== 'assistant') return;
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((raw, index) => {
      const part = obj(raw);
      const kind = part.type === 'text' ? 'text' : part.type === 'thinking' ? 'thinking' : undefined;
      if (kind === undefined) return;
      const text = kind === 'text' ? str(part.text) : str(part.thinking);
      if (text === '' && !this.blocks.has(index)) return;
      const { itemId } = this.block(index, kind);
      const item: AdapterItem =
        kind === 'text'
          ? { itemId, status: 'completed', type: 'agentMessage', text }
          : { itemId, status: 'completed', type: 'reasoning', summary: '', text };
      this.emit({ method: 'item/completed', params: { item } });
    });
    this.blocks = new Map();
    if (message.stopReason === 'error') this.lastError = str(message.errorMessage) || 'pi reported an error';
  }

  private onToolStart(event: Json): void {
    const id = str(event.toolCallId);
    if (id === '' || this.tools.has(id)) return;
    const item = toToolItem(id, str(event.toolName), obj(event.args), this.cwd, 'inProgress');
    this.tools.set(id, { item, output: '' });
    this.emit({ method: 'item/started', params: { item } });
  }

  /** bash streams its output so far: the new tail is the delta. */
  private onToolUpdate(event: Json): void {
    const tool = this.tools.get(str(event.toolCallId));
    if (!tool || tool.item.type !== 'command') return;
    const text = resultText(event.partialResult);
    if (!text.startsWith(tool.output) || text.length === tool.output.length) return;
    const delta = text.slice(tool.output.length);
    tool.output = text;
    this.emit({ method: 'item/delta', params: { itemId: tool.item.itemId, field: 'output', delta } });
  }

  private onToolEnd(event: Json): void {
    const id = str(event.toolCallId);
    if (id === '') return;
    const started = this.tools.get(id)?.item ?? toToolItem(id, str(event.toolName), obj(event.args), this.cwd, 'inProgress');
    this.tools.delete(id);
    const item = finishToolItem(started, event, this.declined.has(id));
    this.emit({ method: 'item/completed', params: { item } });
  }

  /** Ends the running turn: open tools fail, usage is reported, then `turn/completed`. */
  private async finishTurn(aborted: boolean): Promise<void> {
    this.running = false;
    for (const requestId of [...this.dialogs.keys()]) this.dropDialog(requestId);
    for (const tool of this.tools.values()) {
      this.emit({ method: 'item/completed', params: { item: { ...tool.item, status: 'failed' } as AdapterItem } });
    }
    this.tools.clear();
    const engine = this.engine;
    if (engine?.alive) {
      try {
        this.emit({ method: 'usage/updated', params: { usage: toUsage(await engine.call('get_session_stats')) } });
      } catch (error) {
        this.options.log?.(`pi: no session stats (${(error as Error).message})`);
      }
    }
    const params: Extract<AdapterEvent, { method: 'turn/completed' }>['params'] = {
      status: aborted ? 'interrupted' : this.lastError !== undefined ? 'failed' : 'completed',
    };
    if (!aborted && this.lastError !== undefined) params.error = { code: 'agent_error', message: this.lastError };
    this.emit({ method: 'turn/completed', params });
  }

  // ---- dialogs ---------------------------------------------------------------------------------

  private onUiRequest(request: Json): void {
    const method = str(request.method);
    const uiId = str(request.id);
    if (!(DIALOG_METHODS as readonly string[]).includes(method) || uiId === '') return; // fire-and-forget
    const call = parseApproval(request);
    if (!this.running) {
      // Nobody can be asked outside a turn: nothing that changes things runs unasked.
      this.engine?.respondUi(uiId, call ? { confirmed: false } : { cancelled: true });
      return;
    }
    const requestId = newId('req');
    const dialog: PendingDialog = { uiId, method };
    if (typeof request.timeout === 'number' && request.timeout > 0) {
      // pi answers the dialog itself when its timeout passes: the request is withdrawn then.
      dialog.timer = setTimeout(() => {
        if (!this.dialogs.has(requestId)) return;
        this.dropDialog(requestId);
        this.emit({ method: 'request/withdrawn', params: { requestId } });
      }, request.timeout);
      dialog.timer.unref();
    }
    if (call) {
      dialog.toolCallId = call.toolCallId;
      this.dialogs.set(requestId, dialog);
      this.emit({ method: 'approval/request', params: { request: toApproval(requestId, call, this.cwd) } });
      return;
    }
    this.dialogs.set(requestId, dialog);
    const itemId = [...this.tools.keys()].at(-1) ?? requestId;
    this.emit({
      method: 'input/request',
      params: { request: { requestId, kind: 'input', itemId, isBlocking: true, questions: [toQuestion(request)] } },
    });
  }

  private take(requestId: string): PendingDialog | undefined {
    const dialog = this.dialogs.get(requestId);
    if (!dialog || !this.engine?.alive) return undefined;
    this.dropDialog(requestId);
    return dialog;
  }

  private dropDialog(requestId: string): void {
    const dialog = this.dialogs.get(requestId);
    if (dialog?.timer) clearTimeout(dialog.timer);
    this.dialogs.delete(requestId);
  }

  /** Silent after `kill()`: it clears the listeners. */
  private emit(event: AdapterEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
