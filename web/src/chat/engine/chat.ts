// One streaming API for both routes (ADR 0006): the route comes from the provider's base URL, never from
// the caller. Direct providers are called from the phone with their key from this phone's store; host
// providers go through the paired Mac, which keeps their keys.
import { routeFor } from '../providers/url';
import { DeadHosts, directChat, type ChatFetch, type DirectTiming } from './direct';
import { hostChat, type HostLink } from './host';
import type { ChatEvent, ChatOptions, ChatProvider, ChatTurn } from './types';

export interface ChatEngineDeps {
  /** The browser's fetch by default. */
  fetch?: ChatFetch;
  /** The key of a direct provider on this phone (ProviderStore.getKey). */
  keyFor: (providerId: string) => string | null;
  /** The stream client to the paired Mac, or null when there is none. Read at each chat. */
  host: () => HostLink | null;
  timing?: Partial<DirectTiming>;
  now?: () => number;
  random?: () => number;
  requestId?: () => string;
}

export interface ChatEngine {
  /**
   * Streams one reply. The iterable always ends with exactly one `done` or `error` event; aborting the
   * signal ends it with `done` (status `aborted`) and cancels the request upstream.
   */
  chat(
    provider: ChatProvider,
    model: string,
    messages: readonly ChatTurn[],
    options?: ChatOptions,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent>;
}

export function createChatEngine(deps: ChatEngineDeps): ChatEngine {
  const deadHosts = new DeadHosts();
  const fetch: ChatFetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    chat(provider, model, messages, options = {}, signal) {
      if (routeFor(provider.baseURL) === 'host') {
        return hostChat(provider, model, messages, options, signal, {
          host: deps.host(),
          ...(deps.requestId === undefined ? {} : { requestId: deps.requestId }),
        });
      }
      return directChat(provider, model, messages, options, signal, {
        fetch,
        apiKey: deps.keyFor(provider.id),
        deadHosts,
        ...(deps.timing === undefined ? {} : { timing: deps.timing }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.random === undefined ? {} : { random: deps.random }),
      });
    },
  };
}
