// Model list probing per kind (provider-connection.md section 3, steps 3 and 4): the "Test" button and
// the models cache refresh. Direct providers are fetched from the phone with the injected fetch; host
// providers (ADR 0006) go through a HostProbe that the relay ticket implements. Failures come back as one
// plain sentence that names the provider and the fix, never as the server's raw body.
import type { ModelInfo, ProviderKind } from './types';
import { hostLabel, normalizeBaseURL, routeFor } from './url';

export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponseLike>;

/** What the paired host answers when asked to GET a models endpoint for a host-routed provider. */
export type HostProbeReply =
  | { status: number; body: unknown }
  /** The host could not reach the provider. */
  | { error: 'unreachable' }
  /** The phone could not reach the host. */
  | { error: 'host-unreachable' };

/**
 * Implemented by the relay ticket. The host holds host-routed providers' keys (ADR 0006, ruling R2), so
 * the request names the provider by its normalized base URL and carries no key.
 */
export type HostProbe = (request: {
  baseURL: string;
  kind: ProviderKind;
  /** Path and query relative to the base URL, e.g. `/api/tags`. */
  path: string;
  signal: AbortSignal;
}) => Promise<HostProbeReply>;

export interface ProbeTarget {
  /** Used in messages; falls back to the host. */
  name?: string;
  baseURL: string;
  kind: ProviderKind;
  /** Only for direct providers; ignored for host-routed ones. */
  apiKey?: string | null;
}

