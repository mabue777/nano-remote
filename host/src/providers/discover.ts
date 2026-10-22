// "Find local servers" (provider-connection.md section 3 step 6, protocol-v1.md section 15): the host
// probes its own loopback, LAN and tailnet addresses on the ports local model servers use, and reports
// what answers like a model list.
import { networkInterfaces } from 'node:os';

import type { ProviderCandidate } from '../generated/common.js';
import { ipv4, isTailnetIPv4 } from './url.js';
import { WIRE } from './wire.js';

/** Ollama, LM Studio, llama.cpp (9931 now, 8080 before) and common defaults, then vLLM and friends on 8000 to 8020. */
export const DISCOVERY_PORTS: readonly number[] = [11434, 1234, 9931, 8080, ...Array.from({ length: 21 }, (_, i) => 8000 + i)];
export const PROBE_TIMEOUT_MS = 1_000;
/** Probes in flight at once. */
export const DISCOVERY_CONCURRENCY = 64;

export type AddressScope = 'loopback' | 'lan' | 'tailnet';

export interface ScopedAddress {
  address: string;
  scope: AddressScope;
}

export interface DiscoverOptions {
  fetch?: typeof fetch;
  /** Default: 127.0.0.1 plus this Mac's IPv4 interface addresses. */
  addresses?: () => ScopedAddress[];
  ports?: readonly number[];
  timeoutMs?: number;
}

const SCOPE_ORDER: Record<AddressScope, number> = { loopback: 0, lan: 1, tailnet: 2 };

/** 127.0.0.1, then every non-internal IPv4 address of this Mac, as LAN or tailnet (100.64.0.0/10). */
export function ownAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): ScopedAddress[] {
  const found: ScopedAddress[] = [{ address: '127.0.0.1', scope: 'loopback' }];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const parts = ipv4(entry.address);
      if (parts === null || found.some((f) => f.address === entry.address)) continue;
      found.push({ address: entry.address, scope: isTailnetIPv4(parts) ? 'tailnet' : 'lan' });
    }
  }
  return found;
}

/** GET with a hard timeout; the parsed JSON body of a 2xx answer, or undefined. */
async function getJson(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** What answers on one address and port: Ollama's tags, else an OpenAI-style list at /v1/models or /models. */
export async function probe(fetcher: typeof fetch, origin: string, timeoutMs: number): Promise<ProviderCandidate | null> {
  if (WIRE.ollama.parseModels(await getJson(fetcher, `${origin}/api/tags`, timeoutMs)) !== null) return { baseURL: origin, kind: 'ollama' };
  for (const baseURL of [`${origin}/v1`, origin]) {
    if (WIRE['openai-compatible'].parseModels(await getJson(fetcher, `${baseURL}/models`, timeoutMs)) !== null) {
      return { baseURL, kind: 'openai-compatible' };
    }
  }
  return null;
}

/**
 * `provider/discover`. A server that answers on several addresses (bound to all interfaces) is reported
 * once under its first address, loopback before LAN before tailnet.
 */
export async function discover(options: DiscoverOptions = {}): Promise<ProviderCandidate[]> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const addresses = [...(options.addresses ?? (() => ownAddresses()))()].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  const ports = options.ports ?? DISCOVERY_PORTS;
  const jobs = addresses.flatMap(({ address }) => ports.map((port) => ({ port, origin: `http://${address}:${port}` })));
  const results: (ProviderCandidate | null)[] = new Array<ProviderCandidate | null>(jobs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await probe(fetcher, jobs[index]!.origin, timeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, jobs.length) }, worker));
  const seen = new Set<string>();
  const candidates: ProviderCandidate[] = [];
  results.forEach((candidate, i) => {
    if (candidate === null) return;
    const key = `${jobs[i]!.port} ${candidate.kind} ${new URL(candidate.baseURL).pathname}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  });
  return candidates;
}
