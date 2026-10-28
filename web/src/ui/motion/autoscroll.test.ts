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

  it('a longer frame covers what the 60 fps frames in it would have, so a slow device does not trail', () => {
    // Two 60 fps frames at half each leave a quarter of 400 px; one frame twice as long lands at the same place.
    expect(new Follower(0.5).step(at(1000), 2000 / 60)).toBeCloseTo(1300);
    // At 10 fps (headless Chromium measured 2026-10-25) one frame covers about 92% of the way, not 35%.
    expect(new Follower(0.35).step(at(1000), 100)).toBeCloseTo(1000 + 400 * (1 - 0.65 ** 6));
    expect(new Follower(0.5).step(at(1000), 0)).toBe(1001); // no time passed: still the one-pixel minimum
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
    f.scrolledTo(at(1400, 2000));
    f.onScroll(at(1400, 2200)); // the event arrives after the reply's first rows made the list taller
    expect(f.following).toBe(true);
    f.onScroll(at(1000, 2200)); // the reader's own scroll up still counts
    expect(f.following).toBe(false);
  });

  it('ignores a scroll caused by the app layout change, using the height delta since the last programmatic scroll', () => {
    const f = new Follower();
    const set = f.step(at(1000, 2000))!; // 400 px to go; with default ease it moves a bit
    f.onScroll(at(set + 200, 2200)); // content grew 200 px and the browser kept distance from bottom: scrollTop shifted by 200
    expect(f.following).toBe(true);
    f.onScroll(at(set + 200 + 100, 2300)); // content grew another 100 px: still app-caused
    expect(f.following).toBe(true);
    f.onScroll(at(set + 200 + 50, 2300)); // same height, but the reader also scrolled 50 px away
    expect(f.following).toBe(false);
  });

  it('ignores a scroll caused by the app layout change when the list shrinks', () => {
    const f = new Follower();
    f.scrolledTo(at(1400, 2000));
    f.onScroll(at(1300, 1900)); // list shrank 100 px; browser kept distance from bottom
    expect(f.following).toBe(true);
    f.onScroll(at(1200, 1900)); // same shrink, but the reader scrolled another 100 px up
    expect(f.following).toBe(false);
  });

  it('does not mistake a layout-caused scroll for a user scroll while a touch is held', () => {
    const f = new Follower();
    f.hold();
    f.scrolledTo(at(1400, 2000));
    f.onScroll(at(1400, 2200)); // app-caused growth during touch
    expect(f.following).toBe(false); // still not following because the finger is down
  });

  it('treats scrolls during an explicit app layout change as app-caused while following', () => {
    const f = new Follower();
    f.scrolledTo(at(1400, 2000));
    f.startLayoutChange();
    f.onScroll(at(500, 2200)); // would normally be a huge scroll up, but it is during the app layout change
    expect(f.following).toBe(true);
    f.endLayoutChange();
    f.onScroll(at(400, 2200)); // after the layout change, a real scroll up stops following
    expect(f.following).toBe(false);
  });

  it('still lets go for a real user scroll after the app layout change ends', () => {
    const f = new Follower();
    f.scrolledTo(at(1400, 2000));
    f.startLayoutChange();
    f.endLayoutChange();
    f.onScroll(at(900, 2000)); // reader scrolled up
    expect(f.following).toBe(false);
  });

  it('nests explicit layout changes safely', () => {
    const f = new Follower();
    f.scrolledTo(at(1400, 2000));
    f.startLayoutChange();
    f.startLayoutChange();
    f.onScroll(at(500, 2200));
    expect(f.following).toBe(true);
    f.endLayoutChange();
    f.onScroll(at(500, 2200)); // still nested one deep, so still ignored
    expect(f.following).toBe(true);
    f.endLayoutChange();
    f.onScroll(at(400, 2200)); // now outside the layout change and a new position
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
