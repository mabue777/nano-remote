// Nano Host entry point (scaffold). Library surface of the host.
export type * as protocol from './generated/index.js';

/** Protocol major version this host speaks (protocol/protocol-v1.md). */
export const PROTOCOL_VERSION = 1;

/** Directory the host serves the web client from, and the content type of each static file. */
export { PUBLIC_DIR, contentTypeFor } from './http/static.js';

export * as cli from './cli/index.js';
export * as core from './core/index.js';
export * as codex from './adapters/codex/index.js';
export * as config from './config/index.js';
export * as devices from './devices/index.js';
export * as http from './http/index.js';
export * as pairing from './pairing/index.js';
export { FakeAdapter, FakeAgent, echoScript, scripted } from './core/testing/fake-adapter.js';
