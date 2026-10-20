// The pairing screen (spec 8): the code comes from the link's fragment (`/pair#code=12345678`) or is
// typed in, the device name defaults to one derived from the user agent, and `POST /v1/pair` redeems
// the code. The host sets the `nano_device` cookie; the app keeps only the clientId (device.ts).
//
// The host answers a wrong, an expired and an already used code with the same 403 `unauthorized` so a
// prober learns nothing; the screen therefore shows one message that names all three causes, and the
// form stays editable for a retry with a fresh code.
import type { StorageLike } from '../replica/storage';
import { saveDevice, type PairedDevice } from './device';
import { Model } from './model';

export const PAIR_ENDPOINT = '/v1/pair';

/** The code in a fragment like `code=12345678` (with or without `#`); empty when absent. */
export function codeFromHash(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return normalizeCode(params.get('code') ?? '');
}

/** Digits only: people paste codes with spaces or dashes ("1234 5678"). */
export function normalizeCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 8);
}

export function isCompleteCode(code: string): boolean {
  return /^\d{8}$/.test(code);
}

/** The `platform` sent with the pairing request: the phone's OS, on the web. */
export function platformOf(userAgent: string): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios-web';
  if (/Android/.test(userAgent)) return 'android-web';
  return 'web';
}

/** A friendly default name like "iPhone (Safari)" for the device list on the host. */
export function defaultDeviceName(userAgent: string): string {
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux|X11/.test(userAgent)
              ? 'Linux'
              : '';
  const browser = /EdgiOS|EdgA|Edg\//.test(userAgent)
    ? 'Edge'
    : /FxiOS|Firefox\//.test(userAgent)
      ? 'Firefox'
      : /CriOS|Chrome\/|Chromium\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : '';
  if (device === '' && browser === '') return 'Web browser';
  if (device === '') return browser;
  return browser === '' ? device : `${device} (${browser})`;
}

export type PairFailure =
  /** 403: wrong, expired or already used (the host does not say which). */
  | { kind: 'bad_code' }
  /** 429: too many wrong codes from this address. */
  | { kind: 'rate_limited'; retryAfterMs: number }
  /** 400 or 415: the request itself is wrong (a bug, or a name the host refuses). */
  | { kind: 'invalid'; message: string }
  /** No answer: the host is down or the phone is offline. */
  | { kind: 'network' }
  /** Anything else from the host. */
  | { kind: 'server'; status: number; message: string };

export type PairOutcome = { ok: true; device: PairedDevice } | { ok: false; failure: PairFailure };

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; credentials: 'same-origin' },
) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; data?: { retryAfterMs?: unknown; path?: unknown } };
}

/** POST /v1/pair and the outcome, never throwing. */
export async function redeemCode(
  fetcher: FetchLike,
  request: { code: string; name: string; userAgent: string },
): Promise<PairOutcome> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetcher(PAIR_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        code: request.code,
        client: { name: request.name, platform: platformOf(request.userAgent), userAgent: request.userAgent },
      }),
    });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & ErrorBody;
  if (response.ok) {
    const clientId = body.clientId;
    const host = body.host as { name?: unknown } | undefined;
    if (typeof clientId !== 'string' || clientId === '') {
      return { ok: false, failure: { kind: 'server', status: response.status, message: 'The host answered without a device id.' } };
    }
    return { ok: true, device: { clientId, hostName: typeof host?.name === 'string' ? host.name : '' } };
  }
  const message = typeof body.error?.message === 'string' ? body.error.message : '';
  switch (response.status) {
    case 403:
      return { ok: false, failure: { kind: 'bad_code' } };
    case 429: {
      const fromBody = body.error?.data?.retryAfterMs;
      const fromHeader = Number(response.headers.get('retry-after')) * 1000;
      const retryAfterMs = typeof fromBody === 'number' ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 60_000;
      return { ok: false, failure: { kind: 'rate_limited', retryAfterMs } };
    }
    case 400:
    case 413:
    case 415:
      return { ok: false, failure: { kind: 'invalid', message } };
    default:
      return { ok: false, failure: { kind: 'server', status: response.status, message } };
  }
}

/** What the screen says about a failure. */
export function failureText(failure: PairFailure): string {
  switch (failure.kind) {
    case 'bad_code':
      return 'That code did not work. It may be wrong, expired (codes last 5 minutes) or already used. Show a new code on the computer and try again.';
    case 'rate_limited':
      return `Too many wrong codes. Wait ${Math.ceil(failure.retryAfterMs / 1000)} s, then try again.`;
    case 'invalid':
      return `The host refused the request${failure.message ? `: ${failure.message}` : '.'}`;
    case 'network':
      return 'Cannot reach the host. Check that this phone is on the tailnet and the host is running, then try again.';
    case 'server':
      return `The host had a problem (${failure.status})${failure.message ? `: ${failure.message}` : '.'} Try again.`;
  }
}

export type PairPhase = 'editing' | 'pairing' | 'paired';

export interface PairModelOptions {
  hash: string;
  userAgent: string;
  fetch: FetchLike;
  storage: StorageLike | null;
  onPaired: (device: PairedDevice) => void;
  /** Date.now, for the rate-limit wait. */
  now?: () => number;
}

export class PairModel extends Model {
  code: string;
  name: string;
  phase: PairPhase = 'editing';
  failure: PairFailure | undefined;
  /** While rate limited: the time (ms) the next attempt is allowed. */
  blockedUntil = 0;
  private readonly now: () => number;

  constructor(private readonly options: PairModelOptions) {
    super();
    this.code = codeFromHash(options.hash);
    this.name = defaultDeviceName(options.userAgent);
    this.now = options.now ?? Date.now;
  }

  /** True when the code came in the link: the screen leads with the name and a single button. */
  get codeFromLink(): boolean {
    return codeFromHash(this.options.hash) !== '';
  }

  get canSubmit(): boolean {
    return this.phase === 'editing' && isCompleteCode(this.code) && this.name.trim() !== '' && this.now() >= this.blockedUntil;
  }

  get errorText(): string | undefined {
    return this.failure === undefined ? undefined : failureText(this.failure);
  }

  setCode(input: string): void {
    this.code = normalizeCode(input);
    this.changed();
  }

  setName(input: string): void {
    this.name = input;
    this.changed();
  }

  async submit(): Promise<boolean> {
    if (!this.canSubmit) return false;
    this.phase = 'pairing';
    this.failure = undefined;
    this.changed();
    const outcome = await redeemCode(this.options.fetch, { code: this.code, name: this.name.trim(), userAgent: this.options.userAgent });
    if (!outcome.ok) {
      this.phase = 'editing';
      this.failure = outcome.failure;
      if (outcome.failure.kind === 'rate_limited') {
        this.blockedUntil = this.now() + outcome.failure.retryAfterMs;
        setTimeout(() => this.changed(), outcome.failure.retryAfterMs); // the button comes back
      }
      // A code that failed is spent or wrong either way: clear it so the retry starts from a fresh one.
      if (outcome.failure.kind === 'bad_code') this.code = '';
      this.changed();
      return false;
    }
    saveDevice(this.options.storage, outcome.device);
    this.phase = 'paired';
    this.changed();
    this.options.onPaired(outcome.device);
    return true;
  }
}
