// VAPID (RFC 8292): the host proves to the push service that it owns the key the browser subscribed with.
//
//   Authorization: vapid t=<JWT>, k=<publicKey>
//   JWT = base64url({"typ":"JWT","alg":"ES256"}) . base64url({"aud":<endpoint origin>,"exp":now+12h,"sub":<contact>}) . ES256 (r||s)
//
// One JWT per audience (push service origin) is cached and reused until one hour before it expires, so
// a burst of pushes signs once.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

import type { VapidKeys } from './vapid.js';

/**
 * RFC 8292 `sub`: a contact for the push service operator. It must name a real domain: Apple's push
 * service answers 403 {"reason":"BadJwtToken"} to `mailto:…@localhost` (field check 2026-10-22).
 * Overridden by `vapidContact` in config.json.
 */
export const DEFAULT_VAPID_CONTACT = 'https://github.com/mabue77/nano-remote';

/** A contact Apple, Google and Mozilla accept: `https://<host with a dot>` or `mailto:<user>@<domain with a dot>`, never localhost. */
export function isValidVapidContact(contact: string): boolean {
  let url: URL;
  try {
    url = new URL(contact);
  } catch {
    return false;
  }
  let host: string;
  if (url.protocol === 'https:') host = url.hostname;
  else if (url.protocol === 'mailto:') {
    const match = /^[^@\s]+@([^@\s]+)$/.exec(decodeURIComponent(url.pathname));
    if (!match || url.search !== '') return false;
    host = match[1]!.toLowerCase();
  } else return false;
  return host.includes('.') && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local');
}
/** Lifetime of a JWT (RFC 8292 allows at most 24 h). */
export const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60;
/** A cached JWT is replaced this long before it expires. */
export const VAPID_JWT_RENEW_SECONDS = 60 * 60;

export interface VapidSignerOptions {
  keys: VapidKeys;
  /** `mailto:` or `https:` contact; default DEFAULT_VAPID_CONTACT. */
  contact?: string;
  /** Unix seconds; tests move the clock. */
  now?: () => number;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The private key as a KeyObject: the stored scalar plus the public point's coordinates (JWK). */
export function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const point = Buffer.from(keys.publicKey, 'base64url');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

export class VapidSigner {
  private readonly key: KeyObject;
  private readonly contact: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, { jwt: string; exp: number }>();

  constructor(private readonly options: VapidSignerOptions) {
    this.key = vapidPrivateKey(options.keys);
    this.contact = options.contact ?? DEFAULT_VAPID_CONTACT;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** A JWT for the push service at `audience` (an origin such as `https://web.push.apple.com`). */
  jwt(audience: string): string {
    const now = this.now();
    const cached = this.cache.get(audience);
    if (cached && cached.exp - VAPID_JWT_RENEW_SECONDS > now) return cached.jwt;
    const exp = now + VAPID_JWT_TTL_SECONDS;
    const input = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({ aud: audience, exp, sub: this.contact })}`;
    // ieee-p1363 is the raw r||s form (64 bytes) JWS requires, not DER.
    const signature = sign('sha256', Buffer.from(input), { key: this.key, dsaEncoding: 'ieee-p1363' });
    const jwt = `${input}.${signature.toString('base64url')}`;
    this.cache.set(audience, { jwt, exp });
    return jwt;
  }

  /** The Authorization header value for a push to `endpoint`. */
  authorization(endpoint: string): string {
    return `vapid t=${this.jwt(new URL(endpoint).origin)}, k=${this.options.keys.publicKey}`;
  }
}
