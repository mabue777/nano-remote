// Base URL identity, route and kind for the provider relay (protocol-v1.md section 15, ADR 0006).
// Mirrors web/src/chat/providers/url.ts so the phone and the host agree on which URLs are host-routed.
import type { ProviderKind } from '../generated/common.js';

export type { ProviderKind };

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai-compatible', 'ollama', 'anthropic'];

/** Ollama's default port; any host on it is taken to be Ollama. */
export const OLLAMA_PORT = '11434';

/**
 * The identity of a base URL: lowercase scheme and host, default port dropped, path without trailing
 * slashes, no query, fragment or credentials. Null for anything that is not an http(s) URL with a host.
 */
export function normalizeBaseURL(input: string): string | null {
  const text = input.trim();
  if (text === '' || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** ADR 0006: true when the phone reaches this base URL through the host (plain http or a private host). */
export function isHostRouted(baseURL: string): boolean {
  const url = new URL(baseURL);
  return url.protocol === 'http:' || isPrivateHost(url.hostname);
}

/** Loopback, RFC 1918, link-local, CGNAT/tailnet, `.local`, `*.ts.net` and single-label names. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return isPrivateIPv6(host.slice(1, -1));
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.ts.net')) return true;
  const v4 = ipv4(host);
  if (v4 !== null) return isPrivateIPv4(v4);
  return !host.includes('.');
}

export function isPrivateIPv4([a, b]: readonly number[]): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    isTailnetIPv4([a, b])
  );
}

/** 100.64.0.0/10, the range Tailscale assigns. */
export function isTailnetIPv4([a, b]: readonly number[]): boolean {
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

function isPrivateIPv6(host: string): boolean {
  if (host === '::1' || host === '::') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped !== null) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

export function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/**
 * The wire format of a base URL from its host alone (exact or subdomain match, so look-alike hosts do
 * not match): `anthropic.com` is anthropic, `ollama.com` or port 11434 is ollama, the rest is
 * openai-compatible.
 */
export function kindForURL(baseURL: string): ProviderKind {
  const url = new URL(baseURL);
  const host = url.hostname.toLowerCase();
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (under('anthropic.com')) return 'anthropic';
  if (under('ollama.com') || url.port === OLLAMA_PORT) return 'ollama';
  return 'openai-compatible';
}

/** The origin a cooldown is kept for: scheme, host and port. */
export function originOf(url: string): string {
  return new URL(url).origin;
}
