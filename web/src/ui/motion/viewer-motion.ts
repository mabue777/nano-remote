// The motion and the gestures of the image viewer (ui/ImageViewer.tsx), from docs/plan/file-viewer.md P1:
//
// - Open: the picture grows out of the tapped thumbnail (FLIP: it starts as the thumbnail's cropped square,
//   scaled and clipped to sit exactly on it, and springs to its fit box) while the black layer fades in.
//   Close (Close, Escape, a swipe down) is the same played back into the thumbnail of the picture shown now;
//   with no thumbnail on screen, or no size known yet, the layer just fades.
// - Pinch (two pointers) and double tap zoom up to MAX_ZOOM about the fingers; one finger pans a zoomed picture
//   (resisted past the edges, carried on a little after a flick); a single tap shows or hides the buttons.
// - On a fitted picture one finger swipes sideways between the message's pictures, or drags down to dismiss
//   (the picture follows and shrinks, the layer fades; a flick or a long pull closes, a short one springs back).
// - Reduce Motion: cross-fades only, no grow or shrink, no carry-on after a flick; a drag still follows the
//   finger.
//
// Pointer events, not touch events: the layer is `touch-action: none`, so the browser leaves every finger to
// it (the app cancels page zoom everywhere, ui/no-zoom.ts; this is the one place that zooms, on its own).
// Animations are the Web Animations API on transform, opacity and clip-path; a finger landing mid-animation
// takes the picture where it is (the computed style), never from where the animation was going.
import { lockAxis, rubberBand, settleDuration, shouldComplete, VelocityTracker } from './gesture';
import { motionOf, prefersReducedMotion, type Motion } from './motion';
import { SHEET_SPRING, springEasing } from './spring';
import {
  coverCrop,
  dismissBackdrop,
  dismissProgress,
  dismissScale,
  doubleTapZoom,
  elasticPan,
  fitRect,
  flingPan,
  IDENTITY,
  intersects,
  MAX_ZOOM,
  isZoomed,
  NO_CLIP,
  pinchZoom,
  settleZoom,
  zoomOfRect,
  zoomTransform,
  type Point,
  type Rect,
  type Size,
  type Zoom,
} from './zoom';

/** The gap between two pictures while swiping. */
export const SLIDE_GAP = 16;
/** Two taps closer than this (ms and px) are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 40;
/** A press longer than this is no tap (it may be the long press for the system's Save menu). */
export const TAP_MAX_MS = 350;

export interface AnimationLike {
  readonly finished: Promise<unknown>;
  cancel(): void;
}

/** The few element members the motion uses, so tests can pass plain objects. */
export interface MotionElement {
  readonly style: { transform: string; opacity: string; clipPath: string; visibility: string };
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): AnimationLike;
  getBoundingClientRect(): Rect;
}

/** The thumbnail a picture grows out of and shrinks back into. */
export interface Origin {
  element: MotionElement;
  /** Its box on screen now. */
  rect: Rect;
  /** Its corner radius in px. */
  radius: number;
}

/** What the viewer component gives the motion. */
export interface ViewerHost {
  readonly count: number;
  /** The black layer, the strip of pictures, the buttons, one picture's slide and its image. */
  backdrop(): MotionElement | null;
  track(): MotionElement | null;
  chrome(): MotionElement | null;
  slide(index: number): MotionElement | null;
  image(index: number): MotionElement | null;
  /** The picture's natural size, once known (decoded, or the thumbnail's). */
  size(index: number): Size | undefined;
  origin(index: number): Origin | null;
  /** The picture shown changed (after a swipe or an arrow key). */
  onIndex(index: number): void;
  /** A single tap: show or hide the buttons. */
  onTap(): void;
  /** The close motion ended; the owner removes the viewer. */
  onClosed(): void;
}

