// Concurrent appends from several threads, each with its own connection to one database file. Seq must
// come out dense and unique, in commit order (first wins), with no SQLITE_BUSY failures.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

import { Journal } from './index.js';

const WORKERS = 4;
const APPENDS = 150;

// Workers run journal.ts through Node's built-in type stripping; the hook maps the `.js` import
// specifiers of the TypeScript sources to their `.ts` files.
const WORKER_SOURCE = `
import { registerHooks } from 'node:module';
import { workerData, parentPort } from 'node:worker_threads';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context);
      throw error;
    }
  },
});
const { Journal } = await import(workerData.journalUrl);
const journal = new Journal({ path: workerData.file });
const gate = new Int32Array(workerData.gate);
Atomics.add(gate, 1, 1);
Atomics.wait(gate, 0, 0);
const pause = new Int32Array(new SharedArrayBuffer(4));
const seqs = [];
for (let i = 0; i < workerData.appends; i++) {
  if (i % 2) Atomics.wait(pause, 0, 0, 1); // let the other writers in
  const event = journal.append('ses_a', { method: 'session/closed', params: { reason: workerData.id + ':' + i } });
  seqs.push(event.params.seq);
}
journal.close();
parentPort.postMessage(seqs);
`;

function runWorker(id: number, file: string, gate: SharedArrayBuffer): Promise<number[]> {
  const journalUrl = pathToFileURL(fileURLToPath(new URL('./journal.ts', import.meta.url))).href;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
    workerData: { id, file, gate, journalUrl, appends: APPENDS },
  });
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

describe('concurrent appends across connections', () => {
  it('assigns dense, unique seqs in commit order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'journal-concurrency-'));
    try {
      const file = path.join(dir, 'journal.sqlite');
      new Journal({ path: file }).close(); // create the schema once, before the race
      const gate = new SharedArrayBuffer(8);
      const counters = new Int32Array(gate);
      const results = Array.from({ length: WORKERS }, (_, id) => runWorker(id, file, gate));
      while (Atomics.load(counters, 1) < WORKERS) await new Promise((resolve) => setTimeout(resolve, 5));
      Atomics.store(counters, 0, 1);
      Atomics.notify(counters, 0);
      const perWorker = await Promise.all(results);

      for (const seqs of perWorker) {
        expect(seqs).toHaveLength(APPENDS);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // each writer sees its own seqs increase
      }
      const all = perWorker.flat().sort((a, b) => a - b);
      expect(all).toEqual(Array.from({ length: WORKERS * APPENDS }, (_, i) => i + 1));

      const journal = new Journal({ path: file });
      const events = journal.since('ses_a', 0, 5000).events;
      expect(events.map((e) => e.params.seq)).toEqual(all);
      // The log order is the commit order: the stored event at each seq is the one that writer got back.
      for (const [id, seqs] of perWorker.entries()) {
        seqs.forEach((seq, i) => expect((events[seq - 1]!.params as { reason: string }).reason).toBe(`${id}:${i}`));
      }
      // Writers really interleaved (otherwise this test proves nothing about concurrency).
      const switches = events.filter((e, i) => i > 0 && String(e.params.reason).split(':')[0] !== String(events[i - 1]!.params.reason).split(':')[0]).length;
      expect(switches).toBeGreaterThan(WORKERS);
      expect(journal.head('ses_a')).toBe(WORKERS * APPENDS);
      journal.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
