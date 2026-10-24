import { describe, expect, it } from 'vitest';

import { FrameLoop, FreshSegments, StreamPacer } from './pacer';

describe('StreamPacer', () => {
  it('reveals a burst over a few frames instead of all at once', () => {
    const pacer = new StreamPacer({ catchUpMs: 180, minCharsPerSecond: 90 });
    pacer.push('x'.repeat(60));
    expect(pacer.text).toBe('');
    const steps: number[] = [];
    while (pacer.backlog > 0) steps.push(pacer.tick(16.7));
    expect(steps[0]).toBe(6); // ceil(60 * 16.7 / 180)
    expect(steps.length).toBeGreaterThan(5); // spread over frames
    expect(steps.length).toBeLessThan(40); // but caught up well under a second
    expect(pacer.text).toBe('x'.repeat(60));
    expect(pacer.tick(16.7)).toBe(0); // nothing left
  });

  it('keeps a floor speed so a small backlog still moves every frame', () => {
    const pacer = new StreamPacer({ catchUpMs: 10_000, minCharsPerSecond: 120 });
    pacer.push('abcdef');
    expect(pacer.tick(16.7)).toBe(3); // ceil(120 * 16.7 / 1000) = 3, more than the backlog rule's 1
    expect(pacer.text).toBe('abc');
  });

  it('treats a long stall as one 100 ms frame and never overshoots', () => {
    const pacer = new StreamPacer({ catchUpMs: 100, minCharsPerSecond: 0 });
    pacer.push('0123456789');
    expect(pacer.tick(5_000)).toBe(10);
    pacer.push('ab');
    expect(pacer.tick(-5)).toBe(1); // a clock that went backwards still moves one character
    expect(pacer.text).toBe('0123456789a');
  });

  it('flushes and resets', () => {
    const pacer = new StreamPacer();
    pacer.push('hello');
    pacer.flush();
    expect(pacer.text).toBe('hello');
    expect(pacer.backlog).toBe(0);
    pacer.reset();
    expect(pacer.text).toBe('');
  });
});

describe('FreshSegments', () => {
  it('turns new text into fresh pieces that settle after their fade', () => {
    const s = new FreshSegments(300, 50);
    s.update('Hello', 0);
    expect(s.fresh).toEqual([{ start: 0, text: 'Hello', at: 0 }]);
    s.update('Hello wor', 20); // within the join window: same piece
    expect(s.fresh).toEqual([{ start: 0, text: 'Hello wor', at: 0 }]);
    s.update('Hello world', 100); // a new piece
    expect(s.fresh.map((f) => f.start)).toEqual([0, 9]);
    s.update('Hello world', 100); // nothing new
    expect(s.fresh).toHaveLength(2);
    expect(s.prune(350)).toBe(true); // the first is older than 300 ms
    expect(s.settled).toBe('Hello wor');
    expect(s.fresh).toEqual([{ start: 9, text: 'ld', at: 100 }]);
    expect(s.prune(360)).toBe(false);
    s.update('Hello world', 1_000);
    expect(s.settled).toBe('Hello world');
    expect(s.fresh).toEqual([]);
  });

  it('starts over when the text gets shorter (a replay)', () => {
    const s = new FreshSegments();
    s.update('long text', 0);
    s.update('new', 10);
    expect(s.settled).toBe('');
    expect(s.fresh).toEqual([{ start: 0, text: 'new', at: 10 }]);
  });
});

describe('FrameLoop', () => {
  function fakeFrames() {
    const queue = new Map<number, (t: number) => void>();
    let next = 1;
    return {
      raf: (cb: (t: number) => void) => {
        queue.set(next, cb);
        return next++;
      },
      caf: (h: number) => void queue.delete(h),
      run(time: number) {
        const callbacks = [...queue.values()];
        queue.clear();
        for (const cb of callbacks) cb(time);
      },
      get pending() {
        return queue.size;
      },
    };
  }

  it('runs each frame with its duration while active, then stops by itself', () => {
    const frames = fakeFrames();
    const dts: number[] = [];
    let left = 3;
    const loop = new FrameLoop(
      (dt) => {
        dts.push(dt);
        left -= 1;
      },
      () => left > 0,
      frames.raf,
      frames.caf,
    );
    loop.start();
    loop.start(); // already running: no second chain
    expect(frames.pending).toBe(1);
    frames.run(1000);
    frames.run(1020);
    frames.run(1036);
    expect(dts).toEqual([16.7, 20, 16]);
    expect(loop.running).toBe(false);
    expect(frames.pending).toBe(0);
  });

  it('stops on request', () => {
    const frames = fakeFrames();
    const loop = new FrameLoop(() => undefined, () => true, frames.raf, frames.caf);
    loop.start();
    expect(loop.running).toBe(true);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(frames.pending).toBe(0);
    loop.stop(); // twice is fine
  });
});
