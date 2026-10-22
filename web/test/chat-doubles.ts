// Test doubles for the chat engine's direct route: a fake fetch that replays recorded stream fixtures
// (src/chat/engine/fixtures) as real Response bodies, in chunks of any size, optionally stalling so tests
// can abort or let the watchdog fire.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ChatFetch } from '../src/chat/engine/direct';
import type { ChatEvent } from '../src/chat/engine/types';

const dir = fileURLToPath(new URL('../src/chat/engine/fixtures/', import.meta.url));

export function fixture(name: string): string {
  return readFileSync(`${dir}${name}`, 'utf8');
}

/** The first `count` frames of a fixture: SSE events end at a blank line, NDJSON frames at a newline. */
export function cut(text: string, count: number, framing: 'sse' | 'ndjson'): string {
  const separator = framing === 'sse' ? '\n\n' : '\n';
  return text.split(separator).slice(0, count).join(separator) + separator;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** The body; null for a response without one. */
  body?: string | null;
  /** Split the body into chunks of this many bytes (default: one chunk). */
  chunkBytes?: number;
  /** After the body, keep the stream open (until cancelled) instead of closing it. */
  stall?: boolean;
  /** After the body, fail the stream with this error. */
  breakWith?: Error;
  /** Do not answer at all until the request is aborted. */
  hang?: boolean;
  /** Reject like a network failure. */
  reject?: Error;
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

/** A fetch that answers each call with the next reply (the last one repeats); records the calls. */
export function fakeFetch(...replies: Reply[]): { fetch: ChatFetch; calls: FetchCall[]; cancelled: () => number } {
  const calls: FetchCall[] = [];
  let cancelled = 0;
  const fetch: ChatFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown>, signal: init.signal });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
    if (reply.reject !== undefined) throw reply.reject;
    if (reply.hang === true) {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const status = reply.status ?? 200;
    if (reply.body === null) return new Response(null, { status, headers: reply.headers ?? {} });
    const bytes = new TextEncoder().encode(reply.body ?? '');
    const size = reply.chunkBytes ?? Math.max(1, bytes.length);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + size));
          offset += size;
          return;
        }
        if (reply.breakWith !== undefined) controller.error(reply.breakWith);
        else if (reply.stall !== true) controller.close();
        else return new Promise<void>(() => undefined); // stays open until cancelled
      },
      cancel() {
        cancelled += 1;
      },
    });
    return new Response(stream, { status, headers: reply.headers ?? {} });
  };
  return { fetch, calls, cancelled: () => cancelled };
}

export async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** The text of all deltas of one type, joined. */
export function joined(events: ChatEvent[], type: 'text' | 'reasoning'): string {
  return events.map((e) => (e.type === type ? e.text : '')).join('');
}

/** A Map-backed StorageLike. */
export class MemoryStorage {
  readonly data = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota');
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}
