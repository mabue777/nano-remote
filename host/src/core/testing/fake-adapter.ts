// A scripted, deterministic adapter for tests and for the web client's fake host. Each turn plays a list
// of steps synchronously: it emits events, stops at an approval or a question until the core resolves it,
// and ends with `turn/completed` when the steps run out. No timers, no randomness: the same script and
// the same calls always produce the same events in the same order.
//
//   const agent = new FakeAgent({ script: [[{ reply: 'Hello' }], [{ approval: { command: 'rm x' } }, { reply: 'Done' }]] });
//   new HostCore({ journal, agents: [agent], host });
import type { Decision, FileChange, InputPart, ModelInfo, Settings } from '../../generated/common.js';
import type {
  Adapter,
  AdapterApprovalRequest,
  AdapterEvent,
  AdapterInputRequest,
  AdapterListener,
  AgentCapabilities,
  AgentProvider,
  AgentState,
} from '../adapter.js';

/** One step of a scripted turn. */
export type FakeStep =
  /** Emit this event as is. */
  | { emit: AdapterEvent }
  /** An agentMessage item: started, one delta per chunk, completed with the full text. */
  | { reply: string; chunks?: number }
  /** Emit an approval request (defaults fill a command approval) and wait for `resolveApproval`. */
  | { approval: Partial<AdapterApprovalRequest> }
  /** Emit an input request (defaults fill one question) and wait for `answerInput`. */
  | { input: Partial<AdapterInputRequest> }
  /** Wait until `release()` is called: keeps the turn running for busy and steer tests. */
  | { hold: true }
  /** End the turn as failed with this message. */
  | { fail: string }
  /** The engine process dies with this reason. */
  | { exit: string };

export type FakeTurn = FakeStep[];

/** Picks the steps of a turn from its input and its number (0-based, counted per FakeAgent). */
export type FakeScript = (input: InputPart[], turnIndex: number) => FakeTurn;

type Method = Exclude<keyof Adapter, 'onEvent'>;

export interface FakeAdapterOptions {
  script?: FakeScript;
  /** What `start` returns; '' makes the adapter report it with the first turn (`engine/session`), like Claude. */
  engineSessionId?: string;
  /** Files `diff` returns. */
  diff?: FileChange[];
  /** What `effectiveSettings` reports after start and resume. Default: nothing. */
  effectiveSettings?: Settings;
  /** Methods that reject with this message instead of doing their work. */
  failOn?: Partial<Record<Method, string>>;
}

export interface FakeCall {
  method: Method;
  args: unknown[];
}

/** Default script: every turn answers "You said: <text>". */
export const echoScript: FakeScript = (input) => [
  { reply: `You said: ${input.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(' ')}` },
];

/** A script from a fixed list of turns; turns past the end echo. */
export function scripted(turns: FakeTurn[]): FakeScript {
  return (input, index) => turns[index] ?? echoScript(input, index);
}

let engineCounter = 0;

