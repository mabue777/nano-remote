import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserViewerEnv, DOUBLE_TAP_MS, parseMatrix, parseX, SLIDE_GAP, TAP_MAX_MS, ViewerMotion, type MotionElement, type Origin, type ViewerEnv, type ViewerHost } from './viewer-motion';
import { NO_CLIP, type Rect, type Size } from './zoom';

const PHONE = { width: 390, height: 844 };
const STEP = PHONE.width + SLIDE_GAP;

class FakeAnimation {
  cancelled = false;
  private settle!: (value: unknown) => void;
  private fail!: (error: unknown) => void;
  readonly finished = new Promise((resolve, reject) => {
    this.settle = resolve;
    this.fail = reject;
  });

  constructor(
    readonly keyframes: Keyframe[],
    readonly options: KeyframeAnimationOptions,
  ) {
    this.finished.catch(() => undefined);
  }

  finish(): void {
    this.settle(undefined);
  }

  cancel(): void {
    this.cancelled = true;
    this.fail(new Error('AbortError'));
  }
}

class FakeElement implements MotionElement {
  readonly style = { transform: '', opacity: '', clipPath: '', visibility: '' };
  readonly animations: FakeAnimation[] = [];
  /** What getComputedStyle would say mid-animation; the inline style when unset. */
  computed: { transform: string; opacity: string; clipPath: string } | null = null;

  constructor(public rect: Rect = { left: 0, top: 0, width: 0, height: 0 }) {}

  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
    const animation = new FakeAnimation(keyframes, options);
    this.animations.push(animation);
    return animation;
  }

  getBoundingClientRect(): Rect {
    return this.rect;
  }

  get last(): FakeAnimation | undefined {
    return this.animations[this.animations.length - 1];
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Setup {
  count?: number;
  index?: number;
  sizes?: (Size | undefined)[];
  reduced?: boolean;
  linearEasing?: boolean;
  origin?: boolean;
  /** Leave these parts out (they are not on the page). */
  without?: ('backdrop' | 'track' | 'chrome' | 'slide' | 'image')[];
}

function setup(options: Setup = {}) {
  const count = options.count ?? 3;
  const sizes = options.sizes ?? Array.from({ length: count }, () => ({ width: 2048, height: 1024 }));
  const without = new Set(options.without ?? []);
  const backdrop = new FakeElement();
  const track = new FakeElement();
  const chrome = new FakeElement();
  const slides = Array.from({ length: count }, () => new FakeElement());
  // The fitted 2:1 picture: 390 x 195 at y 324.5.
  const images = Array.from({ length: count }, () => new FakeElement({ left: 0, top: 324.5, width: 390, height: 195 }));
  const thumbs = Array.from({ length: count }, (_, i) => new FakeElement({ left: 100 + i * 100, top: 100, width: 96, height: 96 }));
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  let reduced = options.reduced ?? false;
  const haptic = vi.fn();
  const host = {
    count,
    backdrop: () => (without.has('backdrop') ? null : backdrop),
    track: () => (without.has('track') ? null : track),
    chrome: () => (without.has('chrome') ? null : chrome),
    slide: (i) => (without.has('slide') ? null : (slides[i] ?? null)),
    image: (i) => (without.has('image') ? null : (images[i] ?? null)),
    size: (i) => sizes[i],
    origin: (i): Origin | null => (options.origin === false ? null : { element: thumbs[i]!, rect: thumbs[i]!.rect, radius: 10 }),
    onIndex: vi.fn<(index: number) => void>(),
    onTap: vi.fn<() => void>(),
    onClosed: vi.fn<() => void>(),
  } satisfies ViewerHost;
  const env: ViewerEnv = {
    reduced: () => reduced,
    viewport: () => PHONE,
    motion: () => ({ fast: 150, moderate: 200, relaxed: 300, standard: 'standard', enter: 'enter', exit: 'exit' }),
    linearEasing: options.linearEasing ?? true,
    styleOf: (element) => (element as FakeElement).computed ?? element.style,
    haptic,
    setTimeout: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => void ((handle as { cleared: boolean }).cleared = true),
  };
  const motion = new ViewerMotion(host, env, options.index ?? 0);
  const runTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run();
  };
  return { motion, host, env, backdrop, track, chrome, slides, images, thumbs, haptic, timers, runTimers, setReduced: (on: boolean) => (reduced = on) };
}

