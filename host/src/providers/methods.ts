// Provider relay methods on the stream (protocol-v1.md section 15): `provider/list`, `provider/models`,
// `provider/chat` with its `provider/delta`, `provider/usage` and `provider/done` notifications to the
// requesting stream, `provider/abort` and `provider/discover`. A chat lives as long as its stream:
// closing the stream cancels every chat it started.
import type { ProviderCandidate, ProviderChatOptions, ProviderMessage } from '../generated/common.js';
import { isObject } from '../stream/guard.js';
import { RpcError, type MethodRegistry, type RequestContext } from '../stream/router.js';
import { discover as discoverServers } from './discover.js';
import { ProviderFailure } from './http.js';
import type { ProviderRelay, ProviderTarget } from './relay.js';
import { PROVIDER_KINDS, type ProviderKind } from './url.js';

export interface ProviderMethodsOptions {
  relay: ProviderRelay;
  /** Sends a notification on one stream; false when the stream is gone. */
  notify: (streamId: string, method: string, params: Record<string, unknown>) => boolean;
  /** `provider/discover`. Default: probe this Mac's addresses. */
  discover?: () => Promise<ProviderCandidate[]>;
  /** One line per finished chat; never message content or keys. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}

type Params = Record<string, unknown>;
const ROLES: readonly ProviderMessage['role'][] = ['system', 'user', 'assistant'];

const bad = (key: string, message: string) => RpcError.invalidParams(`params.${key}`, message);

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') throw bad(key, `${key} must be a non-empty string`);
  return value;
}

function optStr(params: Params, key: string): string | undefined {
  return params[key] === undefined ? undefined : str(params, key);
}

/** `providerId`, `baseURL` and `kind` of a request. */
export function targetOf(params: Params): ProviderTarget {
  const kind = params.kind;
  if (kind !== undefined && !PROVIDER_KINDS.includes(kind as ProviderKind)) throw bad('kind', `kind must be one of ${PROVIDER_KINDS.join(', ')}`);
  return { providerId: optStr(params, 'providerId'), baseURL: optStr(params, 'baseURL'), kind: kind as ProviderKind | undefined };
}

export function messagesOf(params: Params): ProviderMessage[] {
  const value = params.messages;
  if (!Array.isArray(value) || value.length === 0) throw bad('messages', 'messages must be a non-empty array');
  return value.map((m, i) => {
    if (!isObject(m) || !ROLES.includes(m.role as ProviderMessage['role']) || typeof m.content !== 'string') {
      throw bad(`messages.${i}`, `messages[${i}] must be {role: system|user|assistant, content: string}`);
    }
    return { role: m.role as ProviderMessage['role'], content: m.content };
  });
}

export function optionsOf(params: Params): ProviderChatOptions | undefined {
  const value = params.options;
  if (value === undefined) return undefined;
  if (!isObject(value)) throw bad('options', 'options must be an object');
  const options: ProviderChatOptions = {};
  const { temperature, maxTokens, thinking } = value;
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0) throw bad('options.temperature', 'temperature must be a number >= 0');
    options.temperature = temperature;
  }
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1) throw bad('options.maxTokens', 'maxTokens must be an integer >= 1');
    options.maxTokens = maxTokens;
  }
  if (thinking !== undefined) {
    if (typeof thinking !== 'boolean') throw bad('options.thinking', 'thinking must be a boolean');
    options.thinking = thinking;
  }
  return options;
}

/** Registers the five provider methods on the router and returns it. */
export function registerProviderMethods(registry: MethodRegistry, options: ProviderMethodsOptions): MethodRegistry {
  const { relay, notify } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const discover = options.discover ?? (() => discoverServers());
  /** streamId -> requestId -> the controller that cancels that chat. */
  const chats = new Map<string, Map<string, AbortController>>();

  const chatsOf = (context: RequestContext): Map<string, AbortController> => {
    let running = chats.get(context.streamId);
    if (!running) {
      const map = new Map<string, AbortController>();
      running = map;
      chats.set(context.streamId, map);
      context.onClose(() => {
        chats.delete(context.streamId);
        for (const controller of map.values()) controller.abort();
      });
    }
    return running;
  };

  return registry
    .register('provider/list', () => ({ providers: relay.list() }))
    .register('provider/models', async (params) => {
      const provider = relay.resolve(targetOf(params as Params));
      try {
        return { models: await relay.models(provider) };
      } catch (error) {
        // models() without a signal throws only ProviderFailure; anything else is a host bug (internal).
        if (error instanceof ProviderFailure) throw new RpcError('provider_unavailable', error.message, error.toError());
        throw error;
      }
    })
    .register('provider/chat', (params, context) => {
      const p = params as Params;
      const requestId = str(p, 'requestId');
      const provider = relay.resolve(targetOf(p));
      const input = { model: str(p, 'model'), messages: messagesOf(p), options: optionsOf(p) };
      const running = chatsOf(context);
      if (running.has(requestId)) throw bad('requestId', `chat ${requestId} is already running on this stream`);
      const controller = new AbortController();
      running.set(requestId, controller);
      const { streamId } = context;
      const send = (method: string, fields: Record<string, unknown>) => notify(streamId, method, { requestId, ...fields });
      const startedAt = now();
      // Deltas only after the {ok: true} response, so none overtakes it.
      context.afterResponse(() => {
        void relay
          .chat(
            provider,
            input,
            {
              delta: (kind, text) => send('provider/delta', { kind, text }),
              usage: (usage) => send('provider/usage', usage),
            },
            controller.signal,
          )
          .then((outcome) => {
            if (running.get(requestId) === controller) running.delete(requestId);
            send('provider/done', outcome.status === 'failed' ? { status: 'failed', error: outcome.error } : { status: outcome.status });
            log('provider.chat', {
              origin: new URL(provider.baseURL).origin,
              kind: provider.kind,
              model: input.model,
              status: outcome.status,
              ...(outcome.status === 'failed' ? { reason: outcome.error.reason } : {}),
              ms: now() - startedAt,
            });
          });
      });
      return { ok: true as const };
    })
    .register('provider/abort', (params, context) => {
      const requestId = str(params as Params, 'requestId');
      chats.get(context.streamId)?.get(requestId)?.abort();
      return { ok: true as const };
    })
    .register('provider/discover', async () => ({ candidates: await discover() }));
}
