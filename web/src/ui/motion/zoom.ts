// The geometry of a zoomable picture (the image viewer, ui/ImageViewer.tsx), without the DOM: where a picture
// fits on the screen, how a pinch or a double tap scales it about the fingers, how far it may be panned, and the
// transform that makes the full picture look exactly like its cropped square thumbnail (the grow and shrink).
//
// One convention throughout: the picture is laid out at its fit box (`fitRect`), with `transform-origin: 0 0`
// and `transform: translate(x, y) scale(scale)`. So on screen its box is
// { left: fit.left + x, top: fit.top + y, width: fit.width * scale, height: fit.height * scale }.
import { rubberBand } from './gesture';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

/** The deepest a pinch or a double tap goes. */
export const MAX_ZOOM = 4;
/** Where a double tap on the fitted picture zooms to (a second double tap goes back to fit). */
export const DOUBLE_TAP_ZOOM = 2.5;
/** At rest: the picture fitted, not moved. */
export const IDENTITY: Zoom = { scale: 1, x: 0, y: 0 };

/** The picture as large as fits the viewport, centred (like Photos: small pictures are scaled up too). */
export function fitRect(natural: Size, viewport: Size): Rect {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { left: 0, top: 0, width: viewport.width, height: viewport.height };
  }
  const scale = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2, width, height };
}

/** The box the picture covers on screen under `zoom`. */
export function zoomedRect(zoom: Zoom, fit: Rect): Rect {
  return { left: fit.left + zoom.x, top: fit.top + zoom.y, width: fit.width * zoom.scale, height: fit.height * zoom.scale };
}

/** The zoom that puts the picture's box at `rect` (a measured box; the aspect ratio is the fit box's). */
export function zoomOfRect(rect: Rect, fit: Rect): Zoom {
  return { scale: fit.width > 0 ? rect.width / fit.width : 1, x: rect.left - fit.left, y: rect.top - fit.top };
}

/** The CSS transform for `zoom`. */
export function zoomTransform(zoom: Zoom): string {
  return `translate(${round(zoom.x)}px, ${round(zoom.y)}px) scale(${round(zoom.scale, 10000)})`;
}

