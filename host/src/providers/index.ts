// The provider relay (protocol-v1.md section 15, ADR 0006): host-routed Providers for local chat.
export { discover, DISCOVERY_PORTS, ownAddresses, probe, PROBE_TIMEOUT_MS } from './discover.js';
export type { AddressScope, DiscoverOptions, ScopedAddress } from './discover.js';
export { ndjsonFramer, sseFramer } from './frames.js';
export { Cancelled, ProviderFailure, ProviderHttp, retryAfterMs, RETRY_STATUSES } from './http.js';
export type { HttpOptions } from './http.js';
export { registerProviderMethods } from './methods.js';
export type { ProviderMethodsOptions } from './methods.js';
export { FIRST_TOKEN_TIMEOUT_MS, MODELS_TIMEOUT_MS, ProviderRelay } from './relay.js';
export type { ChatOutcome, ChatSink, ProviderTarget, RelayOptions, ResolvedProvider } from './relay.js';
export { isHostRouted, kindForURL, normalizeBaseURL, PROVIDER_KINDS } from './url.js';
export type { ProviderKind } from './url.js';
export { WIRE } from './wire.js';
export type { WireEvent, WireFormat } from './wire.js';
