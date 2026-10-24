import { describe, expect, it } from 'vitest';

import { chunksOf, FakeStream, seeded, type Timers } from './fake-stream';
import { ACTIVITY, SESSIONS } from './fixtures';
import { allAt, loadSettings, saveSettings, STORAGE_KEY, TECHNIQUES } from './settings';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('lab settings', () => {
  it('has ten techniques with unique ids', () => {
    expect(TECHNIQUES).toHaveLength(10);
    expect(new Set(TECHNIQUES.map((t) => t.id)).size).toBe(10);
  });

  it('defaults to Now and round-trips through storage', () => {
    const storage = new MemoryStorage();
    expect(loadSettings(storage)).toEqual(allAt('now'));
    const chosen = { ...allAt('now'), sheet: 'smooth' as const, press: 'smooth' as const };
    saveSettings(storage, chosen);
    expect(loadSettings(storage)).toEqual(chosen);
    expect(Object.values(allAt('smooth')).every((m) => m === 'smooth')).toBe(true);
  });

  it('falls back to Now for broken, partial or unknown data', () => {
    const storage = new MemoryStorage();
    for (const raw of ['not json', 'null', '"text"']) {
      storage.setItem(STORAGE_KEY, raw);
      expect(loadSettings(storage)).toEqual(allAt('now'));
    }
    storage.setItem(STORAGE_KEY, JSON.stringify({ page: 'smooth', sheet: 'fast', extra: 'smooth' }));
    expect(loadSettings(storage)).toEqual({ ...allAt('now'), page: 'smooth' });
    expect(loadSettings(null)).toEqual(allAt('now'));
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => undefined,
    };
    expect(loadSettings(broken)).toEqual(allAt('now'));
    expect(() => saveSettings(broken, allAt('smooth'))).not.toThrow();
    expect(() => saveSettings(null, allAt('smooth'))).not.toThrow();
  });
});

describe('fake stream', () => {
  it('is the same for the same seed and covers the whole text', () => {
    expect(seeded(3)()).toBe(seeded(3)());
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const a = chunksOf(text, 5);
    expect(chunksOf(text, 5)).toEqual(a);
    expect(chunksOf(text, 6)).not.toEqual(a);
    expect(a.map((c) => c.text).join('')).toBe(text);
    for (const c of a) {
      expect(c.text.length).toBeGreaterThanOrEqual(1);
      expect(c.text.length).toBeLessThanOrEqual(44);
      expect(c.delay).toBeGreaterThanOrEqual(40);
      expect(c.delay).toBeLessThan(380 + 900);
    }
    expect(a.some((c) => c.delay >= 500)).toBe(true); // now and then a longer pause
  });

  it('delivers chunks in order on the timers, then says done; stop cancels', () => {
    const pending: { cb: () => void; ms: number }[] = [];
    const timers: Timers = {
      setTimeout: (cb, ms) => {
        pending.push({ cb, ms });
        return pending.length;
      },
      clearTimeout: () => pending.splice(0),
    };
    const got: string[] = [];
    let done = false;
    const stream = new FakeStream(
      [
        { delay: 10, text: 'a' },
        { delay: 20, text: 'b' },
      ],
      (t) => got.push(t),
      () => (done = true),
      timers,
    );
    stream.start();
    expect(pending.map((p) => p.ms)).toEqual([10]);
    pending.shift()!.cb();
    pending.shift()!.cb();
    expect(got).toEqual(['a', 'b']);
    expect(done).toBe(true);

    const stopped = new FakeStream([{ delay: 1, text: 'x' }], (t) => got.push(t), () => undefined, timers);
    stopped.start();
    const cb = pending[0]!.cb;
    stopped.stop();
    expect(pending).toEqual([]);
    cb(); // a timer that fired anyway delivers its chunk but schedules nothing more
    stopped.stop();
    expect(pending).toEqual([]);
  });
});

describe('fixture activity', () => {
  it('adds, reorders with a status change, removes and restores', () => {
    let list = [...SESSIONS];
    const ids: string[][] = [];
    for (const step of ACTIVITY) {
      list = step(list);
      ids.push(list.map((s) => s.id));
    }
    expect(ids[0]![0]).toBe('lint');
    expect(ids[1]![0]).toBe('hello');
    expect(list).toEqual([...SESSIONS]);
    expect(ids[3]).not.toContain('deps');
    const missing = ACTIVITY[1]!(SESSIONS.filter((s) => s.id !== 'hello'));
    expect(missing.map((s) => s.id)).toEqual(SESSIONS.filter((s) => s.id !== 'hello').map((s) => s.id));
  });
});
