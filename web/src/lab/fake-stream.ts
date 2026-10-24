// A fake answer stream that arrives the way a real one does over the network: uneven chunks (a few
// characters to a sentence) at uneven gaps (40-380 ms, now and then a longer pause). Seeded, so Now and
// Smooth replay exactly the same chunks at the same times and only the presentation differs.

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A small seeded random number generator (mulberry32): the same seed gives the same sequence. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Chunk {
  /** Wait before this chunk (ms). */
  delay: number;
  text: string;
}

/** Cuts `text` into chunks with delays, the same way for the same seed. */
export function chunksOf(text: string, seed = 7): Chunk[] {
  const random = seeded(seed);
  const chunks: Chunk[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 3 + Math.floor(random() * 42);
    const pause = random() < 0.08 ? 500 + Math.floor(random() * 400) : 0;
    chunks.push({ delay: 40 + Math.floor(random() * 340) + pause, text: text.slice(at, at + size) });
    at += size;
  }
  return chunks;
}

export class FakeStream {
  private handle: unknown;
  private index = 0;
  private stopped = false;

  constructor(
    private readonly chunks: readonly Chunk[],
    private readonly onChunk: (text: string) => void,
    private readonly onDone: () => void,
    private readonly timers: Timers,
  ) {}

  start(): void {
    this.next();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) this.timers.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private next(): void {
    if (this.stopped) return;
    const chunk = this.chunks[this.index];
    if (chunk === undefined) {
      this.handle = undefined;
      this.onDone();
      return;
    }
    this.handle = this.timers.setTimeout(() => {
      this.index += 1;
      this.onChunk(chunk.text);
      this.next();
    }, chunk.delay);
  }
}
