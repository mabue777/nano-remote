// Pairing codes (protocol-v1.md section 8): the host issues an 8-digit code that lives 5 minutes and
// pairs one device. Redeeming compares in constant time against every outstanding code and is refused
// with `rate_limited` once a source has failed too often within the window, even if the code is right.
import { randomInt, timingSafeEqual } from 'node:crypto';

/** Digits per code (spec 8). Security-pass seam. */
export const PAIRING_CODE_DIGITS = 8;

/** How long a code stays redeemable (spec 8: 5 minutes). Security-pass seam. */
export const PAIRING_CODE_LIFETIME_MS = 5 * 60_000;

/** Failed attempts a source may make within PAIRING_FAILURE_WINDOW_MS before it is rate limited. */
export const PAIRING_MAX_FAILURES = 5;
export const PAIRING_FAILURE_WINDOW_MS = 60_000;

/** Outstanding codes at once; issuing beyond this retires the oldest. Bounds the constant-time scan. */
export const MAX_OUTSTANDING_CODES = 16;

/** Path of the web app's pairing route (client-side; the code travels in the fragment, never to a server log). */
export const PAIR_PATH = '/pair';

export interface IssuedCode {
  code: string;
  /** Unix milliseconds. */
  expiresAt: number;
  /** `https://<host>.<tailnet>.ts.net:<port>/pair#code=<code>`, the QR payload (spec 8). */
  url: string;
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number };

export interface PairingCodesOptions {
  /** Origin of the web app, e.g. `https://mabue-mbp.tail1234.ts.net:8443`. Read on each issue. */
  origin: () => string;
  /** Clock in Unix milliseconds. */
  now?: () => number;
  /** Code generator; tests pin it. Must return PAIRING_CODE_DIGITS digits. */
  generate?: () => string;
}

/** A uniformly random code of PAIRING_CODE_DIGITS digits, zero padded. */
export function randomCode(): string {
  return randomInt(0, 10 ** PAIRING_CODE_DIGITS).toString().padStart(PAIRING_CODE_DIGITS, '0');
}

const CODE_PATTERN = new RegExp(`^[0-9]{${PAIRING_CODE_DIGITS}}$`);

/** The QR URL for a code at an origin. */
export function pairingUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}${PAIR_PATH}#code=${code}`;
}

export class PairingCodes {
  private readonly codes: { code: Buffer; expiresAt: number }[] = [];
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly generate: () => string;

  constructor(private readonly options: PairingCodesOptions) {
    this.now = options.now ?? Date.now;
    this.generate = options.generate ?? randomCode;
  }

  /** Issues a new code. Earlier codes stay valid until they expire or are used. */
  issue(): IssuedCode {
    const now = this.now();
    this.prune(now);
    let code = this.generate();
    while (this.codes.some((c) => c.code.toString() === code)) code = this.generate();
    if (!CODE_PATTERN.test(code)) throw new Error(`pairing code generator returned a malformed code`);
    const expiresAt = now + PAIRING_CODE_LIFETIME_MS;
    this.codes.push({ code: Buffer.from(code), expiresAt });
    while (this.codes.length > MAX_OUTSTANDING_CODES) this.codes.shift();
    return { code, expiresAt, url: pairingUrl(this.options.origin(), code) };
  }

  /** Codes that can still be redeemed. */
  get outstanding(): number {
    this.prune(this.now());
    return this.codes.length;
  }

  /**
   * Redeems `candidate` for `source` (the remote address). A match is consumed (single use). Wrong,
   * malformed, expired and used codes all answer `invalid` and count as a failure for the source.
   */
  redeem(candidate: unknown, source: string): RedeemResult {
    const now = this.now();
    this.prune(now);
    const recent = this.failures.get(source) ?? [];
    if (recent.length >= PAIRING_MAX_FAILURES) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: recent[0]! + PAIRING_FAILURE_WINDOW_MS - now };
    }
    const index = typeof candidate === 'string' && CODE_PATTERN.test(candidate) ? this.match(candidate) : -1;
    if (index < 0) {
      recent.push(now);
      this.failures.set(source, recent);
      return { ok: false, reason: 'invalid' };
    }
    this.codes.splice(index, 1);
    return { ok: true };
  }

  /** Index of the matching code; compares against every code without stopping early. */
  private match(candidate: string): number {
    const bytes = Buffer.from(candidate);
    let found = -1;
    for (let i = 0; i < this.codes.length; i += 1) {
      // Every stored code and every accepted candidate has exactly PAIRING_CODE_DIGITS ASCII bytes.
      if (timingSafeEqual(this.codes[i]!.code, bytes)) found = i;
    }
    return found;
  }

  /** Drops expired codes and failures older than the window. */
  private prune(now: number): void {
    for (let i = this.codes.length - 1; i >= 0; i -= 1) {
      if (this.codes[i]!.expiresAt <= now) this.codes.splice(i, 1);
    }
    for (const [source, times] of this.failures) {
      while (times.length > 0 && times[0]! <= now - PAIRING_FAILURE_WINDOW_MS) times.shift();
      if (times.length === 0) this.failures.delete(source);
    }
  }
}
