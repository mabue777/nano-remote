// The markup canvas's gestures, as pure maths and a small state machine fed with pointer events, so they can
// be tested in Node. One finger draws, but only once it has moved STROKE_SLOP px: a second finger landing
// before that turns the touch into a pinch instead of a dot. A second finger landing mid-stroke drops the
// stroke and pinches (two fingers never draw). After a pinch, the finger left on the glass does nothing until
// every finger is up (one finger never pans or zooms). A short touch that never moved is a tap; two taps close
// together are a double tap (the screen fits the image again).
//
// The view maps image pixels to the canvas's CSS pixels: screen = image * scale + (x, y).
import type { Point } from './marks';

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** How far a finger moves (CSS px) before a touch becomes a stroke. */
export const STROKE_SLOP = 6;
/** The deepest zoom, as a multiple of the fitted scale. */
export const MAX_ZOOM = 8;
/** Two taps within this time (ms) and distance (CSS px) are a double tap. */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_SLOP = 30;

/** The whole image in the box, centred. */
export function fitView(image: Size, box: Size): View {
  const scale = Math.min(box.width / image.width, box.height / image.height);
  return { scale, x: (box.width - image.width * scale) / 2, y: (box.height - image.height * scale) / 2 };
}

/** A canvas point (CSS px) in image pixels. */
export function toImage(view: View, point: Point): Point {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

/** Keeps the zoom between the fitted scale and MAX_ZOOM times it, and the image over the box: an image
 * narrower (or shorter) than the box is centred on that axis, a larger one never shows a gap at its edges. */
export function clampView(view: View, image: Size, box: Size): View {
  const fit = fitView(image, box).scale;
  const scale = Math.min(fit * MAX_ZOOM, Math.max(fit, view.scale));
  const axis = (offset: number, length: number, room: number) => {
    const size = length * scale;
    if (size <= room) return (room - size) / 2;
    return Math.min(0, Math.max(room - size, offset));
  };
  return { scale, x: axis(view.x, image.width, box.width), y: axis(view.y, image.height, box.height) };
}

/** Zooms by `factor` keeping the image point under `at` where it is (a mouse wheel, a pinch). */
export function zoomAt(view: View, at: Point, factor: number, image: Size, box: Size): View {
  const scale = view.scale * factor;
  const anchor = toImage(view, at);
  return clampView({ scale, x: at.x - anchor.x * scale, y: at.y - anchor.y * scale }, image, box);
}

/** The view during a pinch: `start` was the view when the fingers were at a0 and b0; now they are at a1 and
 * b1. The image point under the fingers' first midpoint follows their midpoint, scaled by their spread. */
export function pinchView(start: View, a0: Point, b0: Point, a1: Point, b1: Point, image: Size, box: Size): View {
  const spread0 = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
  const spread1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const fit = fitView(image, box).scale;
  const scale = Math.min(fit * MAX_ZOOM, Math.max(fit, start.scale * (spread1 / spread0)));
  const anchor = toImage(start, midpoint(a0, b0));
  const mid = midpoint(a1, b1);
  return clampView({ scale, x: mid.x - anchor.x * scale, y: mid.y - anchor.y * scale }, image, box);
}

/** A view part way from `a` to `b` (t from 0 to 1). */
export function lerpView(a: View, b: View, t: number): View {
  return { scale: a.scale + (b.scale - a.scale) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Whether two views show the same thing (to the nearest hundredth of a pixel). */
export function sameView(a: View, b: View): boolean {
  return Math.abs(a.scale - b.scale) < 1e-4 && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** What the canvas does with each recognised gesture. Points are canvas CSS px. */
export interface GestureHandlers {
  /** A finger moved past the slop: the stroke starts where it went down. */
  strokeStart(from: Point): void;
  strokeMove(to: Point): void;
  strokeEnd(): void;
  /** A second finger landed or the touch was cancelled: drop the stroke. */
  strokeCancel(): void;
  /** Two fingers are down at a0 and b0. */
  pinchStart(a0: Point, b0: Point): void;
  /** They moved; a0 and b0 are where they started. */
  pinch(a0: Point, b0: Point, a1: Point, b1: Point): void;
  pinchEnd(): void;
  tap(at: Point): void;
  doubleTap(at: Point): void;
}

type Phase = 'idle' | 'pending' | 'draw' | 'pinch' | 'spent';

interface Finger {
  id: number;
  start: Point;
  now: Point;
}

/** The state machine behind the canvas. Feed it pointerdown/move/up/cancel; it calls the handlers. */
export class GestureTracker {
  private phase: Phase = 'idle';
  private fingers: Finger[] = [];
  /** Pointers down that this gesture does not follow (a third finger, the ones left after a pinch). */
  private readonly others = new Set<number>();
  private lastTap: { at: Point; time: number } | null = null;

  constructor(
    private readonly on: GestureHandlers,
    private readonly slop = STROKE_SLOP,
  ) {}

  /** The phase, for tests and the canvas's cursor. */
  get state(): Phase {
    return this.phase;
  }

  down(id: number, at: Point): void {
    if (this.phase === 'idle') {
      this.phase = 'pending';
      this.fingers = [{ id, start: at, now: at }];
      return;
    }
    if (this.phase === 'pending' || this.phase === 'draw') {
      if (this.phase === 'draw') this.on.strokeCancel();
      const first = this.fingers[0]!;
      first.start = first.now;
      this.fingers.push({ id, start: at, now: at });
      this.phase = 'pinch';
      this.lastTap = null;
      this.on.pinchStart(first.now, at);
      return;
    }
    this.others.add(id);
  }

  move(id: number, at: Point): void {
    const finger = this.fingers.find((f) => f.id === id);
    if (finger === undefined) return;
    finger.now = at;
    if (this.phase === 'pending') {
      if (Math.hypot(at.x - finger.start.x, at.y - finger.start.y) <= this.slop) return;
      this.phase = 'draw';
      this.lastTap = null;
      this.on.strokeStart(finger.start);
      this.on.strokeMove(at);
      return;
    }
    if (this.phase === 'draw') {
      this.on.strokeMove(at);
      return;
    }
    if (this.phase === 'pinch') {
      const [a, b] = this.fingers as [Finger, Finger];
      this.on.pinch(a.start, b.start, a.now, b.now);
    }
  }

  up(id: number, at: Point, time: number): void {
    this.lift(id, false, at, time);
  }

  cancel(id: number): void {
    this.lift(id, true);
  }

  private lift(id: number, cancelled: boolean, at?: Point, time = 0): void {
    if (this.others.delete(id)) {
      if (this.phase === 'spent' && this.others.size === 0) this.phase = 'idle';
      return;
    }
    if (!this.fingers.some((f) => f.id === id)) return;
    const phase = this.phase;
    const rest = this.fingers.filter((f) => f.id !== id);
    this.fingers = [];
    for (const f of rest) this.others.add(f.id);
    this.phase = this.others.size > 0 ? 'spent' : 'idle';
    if (phase === 'pinch') this.on.pinchEnd();
    else if (phase === 'draw') {
      if (cancelled) this.on.strokeCancel();
      else this.on.strokeEnd();
    } else if (phase === 'pending' && !cancelled && at !== undefined) this.tapped(at, time);
  }

  private tapped(at: Point, time: number): void {
    const last = this.lastTap;
    if (last !== null && time - last.time <= DOUBLE_TAP_MS && Math.hypot(at.x - last.at.x, at.y - last.at.y) <= DOUBLE_TAP_SLOP) {
      this.lastTap = null;
      this.on.doubleTap(at);
      return;
    }
    this.lastTap = { at, time };
    this.on.tap(at);
  }
}
