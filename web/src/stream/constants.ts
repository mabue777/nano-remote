// Numbers fixed by protocol/protocol-v1.md sections 1 to 4 and 10, from the phone's side.

/** The protocol version this client speaks; sent in `initialize` on every new stream (spec 4). */
export { PROTOCOL_VERSION } from '../version';

/** Path of the stream endpoint on the host's origin (spec 1). */
export const STREAM_PATH = '/v1/stream';

/** WebSocket close codes (spec 10). The client uses 4002 and 4009 itself for protocol errors it detects. */
export const CloseCode = {
  normal: 1000,
  unsupportedProtocol: 4001,
  sequence: 4002,
  unauthorized: 4003,
  pingTimeout: 4008,
  tooLarge: 4009,
  draining: 4010,
} as const;

/** Messages above this many serialized UTF-8 bytes travel as chunks; also the per-segment cap (2.3). */
export const SEGMENT_BYTES = 100 * 1024;

/** Raw bytes per segment we send: a multiple of 3 so no segment's base64 carries padding (2.3). */
export const SEND_SEGMENT_BYTES = SEGMENT_BYTES - (SEGMENT_BYTES % 3);

/** Largest reassembled message, either direction (2.3). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Unacked window (2.1): the client stops sending messages until acks arrive. */
export const MAX_UNACKED_ENVELOPES = 256;
export const MAX_UNACKED_BYTES = 4 * 1024 * 1024;

/** Timing defaults. Every one can be overridden through StreamClientOptions (tests shrink them). */
export const DEFAULT_TIMING = {
  /** Acks are batched: sent after this delay, or at once when ACK_BATCH envelopes are waiting (2.1). */
  ackDelayMs: 100,
  ackBatch: 16,
  /** Ping cadence (2.2); the host closes with 4008 after 90 s without one. */
  pingIntervalMs: 30_000,
  /** Reconnect backoff: first retry after the minimum, doubling to the maximum, reset on success. */
  backoffMinMs: 500,
  backoffMaxMs: 30_000,
  /** After 4010 (host draining) the next attempt waits at least this long. */
  drainingDelayMs: 5_000,
  /** A request with no response in this time fails (spec 3). */
  requestTimeoutMs: 30_000,
} as const;

export type Timing = { -readonly [K in keyof typeof DEFAULT_TIMING]: number };
