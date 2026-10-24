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
});
