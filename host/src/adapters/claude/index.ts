// The Claude Code adapter (protocol-v1.md section 11): the Claude Agent SDK's query() in streaming-input mode.
export { ClaudeAdapter, Inbox, loadQuery } from './adapter.js';
export type { ClaudeAdapterOptions, ClaudeQuery, QueryFn } from './adapter.js';
export { ClaudeAgent, resolveSdkVersion } from './provider.js';
export type { ClaudeAgentOptions } from './provider.js';
