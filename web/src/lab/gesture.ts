// The rules of a drag that follows the finger (the back swipe, a sheet pulled down), without the DOM: how
// fast the finger was moving when it lifted, whether that completes the gesture or snaps back, and how long
// the rest of the movement should take so it continues at the finger's speed instead of restarting.

interface Sample {
  t: number;
  x: number;
}

/** Finger speed in px/ms over the last `windowMs`; positive in the direction of increasing x. */
export class VelocityTracker {
  private samples: Sample[] = [];

  constructor(private readonly windowMs = 100) {}

  add(t: number, x: number): void {
    this.samples.push({ t, x });
    const cutoff = t - this.windowMs;
    // drop samples older than the window, but keep two, so a slow last move still has a baseline
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift();
  }

  velocity(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = last.t - first.t;
    return dt <= 0 ? 0 : (last.x - first.x) / dt;
  }

  reset(): void {
    this.samples = [];
  }
}

export interface SettleOptions {
  /** Past this fraction of `size` a slow release completes. */
  distanceRatio?: number;
  /** A flick faster than this (px/ms) decides by its direction alone. */
  flickVelocity?: number;
}

/**
 * Whether a released drag completes (goes back, dismisses) or snaps back. `distance` and `velocity` are
 * measured in the completing direction (a back swipe: rightwards; a sheet: downwards).
 */
export function shouldComplete(distance: number, velocity: number, size: number, options: SettleOptions = {}): boolean {
  const flick = options.flickVelocity ?? 0.5;
  if (velocity >= flick) return true;
  if (velocity <= -flick) return false;
  return distance >= size * (options.distanceRatio ?? 0.5);
}

/**
 * How long (ms) the rest of the movement takes: `remaining` px at the release speed, so the motion carries
 * on at the finger's pace, clamped to [min, max]. A slow or backwards release takes `max`.
 */
export function settleDuration(remaining: number, velocity: number, min = 120, max = 320): number {
  const speed = Math.abs(velocity);
  if (speed < 0.05) return max;
  return Math.round(Math.min(max, Math.max(min, Math.abs(remaining) / speed)));
}

/** Drag past the allowed edge with resistance: moves less and less the further it goes. */
export function rubberBand(overshoot: number, limit = 120): number {
  if (overshoot <= 0) return 0;
  return (limit * overshoot) / (overshoot + limit);
}

/** Which way a touch is going once it moved more than `slop` px; undefined while it is still a tap. */
export function lockAxis(dx: number, dy: number, slop = 8): 'x' | 'y' | undefined {
  if (Math.hypot(dx, dy) < slop) return undefined;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}
