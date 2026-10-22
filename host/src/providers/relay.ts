// The provider relay (protocol-v1.md section 15, ADR 0006): lists the Providers kept on the host, probes
// model lists, and runs streamed chats whose deltas the methods layer forwards to one stream. Stateless
// beyond the dead-host cooldown (ruling R3).
import type { ProviderConfig } from '../config/providers.js';
import type { ProviderError, ProviderInfo, ProviderModel } from '../generated/common.js';
import { RpcError } from '../stream/router.js';
import { ndjsonFramer, sseFramer, type Framer } from './frames.js';
import { Cancelled, ProviderFailure, ProviderHttp, type HttpOptions } from './http.js';
import { isHostRouted, kindForURL, normalizeBaseURL, PROVIDER_KINDS, type ProviderKind } from './url.js';
import { WIRE, type ChatInput, type DeltaKind } from './wire.js';

/** A model list must answer within this (provider-connection.md section 7: unreachable within 10 s). */
export const MODELS_TIMEOUT_MS = 10_000;
/** A chat must produce its first delta within this after the request is sent. */
export const FIRST_TOKEN_TIMEOUT_MS = 30_000;

/** Which provider a request means: one kept on the host, or a host-routed base URL. */
export interface ProviderTarget {
  providerId?: string | undefined;
  baseURL?: string | undefined;
  kind?: ProviderKind | undefined;
}

export interface ResolvedProvider {
  baseURL: string;
  kind: ProviderKind;
  apiKey?: string | undefined;
}

export interface ChatSink {
  delta(kind: DeltaKind, text: string): void;
  usage(usage: { inputTokens?: number; outputTokens?: number }): void;
}

export type ChatOutcome = { status: 'completed' } | { status: 'aborted' } | { status: 'failed'; error: ProviderError };

export interface RelayOptions {
  providers?: readonly ProviderConfig[];
  http?: ProviderHttp | HttpOptions;
  modelsTimeoutMs?: number;
  firstTokenTimeoutMs?: number;
}

export class ProviderRelay {
  readonly http: ProviderHttp;
  private readonly providers: readonly ProviderConfig[];
  private readonly modelsTimeoutMs: number;
  private readonly firstTokenTimeoutMs: number;

  constructor(options: RelayOptions = {}) {
    this.providers = options.providers ?? [];
    this.http = options.http instanceof ProviderHttp ? options.http : new ProviderHttp(options.http);
    this.modelsTimeoutMs = options.modelsTimeoutMs ?? MODELS_TIMEOUT_MS;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? FIRST_TOKEN_TIMEOUT_MS;
  }

  /** `provider/list`: never the key, only whether there is one. */
  list(): ProviderInfo[] {
    return this.providers.map((p) => ({ id: p.id, name: p.name, baseURL: p.baseURL, kind: kindForURL(p.baseURL), hasKey: p.apiKey !== undefined }));
  }

  /** Names of the Providers kept on the host, for `nano-host status`. */
  names(): string[] {
    return this.providers.map((p) => p.name);
  }

  /**
   * The base URL, kind and key a request means. An id must be known (`not_found`). A base URL must be
   * host-routed under ADR 0006 unless it is one kept on the host, whose key it then uses.
   */
  resolve(target: ProviderTarget): ResolvedProvider {
    if (target.kind !== undefined && !PROVIDER_KINDS.includes(target.kind)) {
      throw RpcError.invalidParams('params.kind', `kind must be one of ${PROVIDER_KINDS.join(', ')}`);
    }
    let found: ProviderConfig | undefined;
    if (target.providerId !== undefined) {
      found = this.providers.find((p) => p.id === target.providerId);
      if (!found) throw new RpcError('not_found', `no provider ${target.providerId} on this host`, { providerId: target.providerId });
    } else if (target.baseURL !== undefined) {
      const baseURL = normalizeBaseURL(target.baseURL);
      if (baseURL === null) throw RpcError.invalidParams('params.baseURL', 'baseURL must be an http or https URL');
      found = this.providers.find((p) => p.baseURL === baseURL);
      if (!found) {
        if (!isHostRouted(baseURL)) {
          throw RpcError.invalidParams('params.baseURL', 'baseURL is a public https server; the app calls it directly (ADR 0006)');
        }
        return { baseURL, kind: target.kind ?? kindForURL(baseURL) };
      }
    } else {
      throw RpcError.invalidParams('params.providerId', 'name a providerId or a baseURL');
    }
    return { baseURL: found.baseURL, kind: target.kind ?? kindForURL(found.baseURL), apiKey: found.apiKey };
  }