/** The zoom scaled to `scale` about the screen point `focal`: the part of the picture under it stays put. */
export function zoomAt(zoom: Zoom, fit: Rect, focal: Point, scale: number): Zoom {
  const local = { x: (focal.x - fit.left - zoom.x) / zoom.scale, y: (focal.y - fit.top - zoom.y) / zoom.scale };
  return { scale, x: focal.x - fit.left - scale * local.x, y: focal.y - fit.top - scale * local.y };
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** How far the picture may be panned at `scale`: a side narrower than the viewport stays centred. */
export function panBounds(scale: number, fit: Rect, viewport: Size): Bounds {
  const axis = (size: number, view: number, start: number) => {
    const length = size * scale;
    if (length <= view) {
      const centred = (view - length) / 2 - start;
      return [centred, centred] as const;
    }
    return [view - length - start, 0 - start] as const;
  };
  const [minX, maxX] = axis(fit.width, viewport.width, fit.left);
  const [minY, maxY] = axis(fit.height, viewport.height, fit.top);
  return { minX, maxX, minY, maxY };
}

/** The zoom with its pan held inside the bounds (where a pan comes to rest). */
export function clampPan(zoom: Zoom, fit: Rect, viewport: Size): Zoom {
  const b = panBounds(zoom.scale, fit, viewport);
  return { scale: zoom.scale, x: clamp(zoom.x, b.minX, b.maxX), y: clamp(zoom.y, b.minY, b.maxY) };
}

/** The zoom with a pan past the bounds resisted (rubber band), while a finger holds it. */
export function elasticPan(zoom: Zoom, fit: Rect, viewport: Size): Zoom {
  const b = panBounds(zoom.scale, fit, viewport);
  const resist = (value: number, min: number, max: number) => (value < min ? min - rubberBand(min - value) : value > max ? max + rubberBand(value - max) : value);
  return { scale: zoom.scale, x: resist(zoom.x, b.minX, b.maxX), y: resist(zoom.y, b.minY, b.maxY) };
}

/** A scale under a pinch: free between 1 and MAX_ZOOM, resisted past either end. */
export function elasticScale(scale: number): number {
  if (scale > MAX_ZOOM) return MAX_ZOOM + rubberBand(scale - MAX_ZOOM, 1);
  if (scale < 1) return 1 - rubberBand(1 - scale, 0.5);
  return scale;
}

/**
 * The zoom under a two-finger pinch that started at `start` with the fingers at a0, b0 and has them now at
 * a1, b1: the picture scales by the change in finger distance and follows the midpoint.
 */
export function pinchZoom(start: Zoom, fit: Rect, a0: Point, b0: Point, a1: Point, b1: Point): Zoom {
  const d0 = Math.max(1, distance(a0, b0));
  const scale = elasticScale((start.scale * distance(a1, b1)) / d0);
  const m0 = midpoint(a0, b0);
  const m1 = midpoint(a1, b1);
  const local = { x: (m0.x - fit.left - start.x) / start.scale, y: (m0.y - fit.top - start.y) / start.scale };
  return { scale, x: m1.x - fit.left - scale * local.x, y: m1.y - fit.top - scale * local.y };
}

/** Where a released pinch comes to rest: the scale back inside [1, MAX_ZOOM] about `focal`, then the pan. */
export function settleZoom(zoom: Zoom, fit: Rect, viewport: Size, focal: Point): Zoom {
  const scale = clamp(zoom.scale, 1, MAX_ZOOM);
  const scaled = scale === zoom.scale ? zoom : zoomAt(zoom, fit, focal, scale);
  if (scale === 1) return { ...IDENTITY };
  return clampPan(scaled, fit, viewport);
}

/** A double tap at `point`: zoomed in goes back to fit; fitted zooms in about the tapped point. */
export function doubleTapZoom(zoom: Zoom, fit: Rect, viewport: Size, point: Point): Zoom {
  if (isZoomed(zoom)) return { ...IDENTITY };
  return clampPan(zoomAt(zoom, fit, point, DOUBLE_TAP_ZOOM), fit, viewport);
}

export function isZoomed(zoom: Zoom): boolean {
  return zoom.scale > 1.01;
}

/** Where a released pan comes to rest: it carries on for `carryMs` at the release speed, then stays inside. */
export function flingPan(zoom: Zoom, fit: Rect, viewport: Size, velocity: Point, carryMs = 160): Zoom {
  return clampPan({ scale: zoom.scale, x: zoom.x + velocity.x * carryMs, y: zoom.y + velocity.y * carryMs }, fit, viewport);
}

export interface Crop {
  /** The zoom that puts the picture over the thumbnail, scaled to cover it. */
  zoom: Zoom;
  /** `clip-path` that cuts the picture down to the thumbnail's square with its rounded corners. */
  clip: string;
}

/**
 * The picture made to look like its thumbnail (an `object-fit: cover` crop of it at `thumb`, corner radius
 * `radius`): scaled to cover the thumbnail's box, centred on it, and clipped to it. Clip insets are in the
 * picture's own (unscaled) pixels, because clip-path applies before the transform.
 */
export function coverCrop(thumb: Rect, fit: Rect, radius: number): Crop {
  const scale = Math.max(thumb.width / fit.width, thumb.height / fit.height);
  const zoom = {
    scale,
    x: thumb.left + thumb.width / 2 - (fit.width * scale) / 2 - fit.left,
    y: thumb.top + thumb.height / 2 - (fit.height * scale) / 2 - fit.top,
  };
  const insetX = Math.max(0, (fit.width - thumb.width / scale) / 2);
  const insetY = Math.max(0, (fit.height - thumb.height / scale) / 2);
  return { zoom, clip: insetClip(insetY, insetX, radius / scale) };
}

/** No clipping, in the same form as a crop's, so the two interpolate. */
export const NO_CLIP = insetClip(0, 0, 0);

function insetClip(y: number, x: number, radius: number): string {
  return `inset(${round(y)}px ${round(x)}px round ${round(radius)}px)`;
}

/** The share of the screen height a drag down has covered, 0 to 1 (drives the shrink and the fade). */
export function dismissProgress(dy: number, viewportHeight: number): number {
  if (viewportHeight <= 0) return 0;
  return clamp(dy / viewportHeight, 0, 1);
}

/** The picture's scale while dragged down: it shrinks a little as it goes, like Photos. */
export function dismissScale(progress: number): number {
  return 1 - 0.35 * progress;
}

/** The black layer's opacity while dragged down: gone by half the screen. */
export function dismissBackdrop(progress: number): number {
  return clamp(1 - progress * 2, 0, 1);
}

/** Two rectangles share some area (a thumbnail still on screen can take the picture back). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, factor = 100): number {
  return Math.round(value * factor) / factor;
}
