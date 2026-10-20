import { describe, expect, it } from 'vitest';

import {
  MAX_OUTSTANDING_CODES,
  PAIRING_CODE_LIFETIME_MS,
  PAIRING_FAILURE_WINDOW_MS,
  PAIRING_MAX_FAILURES,
  PairingCodes,
  pairingUrl,
  randomCode,
} from './index.js';

const ORIGIN = 'https://mabue-mbp.tail1234.ts.net:8443';

function codes(sequence?: string[]) {
  const clock = { now: 1_000_000 };
  const queue = sequence ? [...sequence] : undefined;
  const pairing = new PairingCodes({
    origin: () => ORIGIN,
    now: () => clock.now,
    ...(queue ? { generate: () => queue.shift()! } : {}),
  });
  return { pairing, clock };
}

describe('pairing codes', () => {
  it('issues 8-digit codes with a 5-minute lifetime and the QR URL', () => {
    const { pairing } = codes();
    const issued = pairing.issue();
    expect(issued.code).toMatch(/^[0-9]{8}$/);
    expect(issued.expiresAt).toBe(1_000_000 + PAIRING_CODE_LIFETIME_MS);
    expect(PAIRING_CODE_LIFETIME_MS).toBe(300_000);
    expect(issued.url).toBe(`${ORIGIN}/pair#code=${issued.code}`);
    expect(pairingUrl(`${ORIGIN}/`, '00000001')).toBe(`${ORIGIN}/pair#code=00000001`);
    for (let i = 0; i < 50; i += 1) expect(randomCode()).toMatch(/^[0-9]{8}$/);
  });

  it('redeems a code once', () => {
    const { pairing } = codes(['12345678']);
    pairing.issue();
    expect(pairing.redeem('12345678', 'a')).toEqual({ ok: true });
    expect(pairing.redeem('12345678', 'a')).toEqual({ ok: false, reason: 'invalid' });
    expect(pairing.outstanding).toBe(0);
  });

  it('refuses an expired code', () => {
    const { pairing, clock } = codes(['12345678', '87654321']);
    pairing.issue();
    pairing.issue();
    clock.now += PAIRING_CODE_LIFETIME_MS - 1;
    expect(pairing.redeem('87654321', 'a')).toEqual({ ok: true });
    clock.now += 1;
    expect(pairing.redeem('12345678', 'a')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses wrong and malformed codes', () => {
    const { pairing } = codes(['12345678']);
    pairing.issue();
    for (const bad of ['12345679', '1234567', '123456789', 'abcdefgh', 12345678, null, undefined]) {
      expect(pairing.redeem(bad, `src-${String(bad)}`)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(pairing.redeem('12345678', 'other')).toEqual({ ok: true });
  });

  it('rate limits a source after 5 failures per minute, even for the right code', () => {
    const { pairing, clock } = codes(['12345678']);
    pairing.issue();
    for (let i = 0; i < PAIRING_MAX_FAILURES; i += 1) {
      expect(pairing.redeem('00000000', 'attacker')).toEqual({ ok: false, reason: 'invalid' });
      clock.now += 1000;
    }
    expect(pairing.redeem('12345678', 'attacker')).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterMs: PAIRING_FAILURE_WINDOW_MS - PAIRING_MAX_FAILURES * 1000,
    });
    // Another source is not affected.
    expect(pairing.redeem('99999999', 'phone')).toEqual({ ok: false, reason: 'invalid' });
    // Once the oldest failure leaves the window, one more attempt is allowed.
    clock.now = 1_000_000 + PAIRING_FAILURE_WINDOW_MS;
    expect(pairing.redeem('12345678', 'attacker')).toEqual({ ok: true });
  });

  it('keeps at most MAX_OUTSTANDING_CODES and never issues a duplicate', () => {
    const sequence = ['00000001', '00000001', ...Array.from({ length: MAX_OUTSTANDING_CODES + 1 }, (_, i) => String(i + 2).padStart(8, '0'))];
    const { pairing } = codes(sequence);
    const first = pairing.issue();
    const second = pairing.issue();
    expect(second.code).not.toBe(first.code);
    for (let i = 0; i < MAX_OUTSTANDING_CODES; i += 1) pairing.issue();
    expect(pairing.outstanding).toBe(MAX_OUTSTANDING_CODES);
    expect(pairing.redeem(first.code, 'a')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a generator that returns a malformed code', () => {
    const pairing = new PairingCodes({ origin: () => ORIGIN, generate: () => '123' });
    expect(() => pairing.issue()).toThrow(/malformed/);
  });
});