export interface ViewerEnv {
  reduced(): boolean;
  viewport(): Size;
  motion(): Motion;
  /** Whether CSS `linear()` easing works; without it the spring falls back to --ease-enter. */
  linearEasing: boolean;
  /** The current transform, opacity and clip-path, mid-animation included. */
  styleOf(element: MotionElement): { transform: string; opacity: string; clipPath: string };
  haptic(): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function browserViewerEnv(root: () => Element | null, haptic: () => void): ViewerEnv {
  return {
    reduced: () => prefersReducedMotion(),
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    motion: () => motionOf(root()),
    linearEasing: typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)'),
    styleOf: (element) => getComputedStyle(element as unknown as Element),
    haptic,
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

type Mode = 'idle' | 'pending' | 'pan' | 'pinch' | 'page' | 'dismiss' | 'closing' | 'closed';

interface Start {
  point: Point;
  time: number;
  zoom: Zoom;
  /** The two fingers at the start of a pinch. */
  pair?: [Point, Point];
}

/** One open viewer's motion. The component forwards its pointer and key events here. */
export class ViewerMotion {
  private readonly spring = springEasing(SHEET_SPRING);
  private readonly running = new Map<MotionElement, AnimationLike>();
  private readonly pointers = new Map<number, Point>();
  private readonly vx = new VelocityTracker();
  private readonly vy = new VelocityTracker();
  private mode: Mode = 'idle';
  private start: Start = { point: { x: 0, y: 0 }, time: 0, zoom: IDENTITY };
  private zoom: Zoom = { ...IDENTITY };
  private drag: Point = { x: 0, y: 0 };
  private lastTap: { time: number; point: Point } | null = null;
  private tapTimer: unknown = null;
  private focal: Point = { x: 0, y: 0 };

  constructor(
    private readonly host: ViewerHost,
    private readonly env: ViewerEnv,
    private index: number,
  ) {}

  get current(): number {
    return this.index;
  }

  get state(): Mode {
    return this.mode;
  }

  get currentZoom(): Zoom {
    return { ...this.zoom };
  }

  /** The grow out of the thumbnail (or a cross-fade). Call once the viewer's elements are on the page. */
  open(): void {
    this.placeTrack(this.index, 0);
    const backdrop = this.host.backdrop();
    const chrome = this.host.chrome();
    const image = this.host.image(this.index);
    const motion = this.env.motion();
    const fade = (element: MotionElement | null, ms: number) => element && this.play(element, { opacity: ['0', '1'] }, ms, motion.standard);
    const crop = this.reduced() ? null : this.cropFor(this.index);
    if (crop === null || image === null) {
      // No thumbnail to grow from (or Reduce Motion): the whole layer cross-fades in.
      fade(backdrop, motion.relaxed);
      fade(this.host.track(), motion.relaxed);
      fade(chrome, motion.relaxed);
      return;
    }
    const origin = crop.origin;
    origin.element.style.visibility = 'hidden';
    fade(backdrop, motion.relaxed);
    fade(chrome, motion.relaxed);
    const { easing, ms } = this.springTiming();
    const done = this.play(image, { transform: [zoomTransform(crop.zoom), zoomTransform(IDENTITY)], clipPath: [crop.clip, NO_CLIP] }, ms, easing);
    // Shown again when the grow ends; a close that cuts the grow short keeps it hidden and shows it itself.
    const show = () => {
      if (this.mode !== 'closing' && this.mode !== 'closed') origin.element.style.visibility = '';
    };
    void done.finished.then(show, show);
  }

  /** Shrinks the picture shown back into its thumbnail (or fades out), then tells the owner. */
  close(): void {
    if (this.mode === 'closing' || this.mode === 'closed') return;
    this.cancelTap();
    this.mode = 'closing';
    this.pointers.clear();
    const motion = this.env.motion();
    const backdrop = this.host.backdrop();
    const chrome = this.host.chrome();
    const image = this.host.image(this.index);
    const slide = this.host.slide(this.index);
    for (const element of [backdrop, chrome, image, slide, this.host.track()]) if (element) this.hold(element);
    const crop = this.reduced() ? null : this.cropFor(this.index);
    const finish = () => {
      if (crop !== null) crop.origin.element.style.visibility = '';
      this.mode = 'closed';
      this.host.onClosed();
    };
    const fadeOut = (element: MotionElement | null, ms: number, easing: string) =>
      element && this.play(element, { opacity: [element.style.opacity === '' ? '1' : element.style.opacity, '0'] }, ms, easing);
    if (crop === null || image === null) {
      fadeOut(chrome, motion.moderate, motion.exit);
      fadeOut(this.host.track(), motion.moderate, motion.exit);
      const last = fadeOut(backdrop, motion.moderate, motion.exit) ?? fadeOut(slide, motion.moderate, motion.exit);
      if (last === null) finish();
      else void last.finished.then(finish, finish);
      return;
    }
    // Take the picture where it is now (zoomed, dragged down), as a zoom of the image alone.
    const fit = this.fit(this.index)!;
    const from = zoomOfRect(image.getBoundingClientRect(), fit);
    // The drag down and a swipe caught mid-slide are now in the image's own transform.
    if (slide !== null) slide.style.transform = '';
    const track = this.host.track();
    if (track !== null) track.style.transform = translateX(this.trackX(this.index));
    crop.origin.element.style.visibility = 'hidden';
    const { easing, ms } = this.springTiming();
    fadeOut(chrome, motion.fast, motion.exit);
    fadeOut(backdrop, ms, motion.standard);
    const shrink = this.play(image, { transform: [zoomTransform(from), zoomTransform(crop.zoom)], clipPath: [NO_CLIP, crop.clip] }, ms, easing);
    void shrink.finished.then(finish, finish);
  }

  /** Escape closes; the arrow keys step between the pictures. */
  key(key: string): boolean {
    if (key === 'Escape') {
      this.close();
      return true;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      this.go(this.index + (key === 'ArrowLeft' ? -1 : 1));
      return true;
    }
    return false;
  }

  /** Shows picture `index` (clamped), sliding the strip there. */
  go(index: number, velocity = 0): void {
    if (this.mode === 'closing' || this.mode === 'closed') return;
    const next = Math.max(0, Math.min(this.host.count - 1, index));
    if (next !== this.index) this.resetZoom(this.index);
    this.index = next;
    this.zoom = { ...IDENTITY };
    const track = this.host.track();
    if (track !== null) {
      const from = this.hold(track);
      const to = this.trackX(next);
      const motion = this.env.motion();
      const ms = this.reduced() ? 0 : settleDuration(to - parseX(from.transform), velocity, 180, motion.relaxed);
      if (ms === 0) track.style.transform = translateX(to);
      else this.play(track, { transform: [from.transform === '' ? translateX(to) : from.transform, translateX(to)] }, ms, motion.enter);
    }
    this.host.onIndex(next);
  }

  /** The viewport changed size (rotation): fitted again, no zoom, the strip at the current picture. */
  resize(): void {
    this.resetZoom(this.index);
    this.zoom = { ...IDENTITY };
    this.placeTrack(this.index, 0);
  }

  pointerDown(id: number, x: number, y: number, time: number): void {
    if (this.mode === 'closing' || this.mode === 'closed') return;
    this.pointers.set(id, { x, y });
    if (this.pointers.size === 1) {
      this.takeOver();
      this.mode = 'pending';
      this.start = { point: { x, y }, time, zoom: { ...this.zoom } };
      this.vx.reset();
      this.vy.reset();
      this.vx.add(time, x);
      this.vy.add(time, y);
      return;
    }
    if (this.pointers.size === 2 && this.fit(this.index) !== undefined) {
      // A second finger: whatever one finger was doing springs back, and a pinch starts from here.
      if (this.mode === 'page') this.go(this.index);
      if (this.mode === 'dismiss') this.restoreDismiss(0);
      this.cancelTap();
      this.lastTap = null;
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.mode = 'pinch';
      this.start = { point: a, time, zoom: { ...this.zoom }, pair: [a, b] };
    }
  }

  pointerMove(id: number, x: number, y: number, time: number): void {
    if (!this.pointers.has(id)) return;
    this.pointers.set(id, { x, y });
    if (this.mode === 'pinch') {
      if (this.pointers.size < 2 || this.start.pair === undefined) return;
      const fit = this.fit(this.index)!;
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.focal = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.setZoom(pinchZoom(this.start.zoom, fit, this.start.pair[0], this.start.pair[1], a, b));
      return;
    }
    if (this.pointers.size !== 1) return;
    this.vx.add(time, x);
    this.vy.add(time, y);
    const dx = x - this.start.point.x;
    const dy = y - this.start.point.y;
    if (this.mode === 'pending') {
      const axis = lockAxis(dx, dy);
      if (axis === undefined) return;
      this.cancelTap();
      if (isZoomed(this.zoom) && this.fit(this.index) !== undefined) this.mode = 'pan';
      else if (axis === 'x') this.mode = 'page';
      else this.mode = 'dismiss';
    }
    if (this.mode === 'pan') {
      const fit = this.fit(this.index)!;
      this.setZoom(elasticPan({ scale: this.start.zoom.scale, x: this.start.zoom.x + dx, y: this.start.zoom.y + dy }, fit, this.env.viewport()));
    } else if (this.mode === 'page') {
      const atEnd = (dx > 0 && this.index === 0) || (dx < 0 && this.index === this.host.count - 1);
      const offset = atEnd ? Math.sign(dx) * rubberBand(Math.abs(dx)) : dx;
      const track = this.host.track();
      if (track) track.style.transform = translateX(this.trackX(this.index) + offset);
    } else if (this.mode === 'dismiss') {
      this.drag = { x: dx, y: dy > 0 ? dy : -rubberBand(-dy, 60) };
      this.showDismiss();
    }
  }

  pointerUp(id: number, time: number, cancelled = false): void {
    const point = this.pointers.get(id);
    if (point === undefined) return;
    this.pointers.delete(id);
    if (this.mode === 'pinch') {
      if (this.pointers.size === 1) {
        // One finger left: it pans on from where the pinch put the picture.
        const [rest] = [...this.pointers.values()] as [Point];
        this.mode = 'pan';
        this.start = { point: rest, time, zoom: { ...this.zoom } };
        this.vx.reset();
        this.vy.reset();
        return;
      }
      if (this.pointers.size === 0) this.settle(settleZoom(this.zoom, this.fit(this.index)!, this.env.viewport(), this.focal));
      return;
    }
    if (this.pointers.size > 0) return;
    const mode = this.mode;
    this.mode = 'idle';
    if (mode === 'pending') {
      if (!cancelled && time - this.start.time <= TAP_MAX_MS) this.tap(point, time);
    } else if (mode === 'pan') {
      const fit = this.fit(this.index)!;
      const viewport = this.env.viewport();
      // A pan left over from a pinch may still be past the scale limits: those settle first, without a carry-on.
      const outOfRange = this.zoom.scale < 1 || this.zoom.scale > MAX_ZOOM;
      const target =
        this.reduced() || outOfRange ? settleZoom(this.zoom, fit, viewport, outOfRange ? point : this.focal) : flingPan(this.zoom, fit, viewport, { x: this.vx.velocity(), y: this.vy.velocity() });
      this.settle(target.scale === 1 ? { ...IDENTITY } : target);
    } else if (mode === 'page') {
      const dx = point.x - this.start.point.x;
      const velocity = this.vx.velocity();
      const width = this.env.viewport().width;
      let next = this.index;
      if (!cancelled && shouldComplete(-dx, -velocity, width, { distanceRatio: 0.35 })) next = this.index + 1;
      else if (!cancelled && shouldComplete(dx, velocity, width, { distanceRatio: 0.35 })) next = this.index - 1;
      this.go(next, velocity);
    } else if (mode === 'dismiss') {
      const height = this.env.viewport().height;
      if (!cancelled && this.drag.y > 0 && shouldComplete(this.drag.y, this.vy.velocity(), height, { distanceRatio: 0.15, flickVelocity: 0.4 })) {
        this.env.haptic();
        this.close();
      } else this.restoreDismiss(this.vy.velocity());
    }
  }

  /** Stops timers and animations without the close motion (the viewer was removed some other way). */
  dispose(): void {
    this.cancelTap();
    for (const animation of this.running.values()) animation.cancel();
    this.running.clear();
    this.mode = 'closed';
  }

  private tap(point: Point, time: number): void {
    const last = this.lastTap;
    const double = last !== null && time - last.time <= DOUBLE_TAP_MS && Math.hypot(point.x - last.point.x, point.y - last.point.y) <= DOUBLE_TAP_PX;
    if (double) {
      this.cancelTap();
      this.lastTap = null;
      const fit = this.fit(this.index);
      if (fit === undefined) return;
      this.env.haptic();
      this.settle(doubleTapZoom(this.zoom, fit, this.env.viewport(), point));
      return;
    }
    this.lastTap = { time, point };
    this.cancelTap();
    this.tapTimer = this.env.setTimeout(() => {
      this.tapTimer = null;
      this.lastTap = null;
      this.host.onTap();
    }, DOUBLE_TAP_MS);
  }

  private cancelTap(): void {
    if (this.tapTimer !== null) this.env.clearTimeout(this.tapTimer);
    this.tapTimer = null;
  }

  /** A finger landed: anything moving stops where it is and is the finger's from here. */
  private takeOver(): void {
    const image = this.host.image(this.index);
    const fit = this.fit(this.index);
    if (image !== null && this.running.has(image) && fit !== undefined) {
      const style = this.hold(image);
      const matrix = parseMatrix(style.transform);
      if (matrix !== null) this.zoom = { scale: matrix.scale, x: matrix.x, y: matrix.y };
    }
    const track = this.host.track();
    if (track !== null && this.running.has(track)) {
      // A swipe caught mid-slide: the slide finishes at once, so the new finger starts from a picture in place.
      this.hold(track);
      track.style.transform = translateX(this.trackX(this.index));
    }
    const slide = this.host.slide(this.index);
    if (slide !== null && this.running.has(slide)) {
      this.restoreDismiss(0);
    }
  }

  private setZoom(zoom: Zoom): void {
    this.zoom = zoom;
    const image = this.host.image(this.index);
    if (image) image.style.transform = zoomTransform(zoom);
  }

  /** The zoom animates to `target` and stays there. */
  private settle(target: Zoom): void {
    const image = this.host.image(this.index);
    const from = this.zoom;
    this.zoom = target;
    if (image === null) return;
    const motion = this.env.motion();
    if (this.reduced()) {
      image.style.transform = zoomTransform(target);
      return;
    }
    this.play(image, { transform: [zoomTransform(from), zoomTransform(target)] }, motion.relaxed, motion.enter);
  }

  private showDismiss(): void {
    const progress = dismissProgress(this.drag.y, this.env.viewport().height);
    const slide = this.host.slide(this.index);
    if (slide) slide.style.transform = `translate(${this.drag.x}px, ${this.drag.y}px) scale(${dismissScale(progress)})`;
    const opacity = String(dismissBackdrop(progress));
    const backdrop = this.host.backdrop();
    if (backdrop) backdrop.style.opacity = opacity;
    const chrome = this.host.chrome();
    if (chrome) chrome.style.opacity = opacity;
  }

  /** A dismiss drag that did not close springs back. */
  private restoreDismiss(velocity: number): void {
    const slide = this.host.slide(this.index);
    const backdrop = this.host.backdrop();
    const chrome = this.host.chrome();
    const motion = this.env.motion();
    const ms = this.reduced() ? 0 : settleDuration(this.drag.y, velocity, 160, motion.relaxed);
    this.drag = { x: 0, y: 0 };
    for (const element of [slide, backdrop, chrome]) {
      if (element === null) continue;
      const from = this.hold(element);
      const transform = element === slide ? '' : undefined;
      if (ms === 0) {
        if (transform !== undefined) element.style.transform = transform;
        element.style.opacity = element === slide ? '' : '1';
        continue;
      }
      if (transform !== undefined) this.play(element, { transform: [from.transform === '' ? 'none' : from.transform, 'none'] }, ms, motion.enter, transform);
      else this.play(element, { opacity: [from.opacity === '' ? '1' : from.opacity, '1'] }, ms, motion.enter);
    }
  }

  private resetZoom(index: number): void {
    const image = this.host.image(index);
    if (image === null) return;
    this.hold(image);
    image.style.transform = zoomTransform(IDENTITY);
  }

  private placeTrack(index: number, offset: number): void {
    const track = this.host.track();
    if (track) {
      this.hold(track);
      track.style.transform = translateX(this.trackX(index) + offset);
    }
  }

  private trackX(index: number): number {
    return -index * (this.env.viewport().width + SLIDE_GAP);
  }

  private fit(index: number): Rect | undefined {
    const size = this.host.size(index);
    return size === undefined ? undefined : fitRect(size, this.env.viewport());
  }

  /** The thumbnail crop for picture `index`, when it has a size and a thumbnail that is on screen. */
  private cropFor(index: number): (ReturnType<typeof coverCrop> & { origin: Origin }) | null {
    const fit = this.fit(index);
    const origin = this.host.origin(index);
    if (fit === undefined || origin === null) return null;
    const viewport = this.env.viewport();
    if (!intersects(origin.rect, { left: 0, top: 0, width: viewport.width, height: viewport.height })) return null;
    return { ...coverCrop(origin.rect, fit, origin.radius), origin };
  }

  private springTiming(): { easing: string; ms: number } {
    if (this.env.linearEasing) return { easing: this.spring.easing, ms: this.spring.durationMs };
    const motion = this.env.motion();
    return { easing: motion.enter, ms: motion.relaxed + 100 };
  }

  private reduced(): boolean {
    return this.env.reduced();
  }

  /**
   * Plays `frames` on `element` and leaves the end values in its inline style. `rest` overrides the inline
   * transform kept after the animation (e.g. '' for "back to the stylesheet's").
   */
  private play(element: MotionElement, frames: { transform?: string[]; opacity?: string[]; clipPath?: string[] }, ms: number, easing: string, rest?: string): AnimationLike {
    this.hold(element);
    const keyframes: Keyframe[] = [{}, {}];
    for (const key of ['transform', 'opacity', 'clipPath'] as const) {
      const values = frames[key];
      if (values === undefined) continue;
      keyframes[0]![key] = values[0];
      keyframes[1]![key] = values[1];
      element.style[key] = key === 'transform' && rest !== undefined ? rest : key === 'clipPath' && values[1] === NO_CLIP ? '' : values[1]!;
    }
    const animation = element.animate(keyframes, { duration: ms, easing });
    this.running.set(element, animation);
    const done = () => {
      if (this.running.get(element) === animation) this.running.delete(element);
    };
    void animation.finished.then(done, done);
    return animation;
  }

  /** Stops `element`'s animation where it is: the current values become its inline style. */
  private hold(element: MotionElement): { transform: string; opacity: string } {
    const animation = this.running.get(element);
    if (animation === undefined) return { transform: element.style.transform, opacity: element.style.opacity };
    const now = this.env.styleOf(element);
    const transform = now.transform === 'none' ? '' : now.transform;
    element.style.transform = transform;
    element.style.opacity = now.opacity;
    element.style.clipPath = now.clipPath === 'none' ? '' : now.clipPath;
    this.running.delete(element);
    animation.cancel();
    return { transform, opacity: now.opacity };
  }
}

function translateX(x: number): string {
  return `translateX(${Math.round(x * 100) / 100}px)`;
}

/** The x of `translateX(..px)` or of a computed `matrix(...)`; 0 for anything else. */
export function parseX(transform: string): number {
  const translate = /translateX\((-?[\d.]+)px\)/.exec(transform);
  if (translate !== null) return Number(translate[1]);
  return parseMatrix(transform)?.x ?? 0;
}

/** Scale and translation of a computed `matrix(a, b, c, d, e, f)` or of our own zoomTransform. */
export function parseMatrix(transform: string): Zoom | null {
  const matrix = /^matrix\(([^)]+)\)$/.exec(transform.trim());
  if (matrix !== null) {
    const values = matrix[1]!.split(',').map(Number);
    if (values.length === 6 && values.every(Number.isFinite)) return { scale: values[0]!, x: values[4]!, y: values[5]! };
    return null;
  }
  const own = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)$/.exec(transform.trim());
  if (own !== null) return { scale: Number(own[3]), x: Number(own[1]), y: Number(own[2]) };
  return null;
}