export class FakeAdapter implements Adapter {
  readonly calls: FakeCall[] = [];
  /** Decisions and answers the core passed in, by request id. */
  readonly resolutions = new Map<string, Decision | Record<string, string[]>>();
  killed = false;
  private readonly listeners = new Set<AdapterListener>();
  private readonly script: FakeScript;
  private readonly options: FakeAdapterOptions;
  private turns = 0;
  private steps: FakeStep[] | undefined;
  private waiting: { kind: 'request'; requestId: string } | { kind: 'hold' } | undefined;
  private engineId = '';
  private reportEngineId = false;
  private itemCounter = 0;
  private requestCounter = 0;

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
    this.script = options.script ?? echoScript;
  }

  effectiveSettings(): Settings {
    return this.options.effectiveSettings ?? {};
  }

  /** A turn is running (started and not yet completed). */
  get running(): boolean {
    return this.steps !== undefined;
  }

  /** The request the turn is waiting on, if any. */
  get waitingFor(): string | undefined {
    return this.waiting?.kind === 'request' ? this.waiting.requestId : undefined;
  }

  onEvent(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emits an event now, outside any script. */
  emit(event: AdapterEvent): void {
    if (this.killed) return;
    for (const listener of [...this.listeners]) listener(event);
  }

  async start(cwd: string, settings: Settings): Promise<string> {
    this.record('start', cwd, settings);
    this.engineId = this.options.engineSessionId ?? `eng_fake_${++engineCounter}`;
    if (this.engineId === '') {
      this.engineId = `eng_fake_${++engineCounter}`;
      this.reportEngineId = true;
      return '';
    }
    return this.engineId;
  }

  async resume(engineSessionId: string, cwd: string, settings: Settings): Promise<void> {
    this.record('resume', engineSessionId, cwd, settings);
    this.engineId = engineSessionId;
  }

  async turnStart(input: InputPart[], clientMessageId: string): Promise<void> {
    this.record('turnStart', input, clientMessageId);
    if (this.reportEngineId) {
      this.reportEngineId = false;
      this.emit({ method: 'engine/session', params: { engineSessionId: this.engineId } });
    }
    this.steps = [...this.script(input, this.turns++)];
    this.waiting = undefined;
    this.run();
  }

  async steer(input: InputPart[], clientMessageId: string): Promise<void> {
    this.record('steer', input, clientMessageId);
  }

  async interrupt(): Promise<void> {
    this.record('interrupt');
    if (this.steps) this.end({ status: 'interrupted' });
  }

  async resolveApproval(requestId: string, decision: Decision): Promise<void> {
    this.record('resolveApproval', requestId, decision);
    this.resolutions.set(requestId, decision);
    if (this.waitingFor !== requestId) return;
    this.waiting = undefined;
    if (decision === 'cancel') this.end({ status: 'interrupted' });
    else this.run();
  }

  async answerInput(requestId: string, answers: Record<string, string[]>): Promise<void> {
    this.record('answerInput', requestId, answers);
    this.resolutions.set(requestId, answers);
    if (this.waitingFor !== requestId) return;
    this.waiting = undefined;
    this.run();
  }

  async diff(turnId: string): Promise<FileChange[]> {
    this.record('diff', turnId);
    return this.options.diff ?? [];
  }

  async kill(): Promise<void> {
    this.record('kill');
    this.killed = true;
    this.steps = undefined;
    this.waiting = undefined;
  }

  /** Ends a `hold` step and plays the rest of the turn. */
  release(): void {
    if (this.waiting?.kind !== 'hold') throw new Error('FakeAdapter: no hold step is waiting');
    this.waiting = undefined;
    this.run();
  }

  /** Records the call, then throws when `failOn` names the method. */
  private record(method: Method, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.options.failOn?.[method];
    if (failure !== undefined) throw new Error(failure);
  }

  private end(params: Extract<AdapterEvent, { method: 'turn/completed' }>['params']): void {
    this.steps = undefined;
    this.waiting = undefined;
    this.emit({ method: 'turn/completed', params });
  }

  private nextItemId(): string {
    return `itm_fake_${++this.itemCounter}`;
  }

  /** Plays steps until one waits or the turn ends. */
  private run(): void {
    while (this.steps && !this.waiting && !this.killed) {
      const step = this.steps.shift();
      if (!step) {
        this.end({ status: 'completed' });
        return;
      }
      this.play(step);
    }
  }

  private play(step: FakeStep): void {
    if ('emit' in step) {
      this.emit(step.emit);
    } else if ('reply' in step) {
      const itemId = this.nextItemId();
      this.emit({ method: 'item/started', params: { item: { itemId, type: 'agentMessage', status: 'inProgress', text: '' } } });
      const chunks = Math.max(1, step.chunks ?? 1);
      const size = Math.ceil(step.reply.length / chunks);
      for (let i = 0; i < step.reply.length; i += size) {
        this.emit({ method: 'item/delta', params: { itemId, field: 'text', delta: step.reply.slice(i, i + size) } });
      }
      this.emit({
        method: 'item/completed',
        params: { item: { itemId, type: 'agentMessage', status: 'completed', text: step.reply } },
      });
    } else if ('approval' in step) {
      const request = {
        requestId: `req_fake_${++this.requestCounter}`,
        kind: 'command',
        itemId: this.nextItemId(),
        command: 'echo hello > hello.txt',
        cwd: '/tmp',
        reason: 'May I run this command?',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        ...step.approval,
      } as AdapterApprovalRequest;
      this.waiting = { kind: 'request', requestId: request.requestId };
      this.emit({ method: 'approval/request', params: { request } });
    } else if ('input' in step) {
      const request: AdapterInputRequest = {
        requestId: `req_fake_${++this.requestCounter}`,
        kind: 'input',
        itemId: this.nextItemId(),
        isBlocking: true,
        questions: [{ id: 'q1', header: 'Question', question: 'Which color?', isOther: false, isSecret: false }],
        ...step.input,
      };
      this.waiting = { kind: 'request', requestId: request.requestId };
      this.emit({ method: 'input/request', params: { request } });
    } else if ('hold' in step) {
      this.waiting = { kind: 'hold' };
    } else if ('fail' in step) {
      this.end({ status: 'failed', error: { code: 'agent_error', message: step.fail } });
    } else {
      this.steps = undefined;
      this.emit({ method: 'agent/exited', params: { reason: step.exit } });
    }
  }
}

