// Runtime guards for what arrives on a stream. The shapes are the generated types from
// protocol/schema/envelope.json and message.json; these functions check a parsed JSON value against
// them by hand (no validator dependency) and report the first offending path.
//
// Envelope problems split in two (spec 2.1, 10): a broken header or envelope body is a protocol error
// and closes the socket (4002); a broken `message` inside a valid `client_message` is answered with
// `invalid_params` and `data.path`, because the envelope itself kept the order intact.
import type * as envelope from '../generated/envelope.js';
import type * as methods from '../generated/methods.js';

export type Ok<T> = { ok: true; value: T };
export type Bad = { ok: false; path: string; message: string };
export type Guarded<T> = Ok<T> | Bad;

export type Message = envelope.NanoRemoteMessageProtocolV1Section3;
export type Request = envelope.Request;
export type Notification = envelope.Notification;

/** Envelopes a client may send (spec 2, `type` row). `client_message.message` is checked separately. */
export type ClientEnvelope =
  | (envelope.Header & { type: 'client_message'; message: unknown })
  | envelope.ClientMessageChunk
  | envelope.Ping
  | envelope.ClientClosed
  | envelope.Ack;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const METHOD = /^[a-z][A-Za-z0-9]*(\/[a-z][A-Za-z0-9]*)*$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CHUNK_BASE64 = 136_536;

const SERVER_TYPES = new Set(['server_message', 'server_message_chunk', 'pong']);
const PING_STATES = new Set(['foreground', 'background']);
const CLOSED_REASONS = new Set(['background', 'user', 'error']);

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const bad = (path: string, message: string): Bad => ({ ok: false, path, message });

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isInt = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min;

/** Parses one text frame into a client envelope. Any failure is a protocol error for the caller. */
export function parseClientEnvelope(text: string): Guarded<ClientEnvelope> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad('', 'frame is not JSON');
  }
  return checkClientEnvelope(value);
}

export function checkClientEnvelope(value: unknown): Guarded<ClientEnvelope> {
  if (!isObject(value)) return bad('', 'envelope must be an object');
  const { type } = value;
  if (typeof type !== 'string') return bad('type', 'type must be a string');
  if (SERVER_TYPES.has(type)) return bad('type', `${type} is a host-to-client envelope`);
  if (!['client_message', 'client_message_chunk', 'ping', 'client_closed', 'ack'].includes(type)) {
    return bad('type', `unknown envelope type ${type}`);
  }
  if (typeof value.client_id !== 'string' || value.client_id.length === 0) {
    return bad('client_id', 'client_id must be a non-empty string');
  }
  if (typeof value.stream_id !== 'string' || !UUID.test(value.stream_id)) {
    return bad('stream_id', 'stream_id must be a UUID');
  }
  if (!isInt(value.seq_id, 1)) return bad('seq_id', 'seq_id must be an integer >= 1');
  if (type === 'client_message') {
    if (!('message' in value)) return bad('message', 'client_message needs a message');
    return ok(value as ClientEnvelope);
  }
  if ('message' in value) return bad('message', `${type} must not carry a message`);
  switch (type) {
    case 'ping':
      if (typeof value.state !== 'string' || !PING_STATES.has(value.state)) {
        return bad('state', 'state must be foreground or background');
      }
      break;
    case 'client_closed':
      if (value.reason !== undefined && (typeof value.reason !== 'string' || !CLOSED_REASONS.has(value.reason))) {
        return bad('reason', 'reason must be background, user or error');
      }
      break;
    case 'client_message_chunk': {
      const chunk = checkChunkBody(value);
      if (!chunk.ok) return chunk;
      break;
    }
  }
  return ok(value as ClientEnvelope);
}

function checkChunkBody(value: Record<string, unknown>): Guarded<true> {
  if (!isInt(value.segment_id, 0)) return bad('segment_id', 'segment_id must be an integer >= 0');
  if (!isInt(value.segment_count, 1)) return bad('segment_count', 'segment_count must be an integer >= 1');
  if (!isInt(value.message_size_bytes, 1)) {
    return bad('message_size_bytes', 'message_size_bytes must be an integer >= 1');
  }
  // The upper bound of message_size_bytes is deliberately not checked here: above the cap is 4009,
  // not a shape error, and the reassembler owns that decision.
  const b64 = value.message_chunk_base64;
  if (typeof b64 !== 'string' || b64.length < 4 || b64.length > MAX_CHUNK_BASE64 || !BASE64.test(b64)) {
    return bad('message_chunk_base64', 'message_chunk_base64 must be base64 of at most 100 KiB');
  }
  return ok(true);
}

/** The id of a request-shaped value, if it has a usable one; lets a broken request still get an error. */
export function requestIdOf(value: unknown): string | number | undefined {
  if (!isObject(value)) return undefined;
  const { id } = value;
  return typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id)) ? id : undefined;
}

/** Checks the `message` of a client_message against message.json (one of four shapes). */
export function checkMessage(value: unknown): Guarded<Message> {
  if (!isObject(value)) return bad('message', 'message must be an object');
  const has = (key: string) => key in value;
  if (has('id') && requestIdOf(value) === undefined) return bad('message.id', 'id must be a string or an integer');
  if (has('method')) {
    if (typeof value.method !== 'string' || !METHOD.test(value.method)) {
      return bad('message.method', 'method must be lower-case segments joined by /');
    }
    if (has('result') || has('error')) return bad('message', 'a request or notification has no result or error');
    if (has('params') && !isObject(value.params)) return bad('message.params', 'params must be an object');
    return ok(value as unknown as Message);
  }
  if (!has('id')) return bad('message', 'message needs a method or an id');
  if (has('result') === has('error')) return bad('message', 'a response has exactly one of result and error');
  if (has('result')) {
    return isObject(value.result) ? ok(value as unknown as Message) : bad('message.result', 'result must be an object');
  }
  const error = value.error;
  if (!isObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
    return bad('message.error', 'error needs a string code and message');
  }
  return ok(value as unknown as Message);
}

export function isRequest(message: Message): message is Request {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: Message): message is Notification {
  return 'method' in message && !('id' in message);
}

/** Checks `initialize` params (methods.json#/$defs/initialize.params). Paths are relative to `params`. */
export function checkInitializeParams(params: unknown): Guarded<methods.InitializeParams> {
  if (!isObject(params)) return bad('params', 'params must be an object');
  if (!isInt(params.protocolVersion, 1)) return bad('params.protocolVersion', 'protocolVersion must be an integer >= 1');
  const client = params.client;
  if (!isObject(client)) return bad('params.client', 'client must be an object');
  for (const key of ['name', 'version', 'platform'] as const) {
    if (typeof client[key] !== 'string') return bad(`params.client.${key}`, `${key} must be a string`);
  }
  if (client.userAgent !== undefined && typeof client.userAgent !== 'string') {
    return bad('params.client.userAgent', 'userAgent must be a string');
  }
  const optOut = params.optOutNotifications;
  if (optOut !== undefined) {
    if (!Array.isArray(optOut)) return bad('params.optOutNotifications', 'optOutNotifications must be an array');
    const index = optOut.findIndex((entry) => typeof entry !== 'string');
    if (index >= 0) return bad(`params.optOutNotifications.${index}`, 'entries must be strings');
  }
  return ok(params as unknown as methods.InitializeParams);
}
