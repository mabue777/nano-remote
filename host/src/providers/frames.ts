// Stream framing for the relay: Server-Sent Events (OpenAI-compatible, Anthropic) and newline-delimited
// JSON (Ollama). Text goes in as it arrives, in any chunking; complete frame payloads come out.

/** The OpenAI-compatible end marker, delivered as `{done: true}` by the SSE framer. */
export const SSE_DONE = '[DONE]';

export type Frame = { done: true } | { data: string };

export interface Framer {
  /** Feeds decoded text; returns the frames it completed. */
  push(text: string): Frame[];
  /** Flushes what is left at the end of the body. */
  end(): Frame[];
}

/** Splits text into lines across chunk boundaries (`\n`, `\r\n` or `\r`). */
class Lines {
  private rest = '';
  private pendingCR = false;

  push(text: string): string[] {
    let input = text;
    // A chunk that ended in "\r" may continue with the "\n" of the same line break.
    if (this.pendingCR && input.startsWith('\n')) input = input.slice(1);
    this.pendingCR = input.endsWith('\r');
    const parts = (this.rest + input).split(/\r\n|\r|\n/);
    this.rest = parts.pop()!;
    return parts;
  }

  end(): string[] {
    const last = this.rest;
    this.rest = '';
    return last === '' ? [] : [last];
  }
}

/** SSE: `data:` lines of one event are joined with `\n`; a blank line dispatches the event. */
export function sseFramer(): Framer {
  const lines = new Lines();
  let data: string[] = [];
  const dispatch = (): Frame[] => {
    if (data.length === 0) return [];
    const payload = data.join('\n');
    data = [];
    return [payload.trim() === SSE_DONE ? { done: true } : { data: payload }];
  };
  const take = (all: string[]): Frame[] => {
    const frames: Frame[] = [];
    for (const line of all) {
      if (line === '') frames.push(...dispatch());
      else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      // `event:`, `id:`, `retry:` and `:` comments carry nothing the relay needs: every format repeats
      // the event type inside the JSON.
    }
    return frames;
  };
  return {
    push: (text) => take(lines.push(text)),
    end: () => [...take(lines.end()), ...dispatch()],
  };
}

/** NDJSON: every non-blank line is one frame. */
export function ndjsonFramer(): Framer {
  const lines = new Lines();
  const take = (all: string[]): Frame[] => all.filter((line) => line.trim() !== '').map((line) => ({ data: line }));
  return {
    push: (text) => take(lines.push(text)),
    end: () => take(lines.end()),
  };
}