  /** `provider/models`: throws ProviderFailure or Cancelled. */
  async models(provider: ResolvedProvider, signal?: AbortSignal): Promise<ProviderModel[]> {
    const wire = WIRE[provider.kind];
    const response = await this.http.send(wire.modelsRequest(provider.baseURL, provider.apiKey), {
      signal,
      headersTimeoutMs: this.modelsTimeoutMs,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (signal?.aborted) throw new Cancelled();
      throw new ProviderFailure('bad_response', 'the model list is not JSON');
    }
    const models = wire.parseModels(body);
    if (models === null) throw new ProviderFailure('bad_response', `the answer is not a ${provider.kind} model list`);
    return models;
  }

  /**
   * Runs one streamed chat to its end and says how it ended; never throws. Deltas and usage go to the
   * sink as they arrive (usage once, at the end). The watchdog cancels the upstream request when no delta
   * came within the first-token timeout; the signal cancels it on abort.
   */
  async chat(provider: ResolvedProvider, input: ChatInput, sink: ChatSink, signal: AbortSignal): Promise<ChatOutcome> {
    const wire = WIRE[provider.kind];
    const upstream = new AbortController();
    const onAbort = () => upstream.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) upstream.abort();
    let watchdogFired = false;
    let watchdog: NodeJS.Timeout | undefined = setTimeout(() => {
      watchdogFired = true;
      upstream.abort();
    }, this.firstTokenTimeoutMs);
    const firstToken = () => {
      clearTimeout(watchdog);
      watchdog = undefined;
    };
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    const outcome = (failure?: unknown): ChatOutcome => {
      if (signal.aborted) return { status: 'aborted' };
      if (watchdogFired) {
        return {
          status: 'failed',
          error: { reason: 'timeout', message: `no first token within ${this.firstTokenTimeoutMs} ms` },
        };
      }
      if (failure === undefined) return { status: 'completed' };
      if (failure instanceof ProviderFailure) return { status: 'failed', error: failure.toError() };
      return { status: 'failed', error: { reason: 'unreachable', message: `the stream broke: ${(failure as Error).message}` } };
    };
    try {
      const response = await this.http.send(wire.chatRequest(provider.baseURL, provider.apiKey, input), { signal: upstream.signal });
      const framer: Framer = wire.framing === 'sse' ? sseFramer() : ndjsonFramer();
      const decoder = new TextDecoder();
      let ended = false;
      const handle = (frames: ReturnType<Framer['push']>): void => {
        for (const frame of frames) {
          if (ended) return;
          if ('done' in frame) {
            ended = true;
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            throw new ProviderFailure('bad_response', `not JSON: ${frame.data.slice(0, 80)}`);
          }
          for (const event of wire.parse(parsed)) {
            switch (event.type) {
              case 'delta':
                firstToken();
                sink.delta(event.kind, event.text);
                break;
              case 'usage':
                if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
                if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
                break;
              case 'done':
                ended = true;
                return;
              case 'error':
                throw new ProviderFailure('upstream', `the provider reported an error: ${event.message}`);
            }
          }
        }
      };
      if (response.body) {
        for await (const chunk of response.body) {
          handle(framer.push(decoder.decode(chunk as Uint8Array, { stream: true })));
          if (ended) break;
        }
      }
      if (!ended) handle(framer.push(decoder.decode()).concat(framer.end()));
      if (!ended) throw new ProviderFailure('unreachable', 'the stream ended before the provider finished');
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) sink.usage(usage);
      return outcome();
    } catch (error) {
      if (error instanceof Cancelled) return outcome();
      return outcome(error);
    } finally {
      firstToken();
      signal.removeEventListener('abort', onAbort);
      upstream.abort(); // releases the connection when the stream ended early
    }
  }
}
