import { describe, expect, it } from 'vitest';

import { frames, type ByteReader, type Frame, type Framing } from './framing';

/** A reader over the given chunks (strings are UTF-8 encoded; arrays are raw bytes). */
function reader(chunks: (string | number[])[]): ByteReader {
  const queue = chunks.map((c) => (typeof c === 'string' ? new TextEncoder().encode(c) : new Uint8Array(c)));
  return {
    read: async () => {
      const value = queue.shift();
      return value === undefined ? { done: true } : { done: false, value };
    },
  };
}

async function all(chunks: (string | number[])[], framing: Framing): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const frame of frames(reader(chunks), framing)) out.push(frame);
  return out;
}

describe('SSE framing', () => {
  it('joins data lines, keeps the event name, skips comments and frames without data', async () => {
    const text = ': keep-alive\n\nevent: delta\ndata: {"a":1}\ndata: {"b":2}\n\nevent: ping\n\nretry: 10\ndata:x\n\n';
    expect(await all([text], 'sse')).toEqual([{ event: 'delta', data: '{"a":1}\n{"b":2}' }, { data: 'x' }]);
  });

  it('accepts CRLF and CR line endings, including a CRLF split across chunks', async () => {
    expect(await all(['data: a\r', '\n\r', '\ndata: b\r\rdata: c\n\n'], 'sse')).toEqual([{ data: 'a' }, { data: 'b' }, { data: 'c' }]);
  });

  it('dispatches a last event that has no trailing blank line, and a field without a colon', async () => {
    expect(await all(['data: last'], 'sse')).toEqual([{ data: 'last' }]);
    expect(await all(['data\n\n'], 'sse')).toEqual([{ data: '' }]);
  });

  it('decodes a UTF-8 character split across chunks', async () => {
    const bytes = [...new TextEncoder().encode('data: hé\n\n')];
    expect(await all([bytes.slice(0, 8), bytes.slice(8)], 'sse')).toEqual([{ data: 'hé' }]);
  });
});

describe('NDJSON framing', () => {
  it('yields one frame per non-empty line, including a last line without a newline', async () => {
    expect(await all(['{"a":1}\n\n{"b"', ':2}\r\n{"c":3}'], 'ndjson')).toEqual([{ data: '{"a":1}' }, { data: '{"b":2}' }, { data: '{"c":3}' }]);
  });
});
