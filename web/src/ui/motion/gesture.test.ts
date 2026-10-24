import { describe, expect, it } from 'vitest';

import { lockAxis, rubberBand, settleDuration, shouldComplete, VelocityTracker } from './gesture';
import { SHEET_SPRING, springCurve, springEasing } from './spring';

describe('VelocityTracker', () => {
  it('measures speed over the recent window only', () => {
    const v = new VelocityTracker(100);
    expect(v.velocity()).toBe(0);
    v.add(0, 0);
    expect(v.velocity()).toBe(0); // one sample
    v.add(10, 5); // slow start
    v.add(200, 100);
    v.add(250, 200);
    v.add(300, 300); // fast finish: 2 px/ms over the last 100 ms
    expect(v.velocity()).toBeCloseTo(2, 5);
    v.reset();
    expect(v.velocity()).toBe(0);
  });

  it('is 0 when samples share a timestamp, and negative backwards', () => {
    const v = new VelocityTracker();
    v.add(5, 10);
    v.add(5, 20);
    expect(v.velocity()).toBe(0);
    const back = new VelocityTracker();
    back.add(0, 100);
    back.add(50, 50);
    expect(back.velocity()).toBe(-1);
  });
});

describe('shouldComplete', () => {
  it('lets a flick decide by direction', () => {
    expect(shouldComplete(10, 0.8, 400)).toBe(true);
    expect(shouldComplete(390, -0.8, 400)).toBe(false);
  });

  it('decides a slow release by distance', () => {
    expect(shouldComplete(199, 0.1, 400)).toBe(false);
    expect(shouldComplete(200, 0.1, 400)).toBe(true);
    expect(shouldComplete(130, 0, 400, { distanceRatio: 0.3 })).toBe(true);
    expect(shouldComplete(50, 0.3, 400, { flickVelocity: 0.25 })).toBe(true);
  });
});

describe('settleDuration', () => {
  it('continues at the finger speed, within bounds', () => {
    expect(settleDuration(200, 1)).toBe(200);
    expect(settleDuration(-200, -1)).toBe(200);
    expect(settleDuration(20, 2)).toBe(120); // min
    expect(settleDuration(2000, 1)).toBe(320); // max
    expect(settleDuration(200, 0.01)).toBe(320); // too slow to count: max
    expect(settleDuration(200, 0.01, 100, 250)).toBe(250);
  });
});

describe('rubberBand and lockAxis', () => {
  it('resists more the further it goes', () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-5)).toBe(0);
    expect(rubberBand(40, 40)).toBe(20);
    expect(rubberBand(1000, 40)).toBeLessThan(40);
  });

  it('waits for the slop, then picks the dominant axis', () => {
    expect(lockAxis(3, 4)).toBeUndefined();
    expect(lockAxis(10, 2)).toBe('x');
    expect(lockAxis(-2, -10)).toBe('y');
    expect(lockAxis(6, 0, 5)).toBe('x');
  });
});

describe('spring', () => {
  it('runs from 0 to exactly 1 with a slight overshoot and a duration', () => {
    const curve = springCurve(SHEET_SPRING);
    expect(curve.points).toHaveLength(40);
    expect(curve.points[0]).toBe(0);
    expect(curve.points[39]).toBe(1);
    expect(Math.max(...curve.points)).toBeGreaterThan(1); // the overshoot a cubic-bezier cannot draw
    expect(Math.max(...curve.points)).toBeLessThan(1.05);
    expect(curve.durationMs).toBeGreaterThan(300);
    expect(curve.durationMs).toBeLessThan(900);
  });

  it('stops at maxMs for a spring that never rests', () => {
    const curve = springCurve({ stiffness: 100, damping: 0 }, 5, 200);
    expect(curve.durationMs).toBeGreaterThanOrEqual(200);
    expect(curve.durationMs).toBeLessThan(210);
    expect(curve.points[4]).toBe(1);
  });

  it('writes a CSS linear() easing', () => {
    const { easing, durationMs } = springEasing({ stiffness: 380, damping: 33, mass: 1 }, 10);
    expect(easing).toMatch(/^linear\(0, [\d., ]+, 1\)$/);
    expect(easing.split(',')).toHaveLength(10);
    expect(durationMs).toBe(springCurve(SHEET_SPRING).durationMs);
  });
});
