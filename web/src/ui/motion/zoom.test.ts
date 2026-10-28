import { describe, expect, it } from 'vitest';

import {
  clampPan,
  coverCrop,
  dismissBackdrop,
  dismissProgress,
  dismissScale,
  DOUBLE_TAP_ZOOM,
  doubleTapZoom,
  elasticPan,
  elasticScale,
  fitRect,
  flingPan,
  IDENTITY,
  intersects,
  isZoomed,
  MAX_ZOOM,
  NO_CLIP,
  panBounds,
  pinchZoom,
  settleZoom,
  zoomAt,
  zoomedRect,
  zoomOfRect,
  zoomTransform,
} from './zoom';

const PHONE = { width: 390, height: 844 };
// A 2:1 picture on the phone: 390 x 195, centred vertically.
const WIDE = fitRect({ width: 2048, height: 1024 }, PHONE);

describe('fitRect', () => {
  it('fits a wide picture to the width and a tall one to the height, centred', () => {
    expect(WIDE).toEqual({ left: 0, top: 324.5, width: 390, height: 195 });
    expect(fitRect({ width: 500, height: 2000 }, PHONE)).toEqual({ left: 89.5, top: 0, width: 211, height: 844 });
  });

  it('scales a small picture up, like Photos', () => {
    expect(fitRect({ width: 39, height: 39 }, PHONE)).toEqual({ left: 0, top: 227, width: 390, height: 390 });
  });

  it('a picture or viewport without a size fills the viewport', () => {
    expect(fitRect({ width: 0, height: 10 }, PHONE)).toEqual({ left: 0, top: 0, ...PHONE });
    expect(fitRect({ width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe('zoom boxes and transforms', () => {
  it('zoomedRect and zoomOfRect are inverses', () => {
    const zoom = { scale: 2, x: -100, y: -50 };
    const rect = zoomedRect(zoom, WIDE);
    expect(rect).toEqual({ left: -100, top: 274.5, width: 780, height: 390 });
    expect(zoomOfRect(rect, WIDE)).toEqual(zoom);
    expect(zoomOfRect(rect, { ...WIDE, width: 0 }).scale).toBe(1);
  });

  it('writes translate then scale, rounded', () => {
    expect(zoomTransform({ scale: 2.123456, x: 1.006, y: -3 })).toBe('translate(1.01px, -3px) scale(2.1235)');
    expect(zoomTransform(IDENTITY)).toBe('translate(0px, 0px) scale(1)');
  });

  it('zoomAt keeps the point under the focus in place', () => {
    const focal = { x: 100, y: 400 };
    const zoomed = zoomAt(IDENTITY, WIDE, focal, 3);
    // The picture's point under the focus before and after.
    const before = { x: (focal.x - WIDE.left) / 1, y: (focal.y - WIDE.top) / 1 };
    const after = { x: (focal.x - WIDE.left - zoomed.x) / 3, y: (focal.y - WIDE.top - zoomed.y) / 3 };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('isZoomed ignores rounding noise', () => {
    expect(isZoomed({ scale: 1.005, x: 0, y: 0 })).toBe(false);
    expect(isZoomed({ scale: 1.5, x: 0, y: 0 })).toBe(true);
  });
});

describe('panning', () => {
  it('a side narrower than the viewport stays centred; a wider one may move to either edge', () => {
    // At 2x the wide picture is 780 x 390: wider than the phone, still shorter than it.
    expect(panBounds(2, WIDE, PHONE)).toEqual({ minX: -390, maxX: 0, minY: -97.5, maxY: -97.5 });
    expect(panBounds(1, WIDE, PHONE)).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  it('clampPan holds the pan inside the bounds', () => {
    expect(clampPan({ scale: 2, x: 50, y: 0 }, WIDE, PHONE)).toEqual({ scale: 2, x: 0, y: -97.5 });
    expect(clampPan({ scale: 2, x: -500, y: -300 }, WIDE, PHONE)).toEqual({ scale: 2, x: -390, y: -97.5 });
  });

  it('elasticPan resists past the bounds instead of stopping', () => {
    const past = elasticPan({ scale: 2, x: 100, y: -97.5 }, WIDE, PHONE);
    expect(past.x).toBeGreaterThan(0);
    expect(past.x).toBeLessThan(100);
    const before = elasticPan({ scale: 2, x: -490, y: -97.5 }, WIDE, PHONE);
    expect(before.x).toBeLessThan(-390);
    expect(before.x).toBeGreaterThan(-490);
    expect(elasticPan({ scale: 2, x: -200, y: -97.5 }, WIDE, PHONE).x).toBe(-200);
  });

  it('flingPan carries on at the release speed and stays inside', () => {
    expect(flingPan({ scale: 2, x: -200, y: -97.5 }, WIDE, PHONE, { x: 0.5, y: 0 }, 100)).toEqual({ scale: 2, x: -150, y: -97.5 });
    expect(flingPan({ scale: 2, x: -200, y: -97.5 }, WIDE, PHONE, { x: -5, y: 3 })).toEqual({ scale: 2, x: -390, y: -97.5 });
  });
});

describe('pinch and double tap', () => {
  const a0 = { x: 145, y: 422 };
  const b0 = { x: 245, y: 422 };

  it('scales by the change in finger distance about the midpoint', () => {
    const zoom = pinchZoom(IDENTITY, WIDE, a0, b0, { x: 95, y: 422 }, { x: 295, y: 422 });
    expect(zoom.scale).toBeCloseTo(2);
    // The midpoint (195, 422) stays on the same point of the picture.
    expect((195 - WIDE.left - zoom.x) / zoom.scale).toBeCloseTo(195);
    expect((422 - WIDE.top - zoom.y) / zoom.scale).toBeCloseTo(97.5);
  });

  it('follows the midpoint when both fingers move together', () => {
    const zoom = pinchZoom(IDENTITY, WIDE, a0, b0, { x: 165, y: 432 }, { x: 265, y: 432 });
    expect(zoom).toEqual({ scale: 1, x: 20, y: 10 });
  });

  it('resists past MAX_ZOOM and below fit', () => {
    expect(elasticScale(2)).toBe(2);
    expect(elasticScale(8)).toBeGreaterThan(MAX_ZOOM);
    expect(elasticScale(8)).toBeLessThan(MAX_ZOOM + 1);
    expect(elasticScale(0.2)).toBeLessThan(1);
    expect(elasticScale(0.2)).toBeGreaterThan(0.5);
    // Fingers on the same spot do not divide by zero.
    expect(Number.isFinite(pinchZoom(IDENTITY, WIDE, a0, a0, a0, b0).scale)).toBe(true);
  });

  it('settles back inside the limits', () => {
    expect(settleZoom({ scale: 0.7, x: 30, y: 20 }, WIDE, PHONE, { x: 195, y: 422 })).toEqual(IDENTITY);
    const deep = settleZoom({ scale: 4.6, x: -800, y: -400 }, WIDE, PHONE, { x: 195, y: 422 });
    expect(deep.scale).toBe(MAX_ZOOM);
    const bounds = panBounds(MAX_ZOOM, WIDE, PHONE);
    expect(deep.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(deep.x).toBeLessThanOrEqual(bounds.maxX);
    expect(settleZoom({ scale: 2, x: 40, y: 0 }, WIDE, PHONE, { x: 0, y: 0 })).toEqual({ scale: 2, x: 0, y: -97.5 });
  });

  it('a double tap zooms in about the tap, and back out when zoomed', () => {
    const zoomed = doubleTapZoom(IDENTITY, WIDE, PHONE, { x: 100, y: 422 });
    expect(zoomed.scale).toBe(DOUBLE_TAP_ZOOM);
    expect(zoomed.x).toBeCloseTo(-150);
    expect(doubleTapZoom(zoomed, WIDE, PHONE, { x: 100, y: 422 })).toEqual(IDENTITY);
  });
});

describe('the grow out of a thumbnail', () => {
  it('covers the square thumbnail, centred on it, clipped to it with its corners', () => {
    const thumb = { left: 149, top: 100, width: 96, height: 96 };
    const crop = coverCrop(thumb, WIDE, 10);
    // Covering a square with a 2:1 picture: the height decides.
    expect(crop.zoom.scale).toBeCloseTo(96 / 195);
    const box = zoomedRect(crop.zoom, WIDE);
    expect(box.left + box.width / 2).toBeCloseTo(197);
    expect(box.top + box.height / 2).toBeCloseTo(148);
    // Clipped in the picture's own pixels: half of (390 - 195) from each side, none from top and bottom.
    expect(crop.clip).toBe('inset(0px 97.5px round 20.31px)');
  });

  it('a thumbnail the same shape as the picture is not clipped', () => {
    expect(coverCrop({ left: 0, top: 0, width: 96, height: 48 }, WIDE, 0).clip).toBe('inset(0px 0px round 0px)');
    expect(NO_CLIP).toBe('inset(0px 0px round 0px)');
  });

  it('intersects tells whether a thumbnail is on screen', () => {
    const screen = { left: 0, top: 0, ...PHONE };
    expect(intersects({ left: 10, top: 10, width: 96, height: 96 }, screen)).toBe(true);
    expect(intersects({ left: 10, top: -200, width: 96, height: 96 }, screen)).toBe(false);
    expect(intersects({ left: 10, top: 10, width: 0, height: 96 }, screen)).toBe(false);
  });
});

describe('the drag down', () => {
  it('shrinks the picture and fades the layer as it goes', () => {
    expect(dismissProgress(211, 844)).toBe(0.25);
    expect(dismissProgress(-50, 844)).toBe(0);
    expect(dismissProgress(2000, 844)).toBe(1);
    expect(dismissProgress(10, 0)).toBe(0);
    expect(dismissScale(0)).toBe(1);
    expect(dismissScale(1)).toBeCloseTo(0.65);
    expect(dismissBackdrop(0)).toBe(1);
    expect(dismissBackdrop(0.25)).toBe(0.5);
    expect(dismissBackdrop(0.8)).toBe(0);
  });
});
