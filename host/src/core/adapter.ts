// The Adapter contract (CONTEXT.md "Adapter"; protocol-v1.md sections 5 and 11). One adapter instance
// drives one engine session of one agent and reports what happens as AdapterEvents in the section 5
// vocabulary. It never sees the Journal, seqs, protocol session ids or turn ids: the SessionManager owns
// those.
//
// Turn ids: the core assigns every turn id (`trn_...`) and journals `turn/started` itself before it
// calls `turnStart`. The Claude Agent SDK has no turn id and no turn-started event at all
// (spikes/host-drive/NOTES.md); engines that do have one (Codex) keep it inside their adapter, like
// their method names, and use it for their own `steer`/`interrupt` calls. So adapter events carry no
// turnId: everything an adapter emits belongs to the turn that is running.
//
// Engine-initiated turns: an engine can also start a turn by itself (Claude Code does when a background
// task reports in: a Monitor event, a background Bash or subagent finishing). The adapter then emits
// `turn/started` before the turn's first item; the core opens a turn without a user message and mints
// its id. A `turn/start` from the user while such a turn runs joins that turn instead of failing with
// `session_busy` (the engine takes the message mid-turn).
import type {
  Agent,
  ApprovalRequest,
  Decision,
  InputPart,
  InputRequest,
  Item,
  ModelInfo,
  SessionStatus,
  Settings,
  TurnError,
  Usage,
} from '../generated/common.js';
import type { DeltaField } from '../journal/types.js';

/** Removes keys from every member of a union while keeping known keys next to index signatures. */
type Without<T, K extends PropertyKey> = T extends unknown ? { [P in keyof T as P extends K ? never : P]: T[P] } : never;

/** An item as an adapter reports it: the core binds it to the running turn. */
export type AdapterItem = Without<Item, 'turnId'>;

/** An approval request as an adapter reports it; the core adds `sessionId`, `turnId`, `createdAt`, `expiresAt`. */
export type AdapterApprovalRequest = Without<ApprovalRequest, 'sessionId' | 'turnId' | 'createdAt' | 'expiresAt'> & {
  expiresAt?: number | null;
};

/** An input request (a question for the user) as an adapter reports it; the core adds `sessionId`, `turnId`. */
export type AdapterInputRequest = Without<InputRequest, 'sessionId' | 'turnId'>;

/** The final statuses a turn can end with. */
export type FinalTurnStatus = 'completed' | 'interrupted' | 'failed';

/** What an adapter emits. Method names follow the Journal events of spec 5.2 where one exists. */
export type AdapterEvent =
  /** The engine reports a session status (for example `error` when it hit a system error). */
  | { method: 'status/changed'; params: { status: SessionStatus } }
  | { method: 'item/started'; params: { item: AdapterItem } }
  | { method: 'item/delta'; params: { itemId: string; field: DeltaField; delta: string } }
  | { method: 'item/completed'; params: { item: AdapterItem } }
  | { method: 'approval/request'; params: { request: AdapterApprovalRequest } }
  | { method: 'input/request'; params: { request: AdapterInputRequest } }
  /** The engine dropped a request on its own (timeout, superseded). Journaled as resolved by "agent". */
  | { method: 'request/withdrawn'; params: { requestId: string } }
  | { method: 'usage/updated'; params: { usage: Usage } }
  /**
   * The engine started a turn on its own, with no `turnStart` from the core. The core opens a turn with
   * no user message; ignored while a turn runs.
   */
  | { method: 'turn/started'; params: Record<string, never> }
  /** The running turn ended. */
  | { method: 'turn/completed'; params: { status: FinalTurnStatus; error?: TurnError } }
  /** The engine told us its session id late (Claude reports it with the first turn). Not journaled. */
  | { method: 'engine/session'; params: { engineSessionId: string } }
  /** The engine process died. The core fails the running turn; the next turn resumes the engine session. */
  | { method: 'agent/exited'; params: { reason: string } };

export type AdapterListener = (event: AdapterEvent) => void;

/**
 * What an agent supports, fixed per agent (spec 4 `Agent.capabilities`): `steer` and `diff` say whether
 * `turn/steer` and `turn/diff` work (otherwise they answer `not_supported` without starting the agent).
 * The host computes turn diffs itself from git snapshots (core/turn-changes.ts), so real agents declare
 * `diff: true` and adapters have no part in it;
 * `approvalModes` lists the `settings.approvalMode` values the agent honours (empty: none).
 */
export interface AgentCapabilities {
  readonly steer: boolean;
  readonly diff: boolean;
  readonly approvalModes: readonly string[];
}

/**
 * Drives one engine session. Every method resolves once the engine accepted the call, not when its
 * effect is over: `turnStart` resolves when the input is delivered, and the turn's progress and end
 * arrive as events. A method that rejects tells the core the engine is unavailable.
 */
export interface Adapter {
  /** Creates a new engine session. Returns its id, or '' when the engine reports it later (`engine/session`). */
  start(cwd: string, settings: Settings): Promise<string>;
  /** Reattaches to an existing engine session after the engine or the host restarted. */
  resume(engineSessionId: string, cwd: string, settings: Settings): Promise<void>;
  turnStart(input: InputPart[], clientMessageId: string): Promise<void>;
  /** Adds input to the running turn. Only called when the agent's `capabilities.steer`. */
  steer(input: InputPart[], clientMessageId: string): Promise<void>;
  /** Stops the running turn; the adapter then emits `turn/completed {status: "interrupted"}`. */
  interrupt(): Promise<void>;
  resolveApproval(requestId: string, decision: Decision): Promise<void>;
  /** Answers keyed by question id (spec 5.3); the adapter maps them onto what its engine expects. */
  answerInput(requestId: string, answers: Record<string, string[]>): Promise<void>;
  /** Ends the engine process. The adapter emits nothing afterwards. */
  kill(): Promise<void>;
  /** Subscribes to the adapter's events; returns the unsubscribe function. */
  onEvent(listener: AdapterListener): () => void;
  /**
   * The settings the engine session runs with (approval mode, sandbox, ...), asked after `start` and
   * `resume`. The core merges them into Session.settings so clients see what is in effect.
   */
  effectiveSettings?(): Settings;
}

/** Status of an agent as `agent/list` reports it (spec 4). */
export type AgentState = Pick<Agent, 'status' | 'version' | 'reason'>;

/**
 * One agent the host can drive (Codex, Claude Code, Pi): its identity, capabilities, health, models, and
 * a factory for adapters. The host registers one provider per agent. (The name predates the model
 * providers of section 15: here "provider" means a coding agent; CONTEXT.md "Agent".)
 */
export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  /** Static: known without creating an adapter or starting the engine. */
  readonly capabilities: AgentCapabilities;
  /** `status: "ready"` when sessions can start; anything else answers `agent_unavailable`. */
  state(): AgentState;
  models(): ModelInfo[] | Promise<ModelInfo[]>;
  createAdapter(): Adapter;
  /** Reports status changes (drives `host/status/changed`); returns the unsubscribe function. */
  onStateChange?(listener: () => void): () => void;
}

/** The `Agent` object of `initialize` and `agent/list`. */
export function describeAgent(provider: AgentProvider): Agent {
  const state = provider.state();
  const agent: Agent = { id: provider.id, name: provider.name, status: state.status };
  if (state.version !== undefined) agent.version = state.version;
  if (state.reason !== undefined) agent.reason = state.reason;
  const { steer, diff, approvalModes } = provider.capabilities;
  agent.capabilities = { steer, diff, approvalModes: [...approvalModes] };
  return agent;
}