/** A one-finger drag from `from` to `to` in `steps` moves, `ms` apart; returns the release time. */
function drag(motion: ViewerMotion, from: { x: number; y: number }, to: { x: number; y: number }, { steps = 5, ms = 16, start = 0, id = 1, lift = true } = {}): number {
  motion.pointerDown(id, from.x, from.y, start);
  let t = start;
  for (let i = 1; i <= steps; i++) {
    t += ms;
    motion.pointerMove(id, from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, t);
  }
  if (lift) motion.pointerUp(id, t);
  return t;
}

describe('ViewerMotion: open', () => {
  it('grows the picture out of its thumbnail and fades the layer in; the thumbnail hides meanwhile', async () => {
    const { motion, backdrop, chrome, track, images, thumbs } = setup({ index: 1 });
    motion.open();
    expect(track.style.transform).toBe(`translateX(-${STEP}px)`);
    const grow = images[1]!.last!;
    expect(grow.keyframes[0]!.transform).toMatch(/^translate\(.*\) scale\(0\.49/);
    expect(grow.keyframes[1]).toEqual({ transform: 'translate(0px, 0px) scale(1)', clipPath: NO_CLIP });
    expect(grow.keyframes[0]!.clipPath).toMatch(/^inset\(0px 97\.5px round/);
    expect(grow.options.easing).toMatch(/^linear\(/);
    // The end values stay inline; no clip at rest.
    expect(images[1]!.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(images[1]!.style.clipPath).toBe('');
    expect(backdrop.last!.keyframes).toEqual([{ opacity: '0' }, { opacity: '1' }]);
    expect(chrome.last!.keyframes).toEqual([{ opacity: '0' }, { opacity: '1' }]);
    expect(thumbs[1]!.style.visibility).toBe('hidden');
    grow.finish();
    await flush();
    expect(thumbs[1]!.style.visibility).toBe('');
  });

  it('shows the thumbnail again when the grow is cut short', async () => {
    const { motion, images, thumbs } = setup();
    motion.open();
    images[0]!.last!.cancel();
    await flush();
    expect(thumbs[0]!.style.visibility).toBe('');
  });

  it('a close during the grow keeps the thumbnail hidden until the shrink lands in it', async () => {
    const { motion, images, thumbs } = setup();
    motion.open();
    motion.close();
    await flush();
    expect(thumbs[0]!.style.visibility).toBe('hidden');
    images[0]!.last!.finish();
    await flush();
    expect(thumbs[0]!.style.visibility).toBe('');
  });

  it('a close during a swipe puts the strip at rest and the offset into the shrink', () => {
    const { motion, track, images } = setup({ index: 1 });
    track.style.transform = `translateX(-${STEP + 60}px)`;
    images[1]!.rect = { left: -60, top: 324.5, width: 390, height: 195 };
    motion.close();
    expect(track.style.transform).toBe(`translateX(-${STEP}px)`);
    expect(images[1]!.last!.keyframes[0]!.transform).toBe('translate(-60px, 0px) scale(1)');
  });

  it('without linear() easing the grow uses --ease-enter', () => {
    const { motion, images } = setup({ linearEasing: false });
    motion.open();
    expect(images[0]!.last!.options).toEqual({ duration: 400, easing: 'enter' });
  });

  it('cross-fades with Reduce Motion, without a thumbnail, without a size, or with the thumbnail off screen', () => {
    for (const options of [{ reduced: true }, { origin: false }, { sizes: [undefined, undefined, undefined] }] as Setup[]) {
      const { motion, backdrop, track, chrome, images } = setup(options);
      motion.open();
      expect(images[0]!.animations).toHaveLength(0);
      for (const element of [backdrop, track, chrome]) expect(element.last!.keyframes).toEqual([{ opacity: '0' }, { opacity: '1' }]);
    }
    const offscreen = setup();
    offscreen.thumbs[0]!.rect = { left: 0, top: -400, width: 96, height: 96 };
    offscreen.motion.open();
    expect(offscreen.images[0]!.animations).toHaveLength(0);
  });

  it('opens with parts missing without throwing', () => {
    const { motion } = setup({ without: ['image', 'backdrop', 'chrome', 'track'] });
    expect(() => motion.open()).not.toThrow();
  });
});

describe('ViewerMotion: close', () => {
  it('shrinks the picture shown into its thumbnail, then tells the owner', async () => {
    const { motion, host, images, thumbs, backdrop, slides } = setup();
    motion.open();
    slides[0]!.style.transform = 'translate(0px, 80px) scale(0.9)';
    images[0]!.rect = { left: 20, top: 400, width: 351, height: 175.5 };
    motion.close();
    expect(motion.state).toBe('closing');
    expect(slides[0]!.style.transform).toBe('');
    const shrink = images[0]!.last!;
    expect(shrink.keyframes[0]).toEqual({ transform: 'translate(20px, 75.5px) scale(0.9)', clipPath: NO_CLIP });
    expect(shrink.keyframes[1]!.clipPath).toMatch(/^inset/);
    expect(backdrop.last!.keyframes[1]).toEqual({ opacity: '0' });
    expect(thumbs[0]!.style.visibility).toBe('hidden');
    motion.close(); // a second close is ignored
    expect(images[0]!.animations.filter((a) => !a.cancelled)).toHaveLength(1);
    shrink.finish();
    await flush();
    expect(host.onClosed).toHaveBeenCalledTimes(1);
    expect(thumbs[0]!.style.visibility).toBe('');
    expect(motion.state).toBe('closed');
    // Nothing moves once closed.
    motion.pointerDown(1, 10, 10, 0);
    motion.go(2);
    expect(host.onIndex).not.toHaveBeenCalled();
  });

  it('fades out with Reduce Motion (from where a drag left the layer), then tells the owner', async () => {
    const { motion, host, backdrop, track, chrome } = setup({ reduced: true });
    backdrop.style.opacity = '0.4';
    motion.close();
    expect(backdrop.last!.keyframes).toEqual([{ opacity: '0.4' }, { opacity: '0' }]);
    expect(track.last!.keyframes).toEqual([{ opacity: '1' }, { opacity: '0' }]);
    expect(chrome.last).toBeDefined();
    backdrop.last!.finish();
    await flush();
    expect(host.onClosed).toHaveBeenCalledTimes(1);
  });

  it('with no layer parts left it tells the owner at once', () => {
    const { motion, host } = setup({ origin: false, without: ['backdrop', 'slide', 'track', 'chrome'] });
    motion.close();
    expect(host.onClosed).toHaveBeenCalledTimes(1);
  });

  it('without a backdrop the slide carries the fade', async () => {
    const { motion, host, slides } = setup({ origin: false, without: ['backdrop'] });
    motion.close();
    slides[0]!.last!.finish();
    await flush();
    expect(host.onClosed).toHaveBeenCalled();
  });
});

describe('ViewerMotion: keys and stepping', () => {
  it('Escape closes, the arrows step, other keys pass', () => {
    const { motion, host } = setup({ index: 1, reduced: true });
    expect(motion.key('ArrowRight')).toBe(true);
    expect(host.onIndex).toHaveBeenLastCalledWith(2);
    expect(motion.key('ArrowLeft')).toBe(true);
    expect(host.onIndex).toHaveBeenLastCalledWith(1);
    expect(motion.key('a')).toBe(false);
    expect(motion.key('Escape')).toBe(true);
    expect(motion.state).toBe('closing');
  });

  it('go slides the strip, clamps at the ends and puts the picture left behind back to fit', () => {
    const { motion, host, track, images } = setup();
    images[0]!.style.transform = 'translate(-100px, 0px) scale(2)';
    motion.go(5);
    expect(motion.current).toBe(2);
    expect(host.onIndex).toHaveBeenCalledWith(2);
    expect(images[0]!.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(track.last!.keyframes).toEqual([{ transform: `translateX(-${2 * STEP}px)` }, { transform: `translateX(-${2 * STEP}px)` }]);
    expect(track.style.transform).toBe(`translateX(-${2 * STEP}px)`);
    motion.go(-3);
    expect(motion.current).toBe(0);
    expect(track.last!.keyframes[0]).toEqual({ transform: `translateX(-${2 * STEP}px)` });
  });

  it('without a strip on the page it still steps', () => {
    const { motion, host } = setup({ without: ['track'] });
    motion.go(1);
    expect(host.onIndex).toHaveBeenCalledWith(1);
  });

  it('resize puts the strip and the zoom back', () => {
    const { motion, track, images } = setup({ index: 2 });
    images[2]!.style.transform = 'translate(5px, 5px) scale(3)';
    motion.resize();
    expect(track.style.transform).toBe(`translateX(-${2 * STEP}px)`);
    expect(images[2]!.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(motion.currentZoom).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('ViewerMotion: swiping between pictures', () => {
  it('a long swipe left shows the next picture; the strip follows the finger meanwhile', () => {
    const { motion, host, track } = setup();
    drag(motion, { x: 300, y: 400 }, { x: 100, y: 400 }, { lift: false });
    expect(track.style.transform).toBe('translateX(-200px)');
    motion.pointerUp(1, 200);
    expect(motion.current).toBe(1);
    expect(host.onIndex).toHaveBeenCalledWith(1);
  });

  it('a swipe right goes back; a short slow one springs back; a cancelled one stays', () => {
    const { motion, host } = setup({ index: 1 });
    drag(motion, { x: 50, y: 400 }, { x: 300, y: 400 });
    expect(motion.current).toBe(0);
    const again = setup({ index: 1 });
    drag(again.motion, { x: 200, y: 400 }, { x: 160, y: 400 }, { ms: 100 });
    expect(again.motion.current).toBe(1);
    const cancelled = setup({ index: 1 });
    const t = drag(cancelled.motion, { x: 300, y: 400 }, { x: 50, y: 400 }, { lift: false });
    cancelled.motion.pointerUp(1, t, true);
    expect(cancelled.motion.current).toBe(1);
    expect(host.onIndex).toHaveBeenCalledWith(0);
  });

  it('past either end the strip resists', () => {
    const { motion, track } = setup({ index: 0 });
    drag(motion, { x: 50, y: 400 }, { x: 250, y: 400 }, { lift: false });
    const x = parseX(track.style.transform);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(200);
    const last = setup({ index: 2 });
    drag(last.motion, { x: 300, y: 400 }, { x: 100, y: 400 }, { lift: false });
    expect(parseX(last.track.style.transform)).toBeGreaterThan(-2 * STEP - 200);
  });

  it('a finger landing mid-slide finishes the slide first', () => {
    const { motion, track } = setup();
    motion.go(1);
    track.computed = { transform: 'matrix(1, 0, 0, 1, -200, 0)', opacity: '1', clipPath: 'none' };
    motion.pointerDown(1, 200, 400, 0);
    expect(track.last!.cancelled).toBe(true);
    expect(track.style.transform).toBe(`translateX(-${STEP}px)`);
  });
});

describe('ViewerMotion: drag down to dismiss', () => {
  it('the picture follows and shrinks, the layer fades; a long pull closes with a tick', () => {
    const { motion, slides, backdrop, chrome, haptic } = setup();
    drag(motion, { x: 200, y: 300 }, { x: 210, y: 511 }, { lift: false, ms: 40 });
    expect(slides[0]!.style.transform).toBe('translate(10px, 211px) scale(0.9125)');
    expect(backdrop.style.opacity).toBe('0.5');
    expect(chrome.style.opacity).toBe('0.5');
    motion.pointerUp(1, 1000);
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(motion.state).toBe('closing');
  });

  it('a short pull springs back; an upward one resists and never closes', () => {
    const { motion, slides, backdrop } = setup();
    drag(motion, { x: 200, y: 300 }, { x: 200, y: 340 }, { ms: 100 });
    expect(motion.state).toBe('idle');
    expect(slides[0]!.last!.keyframes[1]).toEqual({ transform: 'none' });
    expect(slides[0]!.style.transform).toBe('');
    expect(backdrop.last!.keyframes[1]).toEqual({ opacity: '1' });
    const up = setup();
    drag(up.motion, { x: 200, y: 400 }, { x: 200, y: 200 }, { lift: false });
    expect(up.slides[0]!.style.transform).toMatch(/^translate\(0px, -\d/);
    up.motion.pointerUp(1, 500);
    expect(up.motion.state).toBe('idle');
  });

  it('with Reduce Motion the spring back is instant', () => {
    const { motion, slides, backdrop } = setup({ reduced: true });
    drag(motion, { x: 200, y: 300 }, { x: 200, y: 340 }, { ms: 100 });
    expect(slides[0]!.animations).toHaveLength(0);
    expect(slides[0]!.style.transform).toBe('');
    expect(backdrop.style.opacity).toBe('1');
  });

  it('a finger landing while the picture springs back takes it from there', () => {
    const { motion, slides } = setup();
    drag(motion, { x: 200, y: 300 }, { x: 200, y: 340 }, { ms: 100 });
    slides[0]!.computed = { transform: 'matrix(1, 0, 0, 1, 0, 20)', opacity: '', clipPath: 'none' };
    motion.pointerDown(1, 200, 300, 2000);
    expect(slides[0]!.animations.some((a) => a.cancelled)).toBe(true);
  });
});

describe('ViewerMotion: taps', () => {
  it('a single tap shows or hides the buttons once no second tap came', () => {
    const { motion, host, timers, runTimers } = setup();
    motion.pointerDown(1, 100, 100, 0);
    motion.pointerUp(1, 50);
    expect(host.onTap).not.toHaveBeenCalled();
    expect(timers[0]!.ms).toBe(DOUBLE_TAP_MS);
    runTimers();
    expect(host.onTap).toHaveBeenCalledTimes(1);
  });

  it('a double tap zooms in about the tap with a tick, and back out', () => {
    const { motion, host, images, haptic, runTimers } = setup();
    motion.pointerDown(1, 100, 422, 0);
    motion.pointerUp(1, 40);
    motion.pointerDown(1, 104, 420, 120);
    motion.pointerUp(1, 160);
    runTimers();
    expect(host.onTap).not.toHaveBeenCalled();
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(motion.currentZoom.scale).toBe(2.5);
    expect(images[0]!.last!.keyframes[1]!.transform).toMatch(/scale\(2\.5\)$/);
    motion.pointerDown(1, 100, 422, 1000);
    motion.pointerUp(1, 1040);
    motion.pointerDown(1, 100, 422, 1100);
    motion.pointerUp(1, 1140);
    expect(motion.currentZoom).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('two taps far apart or slow are two single taps; a long press or a cancel is no tap', () => {
    const { motion, host, runTimers } = setup();
    motion.pointerDown(1, 100, 100, 0);
    motion.pointerUp(1, 40);
    motion.pointerDown(1, 300, 600, 100);
    motion.pointerUp(1, 140);
    runTimers();
    expect(host.onTap).toHaveBeenCalledTimes(1);
    expect(motion.currentZoom.scale).toBe(1);
    motion.pointerDown(1, 100, 100, 1000);
    motion.pointerUp(1, 1000 + TAP_MAX_MS + 1);
    motion.pointerDown(1, 100, 100, 3000);
    motion.pointerUp(1, 3010, true);
    runTimers();
    expect(host.onTap).toHaveBeenCalledTimes(1);
  });

  it('a double tap on a picture without a size does nothing', () => {
    const { motion, haptic } = setup({ sizes: [undefined, undefined, undefined] });
    motion.pointerDown(1, 100, 100, 0);
    motion.pointerUp(1, 40);
    motion.pointerDown(1, 100, 100, 100);
    motion.pointerUp(1, 140);
    expect(haptic).not.toHaveBeenCalled();
  });

  it('with Reduce Motion a double tap zooms without animating', () => {
    const { motion, images } = setup({ reduced: true });
    motion.pointerDown(1, 100, 422, 0);
    motion.pointerUp(1, 40);
    motion.pointerDown(1, 100, 422, 100);
    motion.pointerUp(1, 140);
    expect(images[0]!.animations).toHaveLength(0);
    expect(images[0]!.style.transform).toMatch(/scale\(2\.5\)$/);
  });

  it('pointers it never saw are ignored', () => {
    const { motion } = setup();
    expect(() => {
      motion.pointerMove(9, 1, 1, 0);
      motion.pointerUp(9, 0);
    }).not.toThrow();
  });
});

describe('ViewerMotion: pinch and pan', () => {
  function pinchOut(motion: ViewerMotion, to: number, lift: 'both' | 'one' | 'none' = 'both') {
    motion.pointerDown(1, 145, 422, 0);
    motion.pointerDown(2, 245, 422, 5);
    motion.pointerMove(1, 195 - to / 2, 422, 20);
    motion.pointerMove(2, 195 + to / 2, 422, 30);
    if (lift === 'none') return;
    motion.pointerUp(1, 40);
    if (lift === 'both') motion.pointerUp(2, 45);
  }

  it('two fingers zoom about their midpoint; lifting both settles inside the limits', () => {
    const { motion, images } = setup();
    pinchOut(motion, 200, 'none');
    expect(motion.state).toBe('pinch');
    expect(images[0]!.style.transform).toMatch(/scale\(2\)$/);
    // A third finger changes nothing.
    motion.pointerDown(3, 10, 10, 31);
    motion.pointerMove(3, 20, 20, 32);
    motion.pointerUp(3, 33);
    motion.pointerUp(1, 40);
    expect(motion.state).toBe('pan');
    motion.pointerUp(2, 45);
    expect(motion.currentZoom.scale).toBeCloseTo(2);
  });

  it('a pinch past 4x settles at 4x, also when the fingers lift one after the other', () => {
    const { motion } = setup();
    pinchOut(motion, 900, 'both');
    expect(motion.currentZoom.scale).toBe(4);
  });

  it('a pinch in below fit settles back to fit', () => {
    const { motion } = setup();
    motion.pointerDown(1, 95, 422, 0);
    motion.pointerDown(2, 295, 422, 5);
    motion.pointerMove(1, 185, 422, 20);
    motion.pointerMove(2, 205, 422, 30);
    motion.pointerUp(1, 40);
    motion.pointerUp(2, 41);
    expect(motion.currentZoom).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('a lifted pinch with the other finger still down pans on', () => {
    const { motion, images } = setup();
    pinchOut(motion, 200, 'one');
    const before = motion.currentZoom;
    motion.pointerMove(2, 300, 422, 60);
    expect(motion.currentZoom.x).toBeCloseTo(before.x + 5);
    expect(images[0]!.style.transform).toContain('scale(2)');
  });

  it('a zoomed picture pans with one finger and carries on after a flick', () => {
    const { motion, images } = setup();
    pinchOut(motion, 200);
    const zoomed = motion.currentZoom;
    drag(motion, { x: 200, y: 400 }, { x: 150, y: 400 }, { start: 1000, ms: 10 });
    expect(motion.currentZoom.x).toBeLessThan(zoomed.x - 50);
    expect(images[0]!.last!.options.easing).toBe('enter');
    // No swipe to another picture while zoomed.
    expect(motion.current).toBe(0);
  });

  it('with Reduce Motion a pan stops where the finger left it', () => {
    const { motion, setReduced } = setup();
    pinchOut(motion, 200);
    setReduced(true);
    const zoomed = motion.currentZoom;
    drag(motion, { x: 200, y: 400 }, { x: 150, y: 400 }, { start: 1000, ms: 10 });
    expect(motion.currentZoom.x).toBeCloseTo(zoomed.x - 50);
  });

  it('a second finger during a swipe or a drag down puts those back and pinches', () => {
    const { motion, track } = setup({ index: 1 });
    drag(motion, { x: 300, y: 400 }, { x: 200, y: 400 }, { lift: false });
    motion.pointerDown(2, 100, 400, 200);
    expect(motion.state).toBe('pinch');
    expect(track.style.transform).toBe(`translateX(-${STEP}px)`);
    const down = setup();
    drag(down.motion, { x: 200, y: 300 }, { x: 200, y: 400 }, { lift: false });
    down.motion.pointerDown(2, 100, 400, 200);
    expect(down.motion.state).toBe('pinch');
    expect(down.slides[0]!.style.transform).toBe('');
  });

  it('two fingers on a picture without a size do not pinch', () => {
    const { motion } = setup({ sizes: [undefined, undefined, undefined] });
    motion.pointerDown(1, 145, 422, 0);
    motion.pointerDown(2, 245, 422, 5);
    expect(motion.state).toBe('pending');
  });

  it('a finger landing mid-zoom takes the picture where it is', () => {
    const { motion, images } = setup();
    motion.open();
    images[0]!.computed = { transform: 'matrix(1.5, 0, 0, 1.5, -40, -20)', opacity: '1', clipPath: 'none' };
    motion.pointerDown(1, 100, 100, 0);
    expect(motion.currentZoom).toEqual({ scale: 1.5, x: -40, y: -20 });
    expect(images[0]!.style.clipPath).toBe('');
    // A transform it cannot read keeps the zoom it had.
    const other = setup();
    other.motion.open();
    other.images[0]!.computed = { transform: 'none', opacity: '1', clipPath: 'none' };
    other.motion.pointerDown(1, 100, 100, 0);
    expect(other.motion.currentZoom).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('ViewerMotion: dispose', () => {
  it('stops timers and animations', () => {
    const { motion, timers, images } = setup();
    motion.open();
    motion.pointerDown(1, 10, 10, 0);
    motion.pointerUp(1, 20);
    motion.dispose();
    expect(timers[0]!.cleared).toBe(true);
    expect(images[0]!.last!.cancelled).toBe(true);
    expect(motion.state).toBe('closed');
  });
});

describe('parseX and parseMatrix', () => {
  it('read our transforms and computed matrices', () => {
    expect(parseX('translateX(-406px)')).toBe(-406);
    expect(parseX('matrix(1, 0, 0, 1, -120.5, 0)')).toBe(-120.5);
    expect(parseX('none')).toBe(0);
    expect(parseMatrix('matrix(2, 0, 0, 2, -10, 5)')).toEqual({ scale: 2, x: -10, y: 5 });
    expect(parseMatrix('translate(-3px, 4.5px) scale(1.25)')).toEqual({ scale: 1.25, x: -3, y: 4.5 });
    expect(parseMatrix('matrix(1, 2)')).toBeNull();
    expect(parseMatrix('rotate(1deg)')).toBeNull();
  });
});

describe('browserViewerEnv', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the window, the motion tokens and computed styles', () => {
    const timers: unknown[] = [];
    vi.stubGlobal('window', {
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: (query: string) => ({ matches: query.includes('reduce') }),
      setTimeout: (run: () => void, ms: number) => (timers.push(ms), 7),
      clearTimeout: (handle: number) => timers.push(`clear ${handle}`),
    });
    vi.stubGlobal('CSS', { supports: () => true });
    vi.stubGlobal('getComputedStyle', () => ({ transform: 'none', opacity: '1', clipPath: 'none', getPropertyValue: () => '' }));
    const haptic = vi.fn();
    const env = browserViewerEnv(() => null, haptic);
    expect(env.reduced()).toBe(true);
    expect(env.viewport()).toEqual(PHONE);
    expect(env.motion().relaxed).toBe(300);
    expect(env.linearEasing).toBe(true);
    expect(env.styleOf(new FakeElement())).toMatchObject({ transform: 'none' });
    env.haptic();
    expect(haptic).toHaveBeenCalled();
    expect(env.setTimeout(() => undefined, 300)).toBe(7);
    env.clearTimeout(7);
    expect(timers).toEqual([300, 'clear 7']);
  });

  it('without CSS.supports there is no linear() easing', () => {
    vi.stubGlobal('CSS', undefined);
    expect(browserViewerEnv(() => null, () => undefined).linearEasing).toBe(false);
  });
});
