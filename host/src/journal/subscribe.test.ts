// The gap-free guarantee of spec 6: a subscriber attached while a since() or snapshot() read is
// served receives exactly the events after that read's cursor, in seq order, with no duplicate and
// no gap, however appends interleave with the read and the attach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CursorExpired, InvalidParams, Journal } from './index.js';
import type { JournalEvent } from './index.js';
import { agentMessage, itemDelta, itemStarted, statusChanged, turnStarted } from './testing/fixtures.js';

let journal: Journal;

beforeEach(() => {
  journal = new Journal({ path: ':memory:', now: () => 1 });
});

afterEach(() => {
  journal.close();
});

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

function recorder() {
  const seqs: number[] = [];
  const listener = (event: JournalEvent) => {
    seqs.push(event.params.seq);
  };
  return { seqs, listener };
}

function appendN(sessionId: string, n: number): void {
  for (let i = 0; i < n; i++) journal.append(sessionId, itemDelta('itm_1', 'trn_1', `d${i}`));
}

/** Deterministic PRNG so a failing interleaving can be replayed from its seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('subscribe', () => {
  it('without a cursor delivers only events appended after attaching', () => {
    appendN('ses_a', 3);
    const { seqs, listener } = recorder();
    const sub = journal.subscribe('ses_a', listener);
    expect(sub.cursor).toBe(3);
    appendN('ses_a', 2);
    expect(seqs).toEqual([4, 5]);
    expect(sub.cursor).toBe(5);
  });

  it('delivers only its own session', () => {
    const { seqs, listener } = recorder();
    journal.subscribe('ses_a', listener);
    appendN('ses_b', 2);
    appendN('ses_a', 1);
    expect(seqs).toEqual([1]);
  });

  it('since read, appends while the response is in flight, then attach: exactly the events after the cursor', () => {
    appendN('ses_a', 3);
    const read = journal.since('ses_a', 0);
    expect(read.cursor).toBe(3);
    appendN('ses_a', 2); // happen while the read is being served
    const { seqs, listener } = recorder();
    journal.subscribe('ses_a', listener, { after: read.cursor });
    expect(seqs).toEqual([4, 5]); // caught up synchronously on attach
    appendN('ses_a', 2);
    expect(seqs).toEqual([4, 5, 6, 7]);
  });

  it('snapshot read, appends in between, then attach: exactly the events after the snapshot cursor', () => {
    journal.append('ses_a', turnStarted('trn_1'));
    journal.append('ses_a', itemStarted(agentMessage('itm_1', 'trn_1')));
    appendN('ses_a', 3);
    const snap = journal.snapshot('ses_a');
    expect(snap.cursor).toBe(5);
    expect(snap.turns[0]!.items[0]).toMatchObject({ text: 'd0d1d2' });
    appendN('ses_a', 1);
    const { seqs, listener } = recorder();
    journal.subscribe('ses_a', listener, { after: snap.cursor });
    appendN('ses_a', 1);
    expect(seqs).toEqual([6, 7]);
  });

  it('async server flow: read, await, attach while a writer keeps appending — no gap, no duplicate', async () => {
    let writing = true;
    const writer = (async () => {
      while (writing) {
        journal.append('ses_a', statusChanged('running'));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const clients = await Promise.all(
      range(1, 8).map(async (client) => {
        for (let hop = 0; hop < client * 2; hop++) await new Promise((resolve) => setImmediate(resolve));
        const read = client % 2 ? journal.since('ses_a', 0, 3) : journal.snapshot('ses_a');
        await new Promise((resolve) => setImmediate(resolve)); // response goes out; the writer runs meanwhile
        await Promise.resolve();
        const { seqs, listener } = recorder();
        journal.subscribe('ses_a', listener, { after: read.cursor });
        return { cursor: read.cursor, seqs };
      }),
    );
    for (let hop = 0; hop < 5; hop++) await new Promise((resolve) => setImmediate(resolve));
    writing = false;
    await writer;
    const head = journal.head('ses_a');
    expect(head).toBeGreaterThan(10);
    for (const { cursor, seqs } of clients) expect(seqs).toEqual(range(cursor + 1, head));
  });

  it('randomized interleavings of appends, paged reads and attaches deliver exactly (cursor, head]', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = prng(seed);
      const local = new Journal({ path: ':memory:', now: () => 1 });
      const clients: { cursor: number; seqs: number[] }[] = [];
      const reads: number[] = [];
      for (let step = 0; step < 120; step++) {
        const roll = rnd();
        if (roll < 0.55) {
          local.append('ses_a', statusChanged('running'));
        } else if (roll < 0.8) {
          // a read being served: since() from a random older cursor with a random limit, or a snapshot
          const head = local.head('ses_a');
          reads.push(
            rnd() < 0.5
              ? local.since('ses_a', Math.floor(rnd() * (head + 1)), 1 + Math.floor(rnd() * 5)).cursor
              : local.snapshot('ses_a').cursor,
          );
        } else if (reads.length > 0) {
          const cursor = reads.splice(Math.floor(rnd() * reads.length), 1)[0]!;
          const { seqs, listener } = recorder();
          local.subscribe('ses_a', listener, { after: cursor });
          clients.push({ cursor, seqs });
        }
      }
      const head = local.head('ses_a');
      for (const { cursor, seqs } of clients) expect(seqs, `seed ${seed}`).toEqual(range(cursor + 1, head));
      local.close();
    }
  });

  it('catches up across more events than one read page', () => {
    appendN('ses_a', 1203);
    const { seqs, listener } = recorder();
    journal.subscribe('ses_a', listener, { after: 0 });
    expect(seqs).toEqual(range(1, 1203));
  });

  it('a listener that appends keeps every subscriber in strict seq order', () => {
    const a: number[] = [];
    const b: number[] = [];
    journal.subscribe('ses_a', (event) => {
      a.push(event.params.seq);
      if (event.params.seq < 5) journal.append('ses_a', statusChanged('running'));
    });
    journal.subscribe('ses_a', (event) => b.push(event.params.seq));
    journal.append('ses_a', statusChanged('idle'));
    expect(a).toEqual([1, 2, 3, 4, 5]);
    expect(b).toEqual([1, 2, 3, 4, 5]);
  });

  it('a listener that appends during catch-up gets no duplicate of the rest of its batch', () => {
    appendN('ses_a', 3);
    const seen: number[] = [];
    journal.subscribe(
      'ses_a',
      (event) => {
        seen.push(event.params.seq);
        if (event.params.seq === 1) journal.append('ses_a', statusChanged('running'));
      },
      { after: 0 },
    );
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('close stops delivery, also from inside the listener mid catch-up', () => {
    appendN('ses_a', 5);
    const seen: number[] = [];
    const sub = journal.subscribe(
      'ses_a',
      (event, self) => {
        seen.push(event.params.seq);
        if (event.params.seq === 2) self.close();
      },
      { after: 0 },
    );
    expect(seen).toEqual([1, 2]);
    expect(sub.closed).toBe(true);
    appendN('ses_a', 1);
    expect(seen).toEqual([1, 2]);
    sub.close(); // idempotent

    const { seqs, listener } = recorder();
    const other = journal.subscribe('ses_a', listener);
    other.close();
    appendN('ses_a', 1);
    expect(seqs).toEqual([]);
  });

  it('a throwing listener does not stop the append or other subscribers', () => {
    const errors: unknown[] = [];
    const local = new Journal({ path: ':memory:', onListenerError: (error) => errors.push(error) });
    const { seqs, listener } = recorder();
    local.subscribe('ses_a', () => {
      throw new Error('boom');
    });
    local.subscribe('ses_a', listener);
    expect(local.append('ses_a', statusChanged('idle')).params.seq).toBe(1);
    local.append('ses_a', statusChanged('idle'));
    expect(seqs).toEqual([1, 2]);
    expect(errors).toHaveLength(2);
    local.close();
  });

  it('logs listener errors to the console by default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    journal.subscribe('ses_a', () => {
      throw new Error('boom');
    });
    journal.append('ses_a', statusChanged('idle'));
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]![0])).toContain('status/changed seq 1');
    spy.mockRestore();
  });

  it('ends with onExpired when the events it needs were compacted away', () => {
    appendN('ses_a', 5);
    journal.compactForTesting('ses_a', 3);
    const expired: CursorExpired[] = [];
    const sub = journal.subscribe('ses_a', () => {}, { after: 1, onExpired: (e) => expired.push(e) });
    expect(sub.closed).toBe(true);
    expect(expired[0]).toBeInstanceOf(CursorExpired);
    expect(journal.subscribe('ses_a', () => {}, { after: 2 }).closed).toBe(true); // no callback: just closed
  });

  it('ends with onExpired when compaction overtakes it while it is subscribed', () => {
    const expired: CursorExpired[] = [];
    const seen: number[] = [];
    journal.subscribe(
      'ses_a',
      (event) => {
        seen.push(event.params.seq);
        if (event.params.seq === 1) {
          appendN('ses_a', 3);
          journal.compactForTesting('ses_a', 3);
        }
      },
      { onExpired: (e) => expired.push(e) },
    );
    appendN('ses_a', 1);
    expect(seen).toEqual([1]);
    expect(expired).toHaveLength(1);
  });

  it('rethrows storage failures from delivery after unsubscribing', () => {
    const sub = journal.subscribe('ses_a', () => {
      (journal as unknown as { db: { close(): void } }).db.close();
    });
    expect(() => journal.append('ses_a', statusChanged('idle'))).toThrow();
    expect(sub.closed).toBe(true);
  });

  it('rejects a malformed cursor and closes subscriptions with the Journal', () => {
    expect(() => journal.subscribe('ses_a', () => {}, { after: -1 })).toThrow(InvalidParams);
    const sub = journal.subscribe('ses_a', () => {});
    journal.close();
    expect(sub.closed).toBe(true);
  });
});
