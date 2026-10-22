// Local chat's engine: one streaming API for both routes (ADR 0006), per-vendor request shaping, and the
// chat history on the phone. No UI here; the chat screens build on this.
export * from './types';
export { createChatEngine } from './chat';
export type { ChatEngine, ChatEngineDeps } from './chat';
export { DEFAULT_DIRECT_TIMING, DeadHosts, retryAfter } from './direct';
export type { ChatFetch, ChatResponseLike, DirectTiming } from './direct';
export type { HostLink } from './host';
export { chatMessage, HOST_UNAVAILABLE_MESSAGE } from './errors';
export { QUIRKS, shapingFor } from './quirks';
export type { Shaping, ThinkingStyle } from './quirks';
export { ChatStore, CHATS_STORAGE_KEY, sendMessage, titleFrom, UNTITLED } from './history';
export type { Chat, ChatMessage, ChatStoreOptions, MessageStatus } from './history';