export interface FakeAgentOptions {
  id?: string;
  name?: string;
  /** Turns in order (shared by every session of this agent), or a function. Default: echo. */
  script?: FakeTurn[] | FakeScript;
  models?: ModelInfo[];
  state?: AgentState;
  /**
   * The agent's static capabilities. Default: steers, has a diff when `adapter.diff` is set, and honours
   * the Codex approval modes (`FAKE_APPROVAL_MODES`).
   */
  capabilities?: Partial<AgentCapabilities>;
  /** Passed to every adapter this agent creates (the script comes from the agent). */
  adapter?: Omit<FakeAdapterOptions, 'script'>;
}

export const FAKE_APPROVAL_MODES: readonly string[] = ['untrusted', 'on-failure', 'on-request', 'never'];

/** An AgentProvider whose adapters are FakeAdapters. Keeps every adapter it created, newest last. */
export class FakeAgent implements AgentProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  readonly adapters: FakeAdapter[] = [];
  adapterOptions: Omit<FakeAdapterOptions, 'script'>;
  private stateValue: AgentState;
  private readonly modelList: ModelInfo[];
  private readonly script: FakeScript;
  private turnCount = 0;
  private readonly listeners = new Set<() => void>();

  constructor(options: FakeAgentOptions = {}) {
    this.id = options.id ?? 'fake';
    this.name = options.name ?? 'Fake Agent';
    this.stateValue = options.state ?? { status: 'ready', version: '0.0.0' };
    this.modelList = options.models ?? [{ id: 'fake-1', displayName: 'Fake 1', default: true }];
    const script = options.script ?? echoScript;
    this.script = typeof script === 'function' ? script : scripted(script);
    this.adapterOptions = options.adapter ?? {};
    this.capabilities = {
      steer: true,
      diff: this.adapterOptions.diff !== undefined,
      approvalModes: FAKE_APPROVAL_MODES,
      ...options.capabilities,
    };
  }

  /** The newest adapter. Throws when none was created yet. */
  get last(): FakeAdapter {
    const adapter = this.adapters[this.adapters.length - 1];
    if (!adapter) throw new Error('FakeAgent: no adapter created yet');
    return adapter;
  }

  state(): AgentState {
    return this.stateValue;
  }

  /** Changes the agent's status and tells listeners (drives `host/status/changed`). */
  setState(state: AgentState): void {
    this.stateValue = state;
    for (const listener of [...this.listeners]) listener();
  }

  models(): ModelInfo[] {
    return this.modelList;
  }

  createAdapter(): FakeAdapter {
    const adapter = new FakeAdapter({
      ...this.adapterOptions,
      script: (input) => this.script(input, this.turnCount++),
    });
    this.adapters.push(adapter);
    return adapter;
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