export interface ProbeDeps {
  fetch?: FetchLike;
  hostProbe?: HostProbe;
  /** Connect timeout; 10 s by default (section 7: the unreachable message within 10 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ProbeErrorCode =
  | 'invalid-url'
  | 'wrong-key'
  | 'rate-limited'
  | 'unreachable'
  | 'host-unavailable'
  | 'not-found'
  | 'server-error'
  | 'bad-response'
  /** Reachable but empty: the provider may still be saved (section 3 step 4). */
  | 'no-models'
  | 'aborted';

export type ProbeResult = { ok: true; models: ModelInfo[] } | { ok: false; code: ProbeErrorCode; message: string };

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const CANCELLED_MESSAGE = 'The test was cancelled.';

export const HOST_UNAVAILABLE_MESSAGE = 'Your Mac is not reachable; this provider runs through it.';

/** The models endpoint path (relative to the base URL) and request headers for a kind. */
export function modelsRequest(
  baseURL: string,
  kind: ProviderKind,
  apiKey?: string | null,
): { path: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = apiKey ?? '';
  const path = new URL(baseURL).pathname.replace(/\/+$/, '');
  switch (kind) {
    case 'anthropic':
      if (key !== '') headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      return { path: `${path.endsWith('/v1') ? '' : '/v1'}/models?limit=1000`, headers };
    case 'gemini':
      if (key !== '') headers['x-goog-api-key'] = key;
      return { path: `${path === '' ? '/v1beta' : ''}/models?pageSize=1000`, headers };
    case 'ollama':
      if (key !== '') headers.Authorization = `Bearer ${key}`;
      return { path: '/api/tags', headers };
    case 'openai-compatible':
      if (key !== '') headers.Authorization = `Bearer ${key}`;
      return { path: '/models', headers };
  }
}

/** Fetches and parses the model list for a provider over its route. */
export async function probeModels(target: ProbeTarget, deps: ProbeDeps): Promise<ProbeResult> {
  const baseURL = normalizeBaseURL(target.baseURL);
  if (baseURL === null) return fail('invalid-url', 'That is not a server address. Check the base URL.');
  const name = target.name !== undefined && target.name.trim() !== '' ? target.name : hostLabel(baseURL);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (cancelled(deps.signal)) return fail('aborted', CANCELLED_MESSAGE);
  const route = routeFor(baseURL);
  const { path, headers } = modelsRequest(baseURL, target.kind, route === 'direct' ? target.apiKey : null);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  deps.signal?.addEventListener('abort', onAbort);

  let status: number;
  let body: unknown;
  try {
    if (route === 'host') {
      if (deps.hostProbe === undefined) return fail('host-unavailable', HOST_UNAVAILABLE_MESSAGE);
      const reply = await deps.hostProbe({ baseURL, kind: target.kind, path, signal: controller.signal });
      if ('error' in reply) {
        if (reply.error === 'host-unreachable') return fail('host-unavailable', HOST_UNAVAILABLE_MESSAGE);
        return unreachable(name, timeoutMs);
      }
      ({ status, body } = reply);
    } else {
      if (deps.fetch === undefined) throw new Error('probeModels: no fetch for a direct provider');
      const response = await deps.fetch(`${baseURL}${path}`, { method: 'GET', headers, signal: controller.signal });
      status = response.status;
      body = status >= 200 && status < 300 ? await response.json().catch(() => undefined) : undefined;
    }
  } catch {
    if (cancelled(deps.signal) && !timedOut) return fail('aborted', CANCELLED_MESSAGE);
    return unreachable(name, timeoutMs);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }

  if (status === 401 || status === 403 || (status === 400 && target.kind === 'gemini')) {
    return fail('wrong-key', `${name} rejected the key. Check that you pasted the whole key.`);
  }
  if (status === 429) return fail('rate-limited', `${name} is rate limiting requests. Wait a minute and try again.`);
  if (status === 404) return fail('not-found', `${name} has no model list at this address. Check the base URL.`);
  if (status < 200 || status >= 300) {
    return fail('server-error', `${name} answered with an error (HTTP ${status}). Try again later.`);
  }
  const models = parseModels(target.kind, body);
  if (models === null) return fail('bad-response', `${name} answered, but not with a model list. Check the base URL.`);
  if (models.length === 0) {
    return fail('no-models', `${name} answered but lists no models. Check the key or the service status.`);
  }
  return { ok: true, models };
}

/**
 * Parses a models response for a kind; null when the body is not a model list. OpenAI-compatible accepts
 * `{data: [...]}` and bare lists of objects or strings; Ollama reads `models[].name`; Anthropic reads
 * `data[]` with `display_name`; Gemini reads `models[]`, keeping those that can generate content.
 */
export function parseModels(kind: ProviderKind, body: unknown): ModelInfo[] | null {
  let items: unknown;
  if (kind === 'openai-compatible') items = Array.isArray(body) ? body : field(body, 'data');
  else if (kind === 'anthropic') items = field(body, 'data');
  else items = field(body, 'models');
  if (!Array.isArray(items)) return null;

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const item of items) {
    const model = toModel(kind, item);
    if (model === null || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function toModel(kind: ProviderKind, item: unknown): ModelInfo | null {
  if (typeof item === 'string') return item === '' ? null : plain(item, item);
  if (typeof item !== 'object' || item === null) return null;
  const o = item as Record<string, unknown>;
  switch (kind) {
    case 'ollama': {
      const id = str(o.name) ?? str(o.model);
      return id === undefined ? null : plain(id, id);
    }
    case 'anthropic': {
      const id = str(o.id);
      return id === undefined ? null : plain(id, str(o.display_name) ?? id);
    }
    case 'gemini': {
      const name = str(o.name);
      if (name === undefined) return null;
      const methods = o.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes('generateContent')) return null;
      const id = name.replace(/^models\//, '');
      return plain(id, str(o.displayName) ?? id);
    }
    case 'openai-compatible': {
      const id = str(o.id);
      if (id === undefined) return null;
      const model = plain(id, str(o.name) ?? id);
      const params = o.supported_parameters;
      if (Array.isArray(params)) {
        model.capabilities = {
          tools: params.includes('tools'),
          reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
        };
        model.source = 'vendor';
      }
      return model;
    }
  }
}

function plain(id: string, displayName: string): ModelInfo {
  return { id, displayName, capabilities: {}, source: 'unknown' };
}

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function unreachable(name: string, timeoutMs: number): ProbeResult {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return fail(
    'unreachable',
    `${name} did not answer within ${seconds} second${seconds === 1 ? '' : 's'}. Check the address and that the server is running.`,
  );
}

/** A function so TypeScript does not keep the narrowing from the early return across awaits. */
function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function fail(code: ProbeErrorCode, message: string): ProbeResult {
  return { ok: false, code, message };
}
