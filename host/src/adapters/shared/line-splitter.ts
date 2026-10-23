// LF-only framing for the engines' JSONL stdout. Node's readline also ends a line at U+2028 and U+2029,
// which are legal unescaped inside JSON strings, so a record whose text contains either would arrive as two
// unparsable halves. This splitter ends a line at LF only.

import { StringDecoder } from 'node:string_decoder';

/** Splits a byte stream into LF-terminated records (a preceding CR is dropped). */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer | string, onLine: (line: string) => void): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }

  /** The stream ended: delivers a last record that had no LF, if any (as readline does). */
  end(onLine: (line: string) => void): void {
    const rest = this.buffer + this.decoder.end();
    this.buffer = '';
    if (rest !== '') onLine(rest.endsWith('\r') ? rest.slice(0, -1) : rest);
  }
}
