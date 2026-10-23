// The pi adapter (protocol-v1.md section 11): `pi --mode rpc` over stdio JSONL, Phase 5b.
export { PiAdapter } from './adapter.js';
export type { PiAdapterOptions } from './adapter.js';
export { PiAgent, piInstalled } from './provider.js';
export type { PiAgentOptions } from './provider.js';
export { LineSplitter, PiEngine } from './engine.js';
export type { PiEngineHandlers } from './engine.js';
