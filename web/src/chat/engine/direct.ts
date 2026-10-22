// The direct route (ADR 0006): the phone calls an https provider itself. Runtime behavior follows
// provider-connection.md section 4 with the numbers the host uses (protocol section 15): retries on 429,
// 502, 503 and 504 and once on a connect failure, before any delta, with exponential backoff honoring
// Retry-After; a dead-host cooldown after two connect failures in a row; a first-token watchdog; abort at
// any point, including during a backoff wait.
import { chatError, reasonForStatus } from './errors';
import { frames } from './framing';
import { shapingFor } from './quirks';
import type { ChatEvent, ChatOptions, ChatProvider, ChatTurn } from './types';
import { errorDetail, WIRE, type ChatRequest, type WireFormat } from './wire';

export interface ChatResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type ChatFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<ChatResponseLike>;

export interface DirectTiming {
  /** No delta within this long of sending the request: cancel and fail with `timeout`. */
  firstTokenMs: number;
  /** Backoff before retry n (0-based) is retryBaseMs * 2^n plus up to 25% jitter, capped at retryMaxMs. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** Retries on 429/502/503/504. A connect failure is retried once. */
  maxRetries: number;
  /** A longer Retry-After fails at once with its value. */
  maxRetryAfterMs: number;
  /** Connect failures in a row to one server that start its cooldown, and the cooldown's length. */
  deadHostFailures: number;
  deadHostCooldownMs: number;
}

export const DEFAULT_DIRECT_TIMING: DirectTiming = {
  firstTokenMs: 30_000,
  retryBaseMs: 500,
  retryMaxMs: 8_000,
  maxRetries: 3,
  maxRetryAfterMs: 30_000,
  deadHostFailures: 2,
  deadHostCooldownMs: 20_000,
};

const RETRY_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Connect failures per server (scheme, host, port). Shared by all chats of a page; injected in tests. */
export class DeadHosts {
  private readonly servers = new Map<string, { failures: number; until: number }>();

  /** Milliseconds left in the server's cooldown; 0 when it may be tried. */
  remaining(origin: string, now: number): number {
    const entry = this.servers.get(origin);
    return entry === undefined ? 0 : Math.max(0, entry.until - now);
  }

  failed(origin: string, now: number, timing: DirectTiming): void {
    const entry = this.servers.get(origin) ?? { failures: 0, until: 0 };
    entry.failures += 1;
    if (entry.failures >= timing.deadHostFailures) {
      entry.until = now + timing.deadHostCooldownMs;
      entry.failures = 0;
    }
    this.servers.set(origin, entry);
  }

  succeeded(origin: string): void {
    this.servers.delete(origin);
  }
}

export interface DirectDeps {
  fetch: ChatFetch;
  apiKey: string | null;
  timing?: Partial<DirectTiming>;
  deadHosts?: DeadHosts;
  now?: () => number;
  random?: () => number;
}

const sharedDeadHosts = new DeadHosts();

export async function* directChat(
  provider: ChatProvider,
  model: string,
  turns: readonly ChatTurn[],
  options: ChatOptions,
  signal: AbortSignal | undefined,
  deps: DirectDeps,
): AsyncGenerator<ChatEvent, void> {
  const timing = { ...DEFAULT_DIRECT_TIMING, ...deps.timing };
  const ctx: Attempt = {
    name: provider.name,
    wire: WIRE[provider.kind],
    request: WIRE[provider.kind].request(provider.baseURL, deps.apiKey, model, turns, options, shapingFor(provider, model)),
    origin: '',
    signal,
    timing,
    fetch: deps.fetch,
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
    deadHosts: deps.deadHosts ?? sharedDeadHosts,
  };
  ctx.origin = new URL(ctx.request.url).origin;

  let connectRetried = false;
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) {
      yield { type: 'done', status: 'aborted' };
      return;
    }
    const cooldown = ctx.deadHosts.remaining(ctx.origin, ctx.now());
    if (cooldown > 0) {
      yield chatError(ctx.name, 'unreachable', { retryAfterMs: cooldown });
      return;
    }
    const outcome = yield* attemptOnce(ctx, attempt, connectRetried);
    if (outcome === null) return;
    if (outcome.connectFailure) connectRetried = true;
    await sleep(outcome.retryInMs, signal);
  }
}

interface Attempt {
  name: string;
  wire: WireFormat;
  request: ChatRequest;
  origin: string;
  signal: AbortSignal | undefined;
  timing: DirectTiming;
  fetch: ChatFetch;
  now: () => number;
  random: () => number;
  deadHosts: DeadHosts;
}

