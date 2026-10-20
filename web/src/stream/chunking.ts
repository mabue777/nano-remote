// Chunking (spec 2.3) with browser primitives only (TextEncoder, btoa, atob), so the same code runs on
// the phone and in Node tests. A message above 100 KiB serialized travels as consecutive chunk envelopes
// carrying base64 of at most 100 KiB of its UTF-8 bytes each; the receiver joins and parses after the last.
import { CloseCode, MAX_MESSAGE_BYTES, SEGMENT_BYTES, SEND_SEGMENT_BYTES } from './constants';

export interface Segment {
  segment_id: number;
  segment_count: number;
  message_size_bytes: number;
  message_chunk_base64: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Throws on text that is not base64. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A broken chunk sequence or an oversized message; `code` is the close code (4002 or 4009). */
export class ChunkError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'ChunkError';
    this.code = code;
  }
}

/** Splits serialized bytes into segments, or returns null when one plain envelope suffices. */
export function splitMessage(bytes: Uint8Array): Segment[] | null {
  if (bytes.length <= SEGMENT_BYTES) return null;
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new ChunkError(CloseCode.tooLarge, `message of ${bytes.length} bytes exceeds the ${MAX_MESSAGE_BYTES} byte cap`);
  }
  const count = Math.ceil(bytes.length / SEND_SEGMENT_BYTES);
  const segments: Segment[] = [];
  for (let i = 0; i < count; i += 1) {
    segments.push({
      segment_id: i,
      segment_count: count,
      message_size_bytes: bytes.length,
      message_chunk_base64: bytesToBase64(bytes.subarray(i * SEND_SEGMENT_BYTES, (i + 1) * SEND_SEGMENT_BYTES)),
    });
  }
  return segments;
}

/** Collects one chunked message at a time; `push` returns the UTF-8 text after the last segment. */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private received = 0;
  private expected: { count: number; size: number } | null = null;

  /** True while a chunked message is half received: no other envelope may arrive in between. */
  get inProgress(): boolean {
    return this.expected !== null;
  }

  push(segment: Segment): string | undefined {
    if (segment.message_size_bytes > MAX_MESSAGE_BYTES) {
      throw new ChunkError(CloseCode.tooLarge, `chunked message of ${segment.message_size_bytes} bytes exceeds the cap`);
    }
    if (this.expected === null) {
      if (segment.segment_id !== 0) throw new ChunkError(CloseCode.sequence, 'chunked message must start at segment 0');
      this.expected = { count: segment.segment_count, size: segment.message_size_bytes };
    } else if (
      segment.segment_id !== this.parts.length ||
      segment.segment_count !== this.expected.count ||
      segment.message_size_bytes !== this.expected.size
    ) {
      throw new ChunkError(CloseCode.sequence, `segment ${segment.segment_id} out of order`);
    }
    let part: Uint8Array;
    try {
      part = base64ToBytes(segment.message_chunk_base64);
    } catch {
      throw new ChunkError(CloseCode.sequence, `segment ${segment.segment_id} is not base64`);
    }
    if (part.length > SEGMENT_BYTES) throw new ChunkError(CloseCode.tooLarge, 'segment exceeds 100 KiB');
    this.received += part.length;
    if (this.received > this.expected.size) {
      throw new ChunkError(CloseCode.sequence, 'segments exceed the declared message_size_bytes');
    }
    this.parts.push(part);
    if (this.parts.length < this.expected.count) return undefined;
    const { size } = this.expected;
    const joined = new Uint8Array(this.received);
    let offset = 0;
    for (const p of this.parts) {
      joined.set(p, offset);
      offset += p.length;
    }
    this.parts = [];
    this.received = 0;
    this.expected = null;
    if (joined.length !== size) throw new ChunkError(CloseCode.sequence, `reassembled ${joined.length} bytes, declared ${size}`);
    try {
      return decoder.decode(joined);
    } catch {
      throw new ChunkError(CloseCode.sequence, 'reassembled message is not UTF-8');
    }
  }
}
