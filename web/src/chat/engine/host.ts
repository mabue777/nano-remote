// The host route (ADR 0006): a provider on http, a private address or the tailnet is called by the paired
// Mac. `provider/chat` goes over the open stream; `provider/delta`, `provider/usage` and `provider/done`
// come back to this stream only and become the same events as the direct route (protocol section 15).
// The host does its own retries and watchdog; the phone fails fast when no stream is open.
import type { ProviderDelta, ProviderDone, ProviderUsage } from '../../generated/events';
import type { ProviderChatParams } from '../../generated/methods';
import type { ClientState } from '../../stream/client';
import { chatError } from './errors';
import type { ChatErrorReason, ChatEvent, ChatOptions, ChatProvider, ChatTurn } from './types';

/** The parts of the StreamClient the host route uses. */
export interface HostLink {
  readonly state: ClientState;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): () => void;
  on(event: 'closed', listener: () => void): () => void;
}

export interface HostDeps {
  /** The stream client, or null when the phone is not paired. */
  host: HostLink | null;
  /** Unique among this stream's running chats; a random UUID by default. */
  requestId?: () => string;
}

const HOST_KINDS: ReadonlySet<string> = new Set(['openai-compatible', 'anthropic', 'ollama']);

/** Error codes from the stream client that mean the Mac cannot be reached. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['connection_lost', 'client_closed', 'timeout']);

const REASONS: ReadonlySet<string> = new Set(['unauthorized', 'rate_limited', 'unreachable', 'timeout', 'not_found', 'upstream', 'bad_response']);

export async function* hostChat(
  provider: ChatProvider,
  model: string,
  turns: readonly ChatTurn[],
  options: ChatOptions,
  signal: AbortSignal | undefined,
  deps: HostDeps,
): AsyncGenerator<ChatEvent, void> {
  const { host } = deps;
  const name = provider.name;
  if (signal?.aborted) {
    yield { type: 'done', status: 'aborted' };
    return;
  }
  if (host === null || host.state !== 'ready') {
    yield chatError(name, 'host_unavailable');
    return;
  }

  const requestId = (deps.requestId ?? (() => crypto.randomUUID()))();
  const queue = new Queue<ChatEvent>();
  let finished = false;
  const finish = (event: ChatEvent): void => {
    if (finished) return;
    finished = true;
    queue.push(event);
    queue.close();
  };
  const mine = (params: Record<string, unknown>): boolean => params.requestId === requestId;
  const abortUpstream = (): void => {
    host.request('provider/abort', { requestId }).catch(() => undefined);
  };
  const onAbort = (): void => {
    if (finished) return;
    abortUpstream();
    finish({ type: 'done', status: 'aborted' });
  };

  const unsubscribe = [
    host.onNotification('provider/delta', (params) => {
      if (!mine(params) || finished) return;
      const delta = params as ProviderDelta;
      if (typeof delta.text === 'string' && delta.text !== '') {
        queue.push({ type: delta.kind === 'reasoning' ? 'reasoning' : 'text', text: delta.text });
      }
    }),
    host.onNotification('provider/usage', (params) => {
      if (!mine(params) || finished) return;
      const usage = params as ProviderUsage;
      const event: ChatEvent = { type: 'usage' };
      if (typeof usage.inputTokens === 'number') event.inputTokens = usage.inputTokens;
      if (typeof usage.outputTokens === 'number') event.outputTokens = usage.outputTokens;
      queue.push(event);
    }),
    host.onNotification('provider/done', (params) => {
      if (!mine(params)) return;
      finish(doneEvent(name, params as ProviderDone));
    }),
    // Closing the stream aborts its chats on the host, and no `done` follows.
    host.on('closed', () => finish(chatError(name, 'host_unavailable', { detail: 'the stream to the Mac closed' }))),
  ];
  signal?.addEventListener('abort', onAbort);

  const params: ProviderChatParams = {
    requestId,
    baseURL: provider.baseURL,
    model,
    messages: turns.map((t) => ({ role: t.role, content: t.content })) as ProviderChatParams['messages'],
  };
  if (HOST_KINDS.has(provider.kind)) params.kind = provider.kind as ProviderChatParams['kind'];
  const shaped = hostOptions(options);
  if (shaped !== undefined) params.options = shaped;
  host.request('provider/chat', params).catch((error: unknown) => finish(requestFailure(name, error)));

  try {
    for await (const event of queue) yield event;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    for (const off of unsubscribe) off();
    // The consumer stopped reading before the end: stop the upstream request too.
    if (!finished) {
      finished = true;
      abortUpstream();
    }
  }
}

function hostOptions(options: ChatOptions): ProviderChatParams['options'] {
  const out: NonNullable<ProviderChatParams['options']> = {};
  if (options.temperature !== undefined) out.temperature = options.temperature;
  if (options.maxTokens !== undefined) out.maxTokens = options.maxTokens;
  if (options.thinking !== undefined) out.thinking = options.thinking;
  return Object.keys(out).length === 0 ? undefined : out;
}

function doneEvent(name: string, done: ProviderDone): ChatEvent {
  if (done.status === 'completed') return { type: 'done', status: 'completed' };
  if (done.status === 'aborted') return { type: 'done', status: 'aborted' };
  const error = done.error;
  const reason: ChatErrorReason = error !== undefined && REASONS.has(error.reason) ? error.reason : 'upstream';
  const extra: { detail?: string; status?: number; retryAfterMs?: number } = {};
  if (error !== undefined) {
    extra.detail = error.message;
    if (typeof error.status === 'number') extra.status = error.status;
    if (typeof error.retryAfterMs === 'number') extra.retryAfterMs = error.retryAfterMs;
  }
  return chatError(name, reason, extra);
}

/** A rejected `provider/chat` request: the Mac is gone, or it refused the request. */
function requestFailure(name: string, error: unknown): ChatEvent {
  const e = error as { code?: unknown; message?: unknown; data?: Record<string, unknown> };
  const code = typeof e.code === 'string' ? e.code : '';
  const detail = typeof e.message === 'string' ? e.message : String(error);
  if (UNREACHABLE_CODES.has(code)) return chatError(name, 'host_unavailable', { detail });
  if (code === 'provider_unavailable' && typeof e.data?.reason === 'string' && REASONS.has(e.data.reason)) {
    const retryAfterMs = typeof e.data.retryAfterMs === 'number' ? e.data.retryAfterMs : undefined;
    return chatError(name, e.data.reason as ChatErrorReason, retryAfterMs === undefined ? { detail } : { detail, retryAfterMs });
  }
  if (code === 'not_found') return chatError(name, 'not_found', { detail });
  return chatError(name, 'upstream', { detail });
}

/** An unbounded single-consumer queue that can be iterated asynchronously. */
class Queue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private closed = false;
  private wake: (() => void) | undefined;

  push(item: T): void {
    this.items.push(item);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