type Retry = { retryInMs: number; connectFailure: boolean };

/** One HTTP attempt. Yields events and returns null when the chat ended, or how long to wait before retrying. */
async function* attemptOnce(ctx: Attempt, attempt: number, connectRetried: boolean): AsyncGenerator<ChatEvent, Retry | null> {
  const { name, signal, timing } = ctx;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timing.firstTokenMs);

  try {
    let response: ChatResponseLike;
    try {
      response = await ctx.fetch(ctx.request.url, {
        method: 'POST',
        headers: ctx.request.headers,
        body: ctx.request.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) return yield* end({ type: 'done', status: 'aborted' });
      if (timedOut) return yield* end(chatError(name, 'timeout'));
      ctx.deadHosts.failed(ctx.origin, ctx.now(), timing);
      if (connectRetried) return yield* end(chatError(name, 'unreachable', { detail: String(error) }));
      return { retryInMs: backoff(attempt, timing, ctx.random), connectFailure: true };
    }
    ctx.deadHosts.succeeded(ctx.origin);

    if (response.status < 200 || response.status >= 300) {
      const status = response.status;
      const retryAfterMs = retryAfter(response.headers.get('retry-after'), ctx.now());
      const detail = await failureDetail(response);
      const tooLong = retryAfterMs !== undefined && retryAfterMs > timing.maxRetryAfterMs;
      if (RETRY_STATUS.has(status) && attempt < timing.maxRetries && !tooLong) {
        return { retryInMs: retryAfterMs ?? backoff(attempt, timing, ctx.random), connectFailure: false };
      }
      const extra = retryAfterMs === undefined ? { detail, status } : { detail, status, retryAfterMs };
      return yield* end(chatError(name, reasonForStatus(status), extra));
    }
    if (response.body === null) return yield* end(chatError(name, 'bad_response', { detail: 'the response has no body' }));

    // From here on nothing is retried: part of the reply may already be on screen.
    return yield* end(yield* stream(ctx, response.body, controller.signal, watchdog, () => timedOut));
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** Reads the reply's frames, yielding deltas and usage; returns the event that ends the chat. */
async function* stream(
  ctx: Attempt,
  body: ReadableStream<Uint8Array>,
  attemptSignal: AbortSignal,
  watchdog: ReturnType<typeof setTimeout>,
  timedOut: () => boolean,
): AsyncGenerator<ChatEvent, ChatEvent> {
  const { name, signal, wire } = ctx;
  const reader = body.getReader();
  // A fetch body ends when its request is aborted, but not every body is a fetch body: cancel explicitly.
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  attemptSignal.addEventListener('abort', cancel);
  let ended = false;
  let finished = false;
  try {
    for await (const frame of frames(reader, wire.framing)) {
      for (const event of wire.parse(frame)) {
        if (signal?.aborted) break;
        if (event.type === 'text' || event.type === 'reasoning') {
          clearTimeout(watchdog);
          yield event;
        } else if (event.type === 'usage') yield event;
        else if (event.type === 'finish') finished = true;
        else if (event.type === 'done') ended = true;
        else if (event.type === 'error') return chatError(name, event.malformed ? 'bad_response' : 'upstream', { detail: event.detail });
      }
      if (ended || signal?.aborted) break;
    }
  } catch (error) {
    if (!signal?.aborted && !timedOut()) return chatError(name, 'unreachable', { detail: `the stream broke: ${String(error)}` });
  } finally {
    attemptSignal.removeEventListener('abort', cancel);
    cancel();
  }
  if (signal?.aborted) return { type: 'done', status: 'aborted' };
  if (timedOut()) return chatError(name, 'timeout');
  if (ended || finished) return { type: 'done', status: 'completed' };
  return chatError(name, 'bad_response', { detail: 'the stream ended without its end marker' });
}

async function* end(event: ChatEvent): AsyncGenerator<ChatEvent, null> {
  yield event;
  return null;
}

function backoff(attempt: number, timing: DirectTiming, random: () => number): number {
  const base = timing.retryBaseMs * 2 ** attempt;
  return Math.min(timing.retryMaxMs, Math.round(base * (1 + 0.25 * random())));
}

/** Retry-After as milliseconds: delta seconds or an HTTP date. */
export function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function failureDetail(response: ChatResponseLike): Promise<string> {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    detail = errorDetail(JSON.parse(text));
  } catch {
    // not JSON: keep the text
  }
  return detail.slice(0, 300);
}

/** Resolves after `ms`, or as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
