// The host route of the model probe (ADR 0006, protocol section 15): `provider/models {baseURL, kind?}`
// over the paired host's stream. The stream client queues a request while it reconnects, so a probe only
// fails fast when there is no host at all or the client has stopped for good; otherwise the probe's own
// timeout bounds the wait, and a timeout while the stream is not ready means the Mac is away.
import type { ClientState } from '../../stream/client';
import type { HostProbe, HostProbeReply } from './probe';
import type { ProviderKind } from './types';

/** The parts of the StreamClient a host probe uses (the chat engine's HostLink satisfies it). */
export interface HostRequester {
  readonly state: ClientState;
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** States in which a request can still reach the host (it waits for the stream while connecting). */
const LIVE: ReadonlySet<ClientState> = new Set(['ready', 'connecting', 'waiting', 'suspended']);

/** Stream client error codes that mean the Mac cannot be reached. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['connection_lost', 'client_closed', 'timeout']);

/** The wire formats the relay knows; Gemini is left for the host to derive (it answers openai-compatible). */
const HOST_KINDS: ReadonlySet<ProviderKind> = new Set(['openai-compatible', 'anthropic', 'ollama']);

/** True when a request can reach the host now or once its stream reconnects. */
export function hostAvailable(host: HostRequester | null): host is HostRequester {
  return host !== null && LIVE.has(host.state);
}

/** A HostProbe that asks whichever host `current()` returns at the time of the probe. */
export function createHostProbe(current: () => HostRequester | null): HostProbe {
  return async ({ baseURL, kind, signal }) => {
    const host = current();
    if (!hostAvailable(host)) return { error: 'host-unreachable' };
    const params: Record<string, unknown> = { baseURL };
    if (HOST_KINDS.has(kind)) params.kind = kind;
    const request = host.request<{ models?: unknown }>('provider/models', params).then(
      (result): HostProbeReply => ({ models: Array.isArray(result?.models) ? (result.models as { id: string }[]) : [] }),
      (error: unknown): HostProbeReply => replyForError(error),
    );
    // The probe's timeout (or the user) aborts: the reply no longer matters. While the stream is down that
    // is the Mac being away; otherwise the provider took too long, which the probe reports itself.
    const aborted = new Promise<HostProbeReply>((resolve, reject) => {
      const onAbort = (): void => {
        if (host.state !== 'ready') resolve({ error: 'host-unreachable' });
        else reject(new Error('aborted'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      void request.finally(() => signal.removeEventListener('abort', onAbort));
    });
    return Promise.race([request, aborted]);
  };
}

/** Maps a rejected `provider/models` to a reply: the Mac away, the provider failing, or a refusal. */
export function replyForError(error: unknown): HostProbeReply {
  const e = (error ?? {}) as { code?: unknown; data?: Record<string, unknown> };
  const code = typeof e.code === 'string' ? e.code : '';
  if (UNREACHABLE_CODES.has(code)) return { error: 'host-unreachable' };
  if (code === 'provider_unavailable' && typeof e.data?.reason === 'string') {
    const reply: HostProbeReply = { error: 'provider', reason: e.data.reason };
    if (typeof e.data.status === 'number') reply.status = e.data.status;
    if (typeof e.data.retryAfterMs === 'number') reply.retryAfterMs = e.data.retryAfterMs;
    return reply;
  }
  return { error: 'refused' };
}
