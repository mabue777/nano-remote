// Base URL identity, kind derivation and routing (provider-connection.md section 1, ADR 0006).
import type { ProviderRoute } from './types';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalizes a base URL to its identity: lowercase scheme and host, default port dropped, path prefix
 * without trailing slashes, no query, fragment or credentials. A missing scheme becomes `http` for
 * private hosts and `https` otherwise. Returns null for anything that is not an http(s) URL with a host.
 */
export function normalizeBaseURL(input: string): string | null {
  const text = input.trim();
  if (text === '' || /\s/.test(text)) return null;
  let url = parse(SCHEME.test(text) ? text : `http://${text}`);
  if (url === null) return null;
  if (!SCHEME.test(text) && !isPrivateHost(url.hostname)) url = parse(`https://${text}`);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * ADR 0006: `direct` for https on a public host; `host` (relayed by the paired Nano Host) for http,
 * loopback, private (RFC 1918), link-local, `.local` and tailnet (100.64.0.0/10, `*.ts.net`) addresses.
 * Throws for input that is not a base URL.
 */
export function routeFor(baseURL: string): ProviderRoute {
  const url = parseBase(baseURL);
  if (url.protocol === 'http:' || isPrivateHost(url.hostname)) return 'host';
  return 'direct';
}

/** The host (with port) of a base URL, for display names and messages. */
export function hostLabel(baseURL: string): string {
  return parse(baseURL)?.host ?? baseURL;
}

/** True for loopback, RFC 1918, link-local, CGNAT/tailnet, `.local`, `*.ts.net` and single-label names. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return isPrivateIPv6(host.slice(1, -1));
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.ts.net')) return true;
  const v4 = ipv4(host);
  if (v4 !== null) return isPrivateIPv4(v4);
  return !host.includes('.');
}

function isPrivateIPv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIPv6(host: string): boolean {
  if (host === '::1' || host === '::') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped !== null) {
    const hi = parseInt(mapped[1] ?? '0', 16);
    const lo = parseInt(mapped[2] ?? '0', 16);
    return isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function parse(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

export function parseBase(baseURL: string): URL {
  const normalized = normalizeBaseURL(baseURL);
  if (normalized === null) throw new Error(`not a base URL: ${baseURL}`);
  return new URL(normalized);
}
