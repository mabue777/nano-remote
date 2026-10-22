// The relay's HTTP client (protocol-v1.md section 15, provider-connection.md section 4): retries on 429,
// 502, 503 and 504 with exponential backoff and Retry-After, one retry on a connect failure, and a
// dead-host cooldown after two connect failures in a row to one server. Everything that waits can be
// cancelled through the caller's signal.
import type { ProviderError } from '../generated/common.js';
import type { HttpRequest } from './wire.js';
import { originOf } from './url.js';

export type FailureReason = ProviderError['reason'];

/** A provider request that failed; `toError()` is the wire shape of `provider/done` and `provider_unavailable`. */
export class ProviderFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderFailure';
  }

  toError(): ProviderError {
    return {
      reason: this.reason,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

/** Thrown when the caller's signal ended the request. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export interface HttpOptions {
  fetch?: typeof fetch;
  /** Retries after a retryable status. Default 3. */
  maxRetries?: number;
  /** Retries after a connect failure. Default 1. */
  maxConnectRetries?: number;
  /** First backoff; doubles per retry. Default 500 ms. */
  backoffBaseMs?: number;
  /** Backoff cap. Default 8 s. */
  backoffMaxMs?: number;
  /** The longest Retry-After the client waits out; longer fails at once. Default 30 s. */
  maxRetryAfterMs?: number;
  /** Connect failures in a row that put a server in cooldown. Default 2. */
  cooldownAfter?: number;
  /** How long a dead server is skipped. Default 20 s. */
  cooldownMs?: number;
  now?: () => number;
  /** 0 to 1; jitter is ±20% of the backoff. Default Math.random. */
  random?: () => number;
}

export interface SendOptions {
  signal?: AbortSignal | undefined;
  /** Fails with `unreachable` when no response headers arrived in time (counts as a connect failure). */
  headersTimeoutMs?: number | undefined;
}

interface ServerHealth {
  failures: number;
  until: number;
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Waits `ms`, or rejects with Cancelled when the signal aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function statusFailure(status: number, retryAfter: number | undefined, detail: string): ProviderFailure {
  const suffix = detail === '' ? '' : `: ${detail}`;
  if (status === 401 || status === 403) return new ProviderFailure('unauthorized', `the provider refused the key (HTTP ${status})${suffix}`, status);
  if (status === 429) return new ProviderFailure('rate_limited', `the provider is rate limiting (HTTP 429)${suffix}`, status, retryAfter);
  if (status === 404) return new ProviderFailure('not_found', `the provider answered 404${suffix}`, status);
  return new ProviderFailure('upstream', `the provider answered HTTP ${status}${suffix}`, status, retryAfter);
}

/** The first 200 characters of an error body, for the log line in `message`. */
async function detailOf(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.message === 'string') return cause.message;
  return error instanceof Error ? error.message : String(error);
}

export class ProviderHttp {
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly maxConnectRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly cooldownAfter: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly health = new Map<string, ServerHealth>();

  constructor(options: HttpOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxConnectRetries = options.maxConnectRetries ?? 1;
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 8_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
    this.cooldownAfter = options.cooldownAfter ?? 2;
    this.cooldownMs = options.cooldownMs ?? 20_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Remaining cooldown for the server of `url`, in ms; 0 when it may be tried. */
  cooldownLeft(url: string): number {
    const health = this.health.get(originOf(url));
    return health ? Math.max(0, health.until - this.now()) : 0;
  }

  /** Exponential backoff for retry `attempt` (0-based), with ±20% jitter, capped. */
  backoff(attempt: number): number {
    const base = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt);
    return Math.round(Math.min(this.backoffMaxMs, base * (0.8 + 0.4 * this.random())));
  }

  /**
   * Sends the request and returns a 2xx response whose body is still unread; its body stays tied to the
   * caller's signal. Throws ProviderFailure or Cancelled.
   */
  async send(request: HttpRequest, options: SendOptions = {}): Promise<Response> {
    const { signal } = options;
    const origin = originOf(request.url);
    let statusRetries = 0;
    let connectRetries = 0;
    for (;;) {
      if (signal?.aborted) throw new Cancelled();
      const left = this.cooldownLeft(request.url);
      if (left > 0) {
        throw new ProviderFailure('unreachable', `${origin} failed to connect twice; skipped for ${Math.ceil(left / 1000)} s`, undefined, left);
      }
      let response: Response;
      try {
        response = await this.attempt(request, options);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        const failure = error as ProviderFailure;
        const health = this.health.get(origin) ?? { failures: 0, until: 0 };
        health.failures += 1;
        if (health.failures >= this.cooldownAfter) {
          health.until = this.now() + this.cooldownMs;
          health.failures = 0;
        }
        this.health.set(origin, health);
        if (health.until <= this.now() && connectRetries < this.maxConnectRetries) {
          connectRetries += 1;
          continue;
        }
        throw failure;
      }
      this.health.delete(origin);
      if (response.ok) return response;
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), this.now());
      if (RETRY_STATUSES.has(response.status) && statusRetries < this.maxRetries && (retryAfter ?? 0) <= this.maxRetryAfterMs) {
        await response.body?.cancel().catch(() => {});
        await sleep(retryAfter ?? this.backoff(statusRetries), signal);
        statusRetries += 1;
        continue;
      }
      throw statusFailure(response.status, retryAfter, await detailOf(response));
    }
  }

  /** One fetch. Network errors and the headers timeout become `unreachable`; the caller's abort is Cancelled. */
  private async attempt(request: HttpRequest, { signal, headersTimeoutMs }: SendOptions): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer =
      headersTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, headersTimeoutMs);
    try {
      return await this.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new Cancelled();
      if (timedOut) throw new ProviderFailure('unreachable', `${originOf(request.url)} did not answer within ${headersTimeoutMs} ms`);
      throw new ProviderFailure('unreachable', `cannot connect to ${originOf(request.url)} (${causeOf(error)})`);
    } finally {
      clearTimeout(timer);
    }
  }
}
