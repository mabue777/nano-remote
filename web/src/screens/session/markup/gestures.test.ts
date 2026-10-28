import { describe, expect, it } from 'vitest';

import {
  clampView,
  DOUBLE_TAP_MS,
  fitView,
  GestureTracker,
  lerpView,
  MAX_ZOOM,
  pinchView,
  sameView,
  STROKE_SLOP,
  toImage,
  zoomAt,
  type GestureHandlers,
} from './gestures';

const image = { width: 1000, height: 2000 };
const box = { width: 400, height: 600 };

describe('view maths', () => {
  it('fits the whole image in the box, centred', () => {
    const view = fitView(image, box);
    expect(view.scale).toBe(0.3);
    expect(view.x).toBe(50);
    expect(view.y).toBe(0);
    expect(toImage(view, { x: 50, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(toImage(view, { x: 350, y: 600 })).toEqual({ x: 1000, y: 2000 });
  });

  it('clamps the zoom between fitted and eight times fitted', () => {
    expect(clampView({ scale: 0.1, x: 0, y: 0 }, image, box)).toEqual(fitView(image, box));
    expect(clampView({ scale: 100, x: 0, y: 0 }, image, box).scale).toBeCloseTo(0.3 * MAX_ZOOM);
  });

  it('keeps a zoomed image over the box with no gap at its edges', () => {
    const view = clampView({ scale: 0.6, x: 100, y: 100 }, image, box);
    expect(view).toEqual({ scale: 0.6, x: 0, y: 0 });
    const far = clampView({ scale: 0.6, x: -5000, y: -5000 }, image, box);
    expect(far).toEqual({ scale: 0.6, x: 400 - 600, y: 600 - 1200 });
  });

  it('centres an axis that is smaller than the box', () => {
    const wide = { width: 2000, height: 500 };
    const view = clampView({ scale: 0.3, x: -999, y: -999 }, wide, box);
    expect(view.x).toBeCloseTo(-200); // 600 wide in a 400 box: held at the right edge
    expect(view.y).toBeCloseTo((600 - 150) / 2); // 150 tall in a 600 box: centred
  });

  it('zooms around a point, keeping the image point under it', () => {
    const start = fitView(image, box);
    const at = { x: 200, y: 300 };
    const before = toImage(start, at);
    const view = zoomAt(start, at, 2, image, box);
    expect(view.scale).toBeCloseTo(0.6);
    const after = toImage(view, at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('pinches: the spread scales, the midpoint pans', () => {
    const start = fitView(image, box);
    const a0 = { x: 150, y: 300 };
    const b0 = { x: 250, y: 300 };
    const anchor = toImage(start, { x: 200, y: 300 });
    // fingers twice as far apart, midpoint unchanged
    const zoomed = pinchView(start, a0, b0, { x: 100, y: 300 }, { x: 300, y: 300 }, image, box);
    expect(zoomed.scale).toBeCloseTo(0.6);
    const under = toImage(zoomed, { x: 200, y: 300 });
    expect(under.x).toBeCloseTo(anchor.x);
    expect(under.y).toBeCloseTo(anchor.y);
    // then both fingers move 20 px left: the image follows
    const panned = pinchView(start, a0, b0, { x: 80, y: 300 }, { x: 280, y: 300 }, image, box);
    expect(panned.x).toBeCloseTo(zoomed.x - 20);
    expect(panned.scale).toBeCloseTo(0.6);
  });

  it('never pinches past the limits, even with fingers on one spot', () => {
    const start = fitView(image, box);
    const p = { x: 200, y: 300 };
    expect(pinchView(start, p, p, p, { x: 2000, y: 300 }, image, box).scale).toBeCloseTo(0.3 * MAX_ZOOM);
    expect(pinchView(start, { x: 0, y: 0 }, { x: 300, y: 0 }, p, p, image, box).scale).toBeCloseTo(0.3);
  });

  it('interpolates and compares views', () => {
    const a = { scale: 1, x: 0, y: 0 };
    const b = { scale: 3, x: 10, y: -10 };
    expect(lerpView(a, b, 0.5)).toEqual({ scale: 2, x: 5, y: -5 });
    expect(sameView(lerpView(a, b, 1), b)).toBe(true);
    expect(sameView(a, b)).toBe(false);
  });
});

type Call = [string, ...unknown[]];

function tracker(slop = STROKE_SLOP) {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args]);
  const handlers: GestureHandlers = {
    strokeStart: record('strokeStart'),
    strokeMove: record('strokeMove'),
    strokeEnd: record('strokeEnd'),
    strokeCancel: record('strokeCancel'),
    pinchStart: record('pinchStart'),
    pinch: record('pinch'),
    pinchEnd: record('pinchEnd'),
    tap: record('tap'),
    doubleTap: record('doubleTap'),
  };
  return { g: new GestureTracker(handlers, slop), calls, names: () => calls.map((c) => c[0]) };
}

describe('GestureTracker', () => {
  it('starts a stroke only after the finger moves past the slop, from where it went down', () => {
    const { g, calls, names } = tracker();
    g.down(1, { x: 10, y: 10 });
    g.move(1, { x: 13, y: 14 }); // 5 px: still a possible tap or pinch
    expect(calls).toEqual([]);
    expect(g.state).toBe('pending');
    g.move(1, { x: 20, y: 10 });
    expect(calls[0]).toEqual(['strokeStart', { x: 10, y: 10 }]);
    expect(calls[1]).toEqual(['strokeMove', { x: 20, y: 10 }]);
    g.move(1, { x: 30, y: 10 });
    g.up(1, { x: 30, y: 10 }, 100);
    expect(names()).toEqual(['strokeStart', 'strokeMove', 'strokeMove', 'strokeEnd']);
    expect(g.state).toBe('idle');
  });

  it('a second finger before the slop pinches instead of drawing a dot', () => {
    const { g, calls, names } = tracker();
    g.down(1, { x: 100, y: 100 });
    g.move(1, { x: 102, y: 101 });
    g.down(2, { x: 200, y: 100 });
    expect(calls[0]).toEqual(['pinchStart', { x: 102, y: 101 }, { x: 200, y: 100 }]);
    g.move(2, { x: 250, y: 100 });
    expect(calls[1]).toEqual(['pinch', { x: 102, y: 101 }, { x: 200, y: 100 }, { x: 102, y: 101 }, { x: 250, y: 100 }]);
    g.up(2, { x: 250, y: 100 }, 50);
    expect(names()).toEqual(['pinchStart', 'pinch', 'pinchEnd']);
  });

  it('a second finger mid-stroke drops the stroke: two fingers never draw', () => {
    const { g, names } = tracker();
    g.down(1, { x: 0, y: 0 });
    g.move(1, { x: 20, y: 0 });
    g.down(2, { x: 100, y: 0 });
    expect(names()).toEqual(['strokeStart', 'strokeMove', 'strokeCancel', 'pinchStart']);
    expect(g.state).toBe('pinch');
  });

  it('after a pinch the finger left down does nothing until all fingers are up', () => {
    const { g, names } = tracker();
    g.down(1, { x: 0, y: 0 });
    g.down(2, { x: 100, y: 0 });
    g.down(3, { x: 50, y: 50 }); // a third finger is ignored
    g.move(3, { x: 80, y: 80 });
    g.up(3, { x: 80, y: 80 }, 10);
    expect(g.state).toBe('pinch');
    g.up(1, { x: 0, y: 0 }, 20);
    expect(g.state).toBe('spent');
    g.move(2, { x: 300, y: 300 });
    g.down(4, { x: 10, y: 10 }); // lands while spent: ignored too
    g.up(4, { x: 10, y: 10 }, 30);
    g.up(2, { x: 300, y: 300 }, 40);
    expect(g.state).toBe('idle');
    expect(names()).toEqual(['pinchStart', 'pinchEnd']);
    // and the next touch draws again
    g.down(5, { x: 0, y: 0 });
    g.move(5, { x: 0, y: 50 });
    expect(names().at(-2)).toBe('strokeStart');
  });

  it('a cancelled stroke is dropped, a cancelled pinch ends', () => {
    const { g, names } = tracker();
    g.down(1, { x: 0, y: 0 });
    g.move(1, { x: 20, y: 0 });
    g.cancel(1);
    g.down(2, { x: 0, y: 0 });
    g.down(3, { x: 50, y: 0 });
    g.cancel(2);
    g.cancel(3);
    expect(names()).toEqual(['strokeStart', 'strokeMove', 'strokeCancel', 'pinchStart', 'pinchEnd']);
    expect(g.state).toBe('idle');
  });

  it('a cancelled touch that never moved is not a tap', () => {
    const { g, calls } = tracker();
    g.down(1, { x: 0, y: 0 });
    g.cancel(1);
    expect(calls).toEqual([]);
  });

  it('ignores pointers it does not follow', () => {
    const { g, calls } = tracker();
    g.move(9, { x: 1, y: 1 });
    g.up(9, { x: 1, y: 1 }, 0);
    expect(calls).toEqual([]);
  });

  it('a touch that never moved is a tap; two close in time and place are a double tap', () => {
    const { g, calls } = tracker();
    g.down(1, { x: 100, y: 100 });
    g.up(1, { x: 100, y: 100 }, 1000);
    g.down(2, { x: 110, y: 105 });
    g.up(2, { x: 110, y: 105 }, 1000 + DOUBLE_TAP_MS - 20);
    expect(calls).toEqual([
      ['tap', { x: 100, y: 100 }],
      ['doubleTap', { x: 110, y: 105 }],
    ]);
    // a third tap starts over
    g.down(3, { x: 110, y: 105 });
    g.up(3, { x: 110, y: 105 }, 1000 + DOUBLE_TAP_MS);
    expect(calls.at(-1)?.[0]).toBe('tap');
  });

  it('taps too slow or too far apart stay single taps', () => {
    const { g, names } = tracker();
    g.down(1, { x: 0, y: 0 });
    g.up(1, { x: 0, y: 0 }, 0);
    g.down(2, { x: 0, y: 0 });
    g.up(2, { x: 0, y: 0 }, DOUBLE_TAP_MS + 1);
    g.down(3, { x: 200, y: 0 });
    g.up(3, { x: 200, y: 0 }, DOUBLE_TAP_MS + 50);
    expect(names()).toEqual(['tap', 'tap', 'tap']);
  });

  it('a stroke or a pinch between two taps breaks the double tap', () => {
    const { g, names } = tracker();
    g.down(1, { x: 0, y: 0 });
    g.up(1, { x: 0, y: 0 }, 0);
    g.down(2, { x: 0, y: 0 });
    g.down(3, { x: 40, y: 0 });
    g.up(2, { x: 0, y: 0 }, 50);
    g.up(3, { x: 40, y: 0 }, 60);
    g.down(4, { x: 0, y: 0 });
    g.up(4, { x: 0, y: 0 }, 100);
    expect(names()).toEqual(['tap', 'pinchStart', 'pinchEnd', 'tap']);
  });
});
