// Local chat's services for the page's lifetime: the provider store, the chat history and the chat engine.
// They live outside the pairing (local-chat.md ruling R3, ADR 0006): direct providers and the history work
// with no host; the stream client is plugged into the host slot while the phone is paired, and the
// engine reads it at each chat, so a host-routed provider fails in one sentence when it is missing.
import { createChatEngine, type ChatEngine, type ChatFetch } from '../../chat/engine';
import type { HostLink } from '../../chat/engine/host';
import { ChatStore } from '../../chat/engine/history';
import { ProviderStore } from '../../chat/providers/store';
import type { StorageLike } from '../../replica/storage';

/** Holds the stream client to the paired Mac while there is one. */
export class HostSlot {
  private link: HostLink | null = null;

  get current(): HostLink | null {
    return this.link;
  }

  set(link: HostLink | null): void {
    this.link = link;
  }
}

export interface ChatServices {
  providers: ProviderStore;
  chats: ChatStore;
  host: HostSlot;
  engine: ChatEngine;
}

export interface ChatServicesOptions {
  storage: StorageLike | null;
  fetch?: ChatFetch;
}

export function createChatServices({ storage, fetch }: ChatServicesOptions): ChatServices {
  const providers = new ProviderStore({ storage });
  const chats = new ChatStore({ storage });
  const host = new HostSlot();
  const engine = createChatEngine({
    keyFor: (providerId) => providers.getKey(providerId),
    host: () => host.current,
    ...(fetch === undefined ? {} : { fetch }),
  });
  return { providers, chats, host, engine };
}

/** True when this phone has something for local chat without a host: a provider or a chat. */
export function hasLocalChat(services: Pick<ChatServices, 'providers' | 'chats'>): boolean {
  return services.providers.list().length > 0 || services.chats.list().length > 0;
}
