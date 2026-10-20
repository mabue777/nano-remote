// The envelope stream (protocol-v1 sections 2, 3, 4, 10): WebSocket server, envelope rules, message router.
export { ChunkError, MessageTooLarge, Reassembler, splitMessage } from './chunking.js';
export type { Segment } from './chunking.js';
export { Connection } from './connection.js';
export type { HostStatus, SendOptions } from './connection.js';
export * from './constants.js';
export { checkClientEnvelope, checkInitializeParams, checkMessage, parseClientEnvelope } from './guard.js';
export type { Bad, ClientEnvelope, Guarded, Message } from './guard.js';
export { PresenceRegistry } from './presence.js';
export type { PresenceListener, PresenceState, StreamPresence } from './presence.js';
export { MethodRegistry, RpcError, toErrorBody } from './router.js';
export type { ErrorBody, ErrorCode, Handler, MethodMap, MethodName, ParamsCheck, RequestContext } from './router.js';
export { StreamServer, tokenFrom } from './server.js';
export type { Authenticate, StreamServerOptions } from './server.js';
