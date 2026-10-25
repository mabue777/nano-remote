import { describe, expect, it } from 'vitest';

import { BOTTOM_SLACK, distanceFromBottom, Follower, type ScrollMetrics } from './autoscroll';

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 600): ScrollMetrics => ({ scrollTop, scrollHeight, clientHeight });

describe('distanceFromBottom', () => {
  it('is how far the list is from its end, never negative', () => {
    expect(distanceFromBottom(at(1400))).toBe(0);
    expect(distanceFromBottom(at(1000))).toBe(400);
    expect(distanceFromBottom(at(1500))).toBe(0);
  });
});

describe('Follower', () => {
  it('eases toward the new bottom over frames', () => {
    const f = new Follower(0.5);
    const m = at(1000);
    const positions: number[] = [];
    for (let i = 0; i < 20; i++) {
      const next = f.step(m);
      if (next === undefined) break;
      positions.push(next);
      m.scrollTop = next;
    }
    expect(positions[0]).toBe(1200); // half of the 400 px left
    expect(positions[1]).toBe(1300);
    expect(positions[positions.length - 1]).toBe(1400);
    expect(f.step(m)).toBeUndefined(); // at the bottom: nothing to do
  });

  it('moves at least a pixel per frame and never past the bottom', () => {
    const f = new Follower(0.01);
    expect(f.step(at(1398))).toBe(1399);
    expect(f.step(at(1399.4))).toBe(1400);
  });

  it('ignores its own scroll events and lets go when the reader scrolls up', () => {
    const f = new Follower(0.5);
    const set = f.step(at(1000))!;
    f.onScroll(at(set)); // the event our own write caused
    expect(f.following).toBe(true);
    f.onScroll(at(900)); // the reader scrolled up
    expect(f.following).toBe(false);
    expect(f.step(at(900))).toBeUndefined();
    f.onScroll(at(1400 - BOTTOM_SLACK)); // back at the bottom by hand
    expect(f.following).toBe(true);
  });

  it('stops the moment a finger is down and decides on release', () => {
    const f = new Follower();
    f.hold();
    expect(f.following).toBe(false);
    f.onScroll(at(1400)); // scrolling under the finger does not resume
    expect(f.following).toBe(false);
    expect(f.step(at(1000))).toBeUndefined();
    f.release(at(1000)); // lifted far from the bottom
    expect(f.following).toBe(false);
    f.hold();
    f.release(at(1390)); // lifted at the bottom
    expect(f.following).toBe(true);
  });

  it('follows again after a jump', () => {
    const f = new Follower();
    f.onScroll(at(100));
    expect(f.following).toBe(false);
    f.jump();
    expect(f.following).toBe(true);
    expect(f.step(at(100))).toBeGreaterThan(100);
  });

  it('a scroll the caller made itself (a send pinning to the bottom) does not stop it, even when content grew since', () => {
    const f = new Follower();
    f.scrolledTo(1400);
    f.onScroll(at(1400, 2200)); // the event arrives after the reply's first rows made the list taller
    expect(f.following).toBe(true);
    f.onScroll(at(1000, 2200)); // the reader's own scroll up still counts
    expect(f.following).toBe(false);
  });

  it('a list that got shorter (a turn folded) pulling the view up is not the reader scrolling away', () => {
    const f = new Follower();
    expect(f.step(at(500, 1301))).toBeGreaterThan(500); // gliding, 201 px to go
    f.onScroll(at(477, 1127)); // folded: 50 px from the new bottom, but the list shrank
    expect(f.following).toBe(true);
    f.onScroll(at(300, 1127)); // the same height: a real scroll up
    expect(f.following).toBe(false);
    f.onScroll(at(200, 1000)); // shrank, but no longer following: stays let go
    expect(f.following).toBe(false);
  });
});
