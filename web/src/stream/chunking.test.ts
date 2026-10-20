import { describe, expect, it } from 'vitest';

import { ChunkError, Reassembler, base64ToBytes, bytesToBase64, splitMessage, utf8 } from './chunking';
import { CloseCode, MAX_MESSAGE_BYTES, SEGMENT_BYTES, SEND_SEGMENT_BYTES } from './constants';

function segment(id: number, count: number, size: number, base64: string) {
  return { segment_id: id, segment_count: count, message_size_bytes: size, message_chunk_base64: base64 };
}

function codeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    return (error as ChunkError).code;
  }
  return undefined;
}

describe('chunking (spec 2.3)', () => {
  it('base64 round-trips bytes, including multi-byte UTF-8', () => {
    const bytes = utf8('héllo ✓ '.repeat(10_000));
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(utf8('hi'))).toBe(Buffer.from('hi').toString('base64'));
  });

  it('leaves messages up to 100 KiB unsplit', () => {
    expect(splitMessage(new Uint8Array(SEGMENT_BYTES))).toBeNull();
  });

  it('splits larger messages into padding-free segments that reassemble to the same text', () => {
    const text = JSON.stringify({ id: 'c-1', method: 'turn/start', params: { blob: 'ü'.repeat(150_000) } });
    const bytes = utf8(text);
    const segments = splitMessage(bytes)!;
    expect(segments).toHaveLength(Math.ceil(bytes.length / SEND_SEGMENT_BYTES));
    for (const s of segments.slice(0, -1)) expect(s.message_chunk_base64.endsWith('=')).toBe(false);
    const reassembler = new Reassembler();
    let out: string | undefined;
    for (const s of segments) {
      expect(out).toBeUndefined();
      out = reassembler.push(s);
      if (out === undefined) expect(reassembler.inProgress).toBe(true);
    }
    expect(out).toBe(text);
    expect(reassembler.inProgress).toBe(false);
  });

  it('refuses to send a message above 16 MiB (4009)', () => {
    expect(codeOf(() => splitMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1)))).toBe(CloseCode.tooLarge);
  });

  it('rejects broken sequences with 4002 and oversize with 4009', () => {
    const b = bytesToBase64(utf8('{"a":1}'));
    expect(codeOf(() => new Reassembler().push(segment(1, 2, 7, b)))).toBe(CloseCode.sequence);
    expect(codeOf(() => new Reassembler().push(segment(0, 1, MAX_MESSAGE_BYTES + 1, b)))).toBe(CloseCode.tooLarge);
    expect(codeOf(() => new Reassembler().push(segment(0, 1, 7, '%%%')))).toBe(CloseCode.sequence);
    expect(codeOf(() => new Reassembler().push(segment(0, 1, 3, b)))).toBe(CloseCode.sequence); // more than declared
    expect(codeOf(() => new Reassembler().push(segment(0, 1, 9, b)))).toBe(CloseCode.sequence); // fewer than declared
    const big = bytesToBase64(new Uint8Array(SEGMENT_BYTES + 3));
    expect(codeOf(() => new Reassembler().push(segment(0, 1, SEGMENT_BYTES + 3, big)))).toBe(CloseCode.tooLarge);
    const bad = bytesToBase64(new Uint8Array([0xff, 0xfe]));
    expect(codeOf(() => new Reassembler().push(segment(0, 1, 2, bad)))).toBe(CloseCode.sequence); // not UTF-8

    const r = new Reassembler();
    r.push(segment(0, 3, 21, b));
    expect(codeOf(() => r.push(segment(2, 3, 21, b)))).toBe(CloseCode.sequence); // skipped one
    const r2 = new Reassembler();
    r2.push(segment(0, 3, 21, b));
    expect(codeOf(() => r2.push(segment(1, 4, 21, b)))).toBe(CloseCode.sequence); // count changed
    const r3 = new Reassembler();
    r3.push(segment(0, 3, 21, b));
    expect(codeOf(() => r3.push(segment(1, 3, 22, b)))).toBe(CloseCode.sequence); // size changed
  });
});
