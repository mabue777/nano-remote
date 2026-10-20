// Numbers fixed by protocol/protocol-v1.md sections 2 and 10. One place, so tests and code agree.

/** Protocol versions this host accepts (spec 12). The 4001 close reason lists them. */
export const ACCEPTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/** The only path that upgrades to a stream (spec 1). */
export const STREAM_PATH = '/v1/stream';

/** Header a non-browser client may send at upgrade (spec 1). Browsers cannot set it. */
export const PROTOCOL_VERSION_HEADER = 'x-nano-protocol-version';

/** Cookie the pairing flow sets for browser clients (spec 1, 8). */
export const DEVICE_COOKIE = 'nano_device';

/** WebSocket close codes used by the host (spec 10). */
export const CloseCode = {
  normal: 1000,
  unsupportedProtocol: 4001,
  sequence: 4002,
  unauthorized: 4003,
  pingTimeout: 4008,
  tooLarge: 4009,
  draining: 4010,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Messages above this many serialized UTF-8 bytes go out as chunks; also the per-segment cap (2.3). */
export const SEGMENT_BYTES = 100 * 1024;

/**
 * Raw bytes per segment the host sends: the largest multiple of 3 within 100 KiB, so no segment's
 * base64 ends in padding and a receiver may decode segment by segment or concatenate the base64 text
 * first (spec 2.3 says "concatenates, decodes"); both give the same bytes.
 */
export const SEND_SEGMENT_BYTES = SEGMENT_BYTES - (SEGMENT_BYTES % 3);

/** Largest reassembled message (2.3); `initialize` advertises it as `limits.maxMessageBytes`. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Unacked buffer bound (2.1): whichever of the two is reached first. */
export const MAX_UNACKED_ENVELOPES = 256;
export const MAX_UNACKED_BYTES = 4 * 1024 * 1024;

/** A stream with no `ping` for this long is closed with 4008 (2.2). */
export const PING_TIMEOUT_MS = 90_000;

/** Largest text frame ws accepts at all; anything between MAX_MESSAGE_BYTES and this closes 4009. */
export const MAX_FRAME_BYTES = 2 * MAX_MESSAGE_BYTES;
