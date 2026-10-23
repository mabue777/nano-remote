// The session core (protocol-v1 sections 4 to 7): the Adapter contract, the SessionManager that turns
// adapter events into Journal events, and the HostCore that registers the protocol methods on the router.
export { describeAgent } from './adapter.js';
export type {
  Adapter,
  AdapterApprovalRequest,
  AdapterEvent,
  AdapterInputPart,
  AdapterInputRequest,
  AdapterItem,
  AdapterListener,
  AgentCapabilities,
  AgentProvider,
  AgentState,
  FinalTurnStatus,
} from './adapter.js';
export { HostCore, MAX_PROJECTS, readDirectory } from './host-core.js';
export type { HostCoreOptions } from './host-core.js';
export { newId } from './ids.js';
export type { IdPrefix } from './ids.js';
export { DEFAULT_TITLE, SessionManager, TITLE_MAX, titleFrom } from './session-manager.js';
export type { SessionManagerOptions, StartParams } from './session-manager.js';
export { SessionStore } from './store.js';
export type { SessionRecord } from './store.js';
export { FAKE_APPROVAL_MODES, FakeAdapter, FakeAgent, echoScript, scripted } from './testing/fake-adapter.js';
export type { FakeAdapterOptions, FakeAgentOptions, FakeCall, FakeScript, FakeStep, FakeTurn } from './testing/fake-adapter.js';
