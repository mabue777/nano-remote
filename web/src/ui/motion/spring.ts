// A spring as a CSS easing. A damped spring settles with a slight overshoot that a cubic-bezier cannot draw;
// CSS `linear()` (Safari 17.2+, Chrome 113+) can, given enough points. springEasing simulates the spring
// from 0 to 1 and returns those points plus how long it takes to come to rest.

export interface Spring {
  stiffness: number;
  damping: number;
  mass?: number;
}

/** The sheet spring: damping ratio about 0.85, a hint of overshoot, at rest after about half a second. */
export const SHEET_SPRING: Spring = { stiffness: 380, damping: 33 };

export interface SpringCurve {
  /** Positions from 0 to 1 at equal time steps; the last is exactly 1. */
  points: number[];
  durationMs: number;
}

/** Simulates the spring from rest at 0 to rest at 1 (semi-implicit Euler at 240 Hz). */
export function springCurve(spring: Spring, pointCount = 40, maxMs = 2000, rest = 0.001): SpringCurve {
  const mass = spring.mass ?? 1;
  const step = 1 / 240;
  let x = 0;
  let v = 0;
  let t = 0;
  const trace: number[] = [0];
  while (t * 1000 < maxMs) {
    const force = -spring.stiffness * (x - 1) - spring.damping * v;
    v += (force / mass) * step;
    x += v * step;
    t += step;
    trace.push(x);
    if (Math.abs(1 - x) < rest && Math.abs(v) < rest * 10) break;
  }
  const durationMs = Math.round(t * 1000);
  const points: number[] = [];
  for (let i = 0; i < pointCount; i++) {
    const index = Math.round((i / (pointCount - 1)) * (trace.length - 1));
    points.push(i === pointCount - 1 ? 1 : round(trace[index]!));
  }
  return { points, durationMs };
}

/** The spring as `linear(...)` plus its duration. */
export function springEasing(spring: Spring, pointCount = 40): { easing: string; durationMs: number } {
  const curve = springCurve(spring, pointCount);
  return { easing: `linear(${curve.points.join(', ')})`, durationMs: curve.durationMs };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
