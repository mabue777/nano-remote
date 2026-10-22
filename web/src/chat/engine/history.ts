// Chat history (local-chat.md ruling R3): Chats live only on the phone, persisted like the Replica
// (replica/storage.ts: localStorage, injected in tests). A streamed reply is written into the chat's last
// assistant message; a stopped reply keeps its partial text with status `stopped`.
import type { StorageLike } from '../../replica/storage';
import type { ChatEngine } from './chat';
import { chatError } from './errors';
import type { ChatEvent, ChatOptions, ChatProvider, ChatTurn, ChatUsage } from './types';

export const CHATS_STORAGE_KEY = 'nano-remote/chats/v1';

/** Longest title taken from the first user message, in characters. */
export const TITLE_LENGTH = 60;
export const UNTITLED = 'New chat';

/** Streamed text is persisted at most this often; every other change is persisted at once. */
export const PERSIST_INTERVAL_MS = 500;

export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'failed';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  usage?: ChatUsage;
  status: MessageStatus;
  /** The one-sentence failure, when status is `failed`. */
  error?: string;
}

export interface Chat {
  id: string;
  title: string;
  providerId: string;
  model: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface Persisted {
  v: 1;
  chats: Chat[];
}

export interface ChatStoreOptions {
  storage: StorageLike | null;
  key?: string;
  now?: () => number;
  randomId?: () => string;
}

/** A title from the first user message: whitespace collapsed, cut at a word near TITLE_LENGTH. */
export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return UNTITLED;
  if (flat.length <= TITLE_LENGTH) return flat;
  const cut = flat.slice(0, TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export class ChatStore {
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private chats: Chat[];
  private lastSave = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<() => void>();

  constructor(options: ChatStoreOptions) {
    this.storage = options.storage;
    this.key = options.key ?? CHATS_STORAGE_KEY;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.chats = load(this.storage, this.key);
  }

  /** Copies of all chats, the most recently updated first. */
  list(): Chat[] {
    return [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt).map(clone);
  }

  get(id: string): Chat | undefined {
    const chat = this.find(id);
    return chat === undefined ? undefined : clone(chat);
  }

  create(providerId: string, model: string): Chat {
    const at = this.now();
    const chat: Chat = { id: this.randomId(), title: UNTITLED, providerId, model, createdAt: at, updatedAt: at, messages: [] };
    this.chats.push(chat);
    this.commit();
    return clone(chat);
  }

  /** Switches the chat's provider and model (the picker in the chat header). */
  setModel(id: string, providerId: string, model: string): void {
    const chat = this.require(id);
    chat.providerId = providerId;
    chat.model = model;
    this.touch(chat);
  }

  remove(id: string): void {
    const before = this.chats.length;
    this.chats = this.chats.filter((c) => c.id !== id);
    if (this.chats.length !== before) this.commit();
  }

  /** Appends the user's message; the first one names the chat. */
  addUserMessage(id: string, text: string): void {
    const chat = this.require(id);
    if (!chat.messages.some((m) => m.role === 'user')) chat.title = titleFrom(text);
    chat.messages.push({ role: 'user', text, status: 'complete' });
    this.touch(chat);
  }

  /** Appends the empty assistant message the reply streams into. */
  startReply(id: string): void {
    const chat = this.require(id);
    chat.messages.push({ role: 'assistant', text: '', status: 'streaming' });
    this.touch(chat);
  }

  /** Writes one engine event into the chat's last assistant message. */
  apply(id: string, event: ChatEvent): void {
    const chat = this.require(id);
    const message = chat.messages.at(-1);
    if (message === undefined || message.role !== 'assistant' || message.status !== 'streaming') return;
    switch (event.type) {
      case 'text':
        message.text += event.text;
        break;
      case 'reasoning':
        message.reasoning = (message.reasoning ?? '') + event.text;
        break;
      case 'usage': {
        const usage: ChatUsage = { ...message.usage };
        if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
        if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
        message.usage = usage;
        break;
      }
      case 'done':
        message.status = event.status === 'completed' ? 'complete' : 'stopped';
        break;
      case 'error':
        message.status = 'failed';
        message.error = event.message;
        break;
    }
    chat.updatedAt = this.now();
    const delta = event.type === 'text' || event.type === 'reasoning';
    if (!delta || this.now() - this.lastSave >= PERSIST_INTERVAL_MS) this.commit();
    else this.emit();
  }

  /**
   * The turns to send for the next reply: every finished message with text, in order. Failed and empty
   * replies are left out, and so is a reply still streaming.
   */
  turns(id: string, system?: string): ChatTurn[] {
    const turns: ChatTurn[] = system === undefined || system === '' ? [] : [{ role: 'system', content: system }];
    for (const m of this.require(id).messages) {
      if (m.text === '' || m.status === 'streaming' || m.status === 'failed') continue;
      turns.push({ role: m.role, content: m.text });
    }
    return turns;
  }

  /** Called after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private find(id: string): Chat | undefined {
    return this.chats.find((c) => c.id === id);
  }

  private require(id: string): Chat {
    const chat = this.find(id);
    if (chat === undefined) throw new Error(`no chat ${id}`);
    return chat;
  }

  private touch(chat: Chat): void {
    chat.updatedAt = this.now();
    this.commit();
  }

  private commit(): void {
    save(this.storage, this.key, { v: 1, chats: this.chats });
    this.lastSave = this.now();
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Sends a user message and streams the reply into the chat: the glue the chat screen calls. Resolves when
 * the reply has ended (completed, stopped or failed).
 */
export async function sendMessage(
  engine: ChatEngine,
  store: ChatStore,
  chatId: string,
  provider: ChatProvider,
  text: string,
  options: ChatOptions & { system?: string } = {},
  signal?: AbortSignal,
): Promise<void> {
  const { system, ...chatOptions } = options;
  store.addUserMessage(chatId, text);
  const turns = store.turns(chatId, system);
  const model = store.get(chatId)?.model ?? '';
  store.startReply(chatId);
  let ended = false;
  try {
    for await (const event of engine.chat(provider, model, turns, chatOptions, signal)) {
      store.apply(chatId, event);
      if (event.type === 'done' || event.type === 'error') ended = true;
    }
  } catch (error) {
    store.apply(chatId, chatError(provider.name, 'upstream', { detail: String(error) }));
    ended = true;
  }
  if (!ended) store.apply(chatId, { type: 'done', status: signal?.aborted ? 'aborted' : 'completed' });
}

function load(storage: StorageLike | null, key: string): Chat[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const data = JSON.parse(raw) as Partial<Persisted>;
    if (data.v !== 1 || !Array.isArray(data.chats)) return [];
    return data.chats.filter(isChat).map((chat) => ({
      ...chat,
      // A reply that was streaming when the page died is a stopped reply now.
      messages: chat.messages.map((m) => (m.status === 'streaming' ? { ...m, status: 'stopped' } : m)),
    }));
  } catch {
    return [];
  }
}

function save(storage: StorageLike | null, key: string, data: Persisted): void {
  if (storage === null) return;
  try {
    storage.setItem(key, JSON.stringify(data));
  } catch {
    // quota or disabled storage: the chats stay usable in memory for this page
  }
}

function isChat(value: unknown): value is Chat {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<Chat>;
  return (
    typeof c.id === 'string' &&
    typeof c.title === 'string' &&
    typeof c.providerId === 'string' &&
    typeof c.model === 'string' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number' &&
    Array.isArray(c.messages) &&
    c.messages.every(isMessage)
  );
}

function isMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<ChatMessage>;
  return (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && typeof m.status === 'string';
}

function clone(chat: Chat): Chat {
  return {
    ...chat,
    messages: chat.messages.map((m) => ({ ...m, ...(m.usage === undefined ? {} : { usage: { ...m.usage } }) })),
  };
}
