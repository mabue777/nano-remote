// Chunking (spec 2.3): a message whose serialized UTF-8 form exceeds 100 KiB travels as consecutive
// `*_message_chunk` envelopes carrying base64 of up to 100 KiB each; the receiver concatenates, decodes
// and parses after the last segment. Reassembled messages are capped at 16 MiB.
import { CloseCode, MAX_MESSAGE_BYTES, SEGMENT_BYTES, SEND_SEGMENT_BYTES } from './constants.js';

export interface Segment {
  segment_id: number;
  segment_count: number;
  message_size_bytes: number;
  message_chunk_base64: string;
}

/** Thrown when a message is too large to send or to reassemble; maps to close code 4009. */
export class MessageTooLarge extends Error {
  readonly size: number;
  constructor(size: number) {
    super(`message of ${size} bytes exceeds the ${MAX_MESSAGE_BYTES} byte cap`);
    this.name = 'MessageTooLarge';
    this.size = size;
  }
}

/** Splits serialized message bytes into segments, or returns null when one plain frame suffices. */
export function splitMessage(bytes: Buffer): Segment[] | null {
  if (bytes.length <= SEGMENT_BYTES) return null;
  if (bytes.length > MAX_MESSAGE_BYTES) throw new MessageTooLarge(bytes.length);
  const count = Math.ceil(bytes.length / SEND_SEGMENT_BYTES);
  const segments: Segment[] = [];
  for (let i = 0; i < count; i += 1) {
    segments.push({
      segment_id: i,
      segment_count: count,
      message_size_bytes: bytes.length,
      message_chunk_base64: bytes.subarray(i * SEND_SEGMENT_BYTES, (i + 1) * SEND_SEGMENT_BYTES).toString('base64'),
    });
  }
  return segments;
}

/** A chunk sequence that breaks the rules; `code` is the close code the stream uses. */
export class ChunkError extends Error {
  readonly code: CloseCode;
  constructor(code: CloseCode, message: string) {
    super(message);
    this.name = 'ChunkError';
    this.code = code;
  }
}

/**
 * Collects one chunked message at a time. `push` returns the reassembled UTF-8 text after the last
 * segment and undefined before it; it throws ChunkError for anything out of order or oversized.
 */
export class Reassembler {
  private parts: Buffer[] = [];
  private received = 0;
  private expected: { count: number; size: number } | null = null;

  /** True while a chunked message is half received: nothing else may arrive on the stream. */
  get inProgress(): boolean {
    return this.expected !== null;
  }

  push(segment: Segment): string | undefined {
    if (segment.message_size_bytes > MAX_MESSAGE_BYTES) {
      throw new ChunkError(CloseCode.tooLarge, `chunked message of ${segment.message_size_bytes} bytes exceeds the cap`);
    }
    if (this.expected === null) {
      if (segment.segment_id !== 0) throw new ChunkError(CloseCode.sequence, 'chunked message must start at segment 0');
      if (segment.segment_count * SEGMENT_BYTES < segment.message_size_bytes) {
        throw new ChunkError(CloseCode.sequence, 'segment_count too small for message_size_bytes');
      }
      this.expected = { count: segment.segment_count, size: segment.message_size_bytes };
    } else if (
      segment.segment_id !== this.parts.length ||
      segment.segment_count !== this.expected.count ||
      segment.message_size_bytes !== this.expected.size
    ) {
      throw new ChunkError(CloseCode.sequence, `segment ${segment.segment_id} out of order`);
    }
    const part = Buffer.from(segment.message_chunk_base64, 'base64');
    if (part.length > SEGMENT_BYTES) throw new ChunkError(CloseCode.tooLarge, 'segment exceeds 100 KiB');
    this.received += part.length;
    if (this.received > this.expected.size) {
      throw new ChunkError(CloseCode.sequence, 'segments exceed the declared message_size_bytes');
    }
    this.parts.push(part);
    if (this.parts.length < this.expected.count) return undefined;
    const { size } = this.expected;
    const text = Buffer.concat(this.parts).toString('utf8');
    const received = this.received;
    this.parts = [];
    this.received = 0;
    this.expected = null;
    if (received !== size) throw new ChunkError(CloseCode.sequence, `reassembled ${received} bytes, declared ${size}`);
    return text;
  }
}
