// LF-only framing shared by the Codex and pi engines.
import { describe, expect, it } from 'vitest';

import { LineSplitter } from './line-splitter.js';

function collect(): { lines: string[]; onLine: (line: string) => void } {
  const lines: string[] = [];
  return { lines, onLine: (line) => lines.push(line) };
}

describe('LineSplitter', () => {
  it('ends a line at LF only and keeps U+2028 and U+2029 inside it', () => {
    const { lines, onLine } = collect();
    const record = JSON.stringify({ delta: 'a b c' });
    expect(record).toContain(' ');
    new LineSplitter().push(`${record}\n{"n":2}\n`, onLine);
    expect(lines).toEqual([record, '{"n":2}']);
    expect(JSON.parse(lines[0]!)).toEqual({ delta: 'a b c' });
  });

  it('drops a CR before the LF, keeps a lone CR, and passes empty lines through', () => {
    const { lines, onLine } = collect();
    new LineSplitter().push('one\r\ntw\ro\n\n', onLine);
    expect(lines).toEqual(['one', 'tw\ro', '']);
  });

  it('joins a partial line across chunks', () => {
    const { lines, onLine } = collect();
    const splitter = new LineSplitter();
    splitter.push(Buffer.from('{"b"'), onLine);
    expect(lines).toEqual([]);
    splitter.push(Buffer.from(':1}\n{"c"'), onLine);
    splitter.push(Buffer.from(':2}\n'), onLine);
    expect(lines).toEqual(['{"b":1}', '{"c":2}']);
  });

  it('joins a multibyte UTF-8 character cut between chunks, U+2028 included', () => {
    const { lines, onLine } = collect();
    const splitter = new LineSplitter();
    const bytes = Buffer.from('"€ x"\n');
    // Cut inside the euro sign, then inside U+2028 (E2 80 A8), one byte at a time.
    for (const byte of bytes) splitter.push(Buffer.from([byte]), onLine);
    expect(lines).toEqual(['"€ x"']);
  });

  it('end delivers a last record without LF, once, and nothing when the buffer is empty', () => {
    const { lines, onLine } = collect();
    const splitter = new LineSplitter();
    splitter.push('{"a":1}\n{"last":true}\r', onLine);
    splitter.end(onLine);
    splitter.end(onLine);
    expect(lines).toEqual(['{"a":1}', '{"last":true}']);
  });

  it('end flushes a multibyte character left incomplete as a replacement character', () => {
    const { lines, onLine } = collect();
    const splitter = new LineSplitter();
    splitter.push(Buffer.from('x€').subarray(0, 2), onLine);
    splitter.end(onLine);
    expect(lines).toEqual(['x�']);
  });
});
