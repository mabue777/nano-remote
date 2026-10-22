// Stream framing for the direct route: Server-Sent Events (OpenAI-compatible, Anthropic) and
// newline-delimited JSON (Ollama). Bytes in, one frame's text out; chunk boundaries may fall anywhere,
// including inside a UTF-8 character.

export type Framing = 'sse' | 'ndjson';

export interface Frame {
  /** The SSE `event:` field, when present. */
  event?: string;
  /** SSE: the `data:` lines joined by newlines. NDJSON: one line. */
  data: string;
}

export interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Splits a byte stream into frames. Stops at the end of the stream; a read error propagates. */
export async function* frames(reader: ByteReader, framing: Framing): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  const parser = framing === 'sse' ? new SseParser() : new NdjsonParser();
  for (;;) {
    const { done, value } = await reader.read();
    const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
    yield* parser.push(text);
    if (done) break;
  }
  yield* parser.end();
}

interface Parser {
  push(text: string): Frame[];
  end(): Frame[];
}

/** Lines from text chunks, accepting `\n`, `\r\n` and `\r` endings. */
class Lines {
  private rest = '';
  private pendingCR = false;

  push(text: string): string[] {
    let input = text;
    if (this.pendingCR && input.startsWith('\n')) input = input.slice(1);
    this.pendingCR = false;
    const parts = (this.rest + input).split(/\r\n|\r|\n/);
    this.rest = parts.pop() as string;
    if (input.endsWith('\r')) this.pendingCR = true;
    return parts;
  }

  end(): string[] {
    const rest = this.rest;
    this.rest = '';
    return rest === '' ? [] : [rest];
  }
}

class NdjsonParser implements Parser {
  private readonly lines = new Lines();

  push(text: string): Frame[] {
    return toFrames(this.lines.push(text));
  }

  end(): Frame[] {
    return toFrames(this.lines.end());
  }
}

function toFrames(lines: string[]): Frame[] {
  return lines.filter((line) => line.trim() !== '').map((data) => ({ data }));
}

/** The SSE event-stream format: `field: value` lines, a blank line dispatches, `:` lines are comments. */
class SseParser implements Parser {
  private readonly lines = new Lines();
  private data: string[] = [];
  private event: string | undefined;

  push(text: string): Frame[] {
    return this.feed(this.lines.push(text));
  }

  end(): Frame[] {
    return [...this.feed(this.lines.end()), ...this.dispatch()];
  }

  private feed(lines: string[]): Frame[] {
    const out: Frame[] = [];
    for (const line of lines) {
      if (line === '') out.push(...this.dispatch());
      else if (!line.startsWith(':')) this.field(line);
    }
    return out;
  }

  private field(line: string): void {
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') this.data.push(value);
    else if (name === 'event') this.event = value;
  }

  private dispatch(): Frame[] {
    const frame: Frame | null = this.data.length === 0 ? null : { data: this.data.join('\n') };
    if (frame !== null && this.event !== undefined) frame.event = this.event;
    this.data = [];
    this.event = undefined;
    return frame === null ? [] : [frame];
  }
}
