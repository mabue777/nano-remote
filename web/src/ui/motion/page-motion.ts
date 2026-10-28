// The rules of the page push and the edge back swipe (docs/research/interaction-feel-prototype.md row 2, the
// lab's "2. Page push and pop"), without the DOM. routes/PageStack.tsx applies them: a pushed page slides in
// from the right over the one it came from, which shifts left by UNDER_SHIFT of the width and dims to
// UNDER_OPACITY; Back plays it in reverse. A drag that starts within EDGE px of the left edge of a pushed page
// follows the finger with the page beneath showing; on release the finger's speed and position decide.
import type { Direction } from '../../routes/router';
import { lockAxis, settleDuration, shouldComplete } from './gesture';

/** A back swipe starts this close to the left edge (px), as in the lab. */
export const EDGE = 24;
/** How far the page underneath sits to the left while covered, as a fraction of the width. */
export const UNDER_SHIFT = 0.3;
/** How dim the page underneath is while covered. */
export const UNDER_OPACITY = 0.85;
/** The lab's release rule: past 40% of the width, or a flick faster than 0.35 px/ms. */
const SETTLE = { distanceRatio: 0.4, flickVelocity: 0.35 };

export type NavMotion = 'view-transition' | 'animate' | 'instant';

/**
 * How a route change moves: with a View Transition where the browser has them (Safari 18+, Chromium), with
 * the Web Animations API where not, and not at all without a direction, with Reduce Motion, or when the motion
 * already happened (the back swipe, the browser's own swipe).
 */
export function navMotion(direction: Direction, animate: boolean, env: { reduced: boolean; viewTransitions: boolean }): NavMotion {
  if (direction === 'none' || !animate || env.reduced) return 'instant';
  return env.viewTransitions ? 'view-transition' : 'animate';
}

/** Where the page underneath stands while the top page is `dx` px (of `width`) away from its place. */
export function underPose(dx: number, width: number): { x: number; opacity: number } {
  const progress = width <= 0 ? 1 : Math.min(1, Math.max(0, dx / width));
  return { x: -UNDER_SHIFT * width * (1 - progress), opacity: UNDER_OPACITY + (1 - UNDER_OPACITY) * progress };
}

/** The released swipe: back (`pop`) or home again (`snap`), and how long the rest of the motion takes. */
export function settleSwipe(dx: number, velocity: number, width: number, maxMs: number): { outcome: 'pop' | 'snap'; durationMs: number } {
  if (shouldComplete(dx, velocity, width, SETTLE)) return { outcome: 'pop', durationMs: settleDuration(width - dx, velocity, 150, maxMs) };
  return { outcome: 'snap', durationMs: settleDuration(dx, -velocity, 150, maxMs) };
}

/** What a touch on the page has turned into so far. */
export type SwipePhase = 'pending' | 'drag' | 'ignore';

/**
 * A touch that went down at `x`: a candidate for the swipe (`pending`) only near the left edge, when the page
 * can go back and nothing else claims the touch (a sheet, a code block scrolled sideways).
 */
export function swipeStart(x: number, can: { back: boolean; claimed: boolean }): SwipePhase {
  return can.back && !can.claimed && x <= EDGE ? 'pending' : 'ignore';
}

/** A pending touch becomes the swipe once it moves sideways, and is left to the page (a scroll) once it moves up or down. */
export function swipeMove(phase: SwipePhase, dx: number, dy: number): SwipePhase {
  if (phase !== 'pending') return phase;
  const axis = lockAxis(dx, dy);
  if (axis === undefined) return 'pending';
  return axis === 'x' && dx > 0 ? 'drag' : 'ignore';
}

interface ScrollNode {
  scrollLeft: number;
  parentElement: ScrollNode | null;
}

/** Whether `target` sits in something scrolled sideways (a code block), between it and `stop` (both included). */
export function scrolledSideways(target: unknown, stop: unknown): boolean {
  let node = isScrollNode(target) ? target : null;
  while (node !== null) {
    if (node.scrollLeft > 0) return true;
    if (node === stop) return false;
    node = node.parentElement;
  }
  return false;
}

function isScrollNode(value: unknown): value is ScrollNode {
  return typeof value === 'object' && value !== null && 'scrollLeft' in value && 'parentElement' in value;
}

/** The browser facts behind who owns the left edge. */
export interface EdgeEnv {
  userAgent: string;
  maxTouchPoints: number;
  /** display-mode: standalone, or iOS's navigator.standalone: the installed app. */
  standalone: boolean;
}

/** iPhone, iPod or iPad (an iPad's Safari says "Macintosh" but has touch points). */
export function isIOS(env: Pick<EdgeEnv, 'userAgent' | 'maxTouchPoints'>): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

/**
 * Whether the app's own edge swipe runs. In a Safari tab on iOS the left edge belongs to Safari's back swipe,
 * so the app leaves it alone; in the installed app (no Safari swipe) and in other browsers the swipe is ours.
 */
export function ownsEdgeSwipe(env: EdgeEnv): boolean {
  return env.standalone || !isIOS(env);
}

/**
 * Whether a popstate was most likely Safari's own back swipe, for Safaris that do not report
 * `hasUAVisualTransition`: in an iOS tab, a pop that comes while a finger is down or within `windowMs` of
 * the last touch ending. A tap on Safari's back button touches no page content, so it still animates.
 */
export function guessBrowserSwipe(event: { hasUAVisualTransition?: boolean }, touch: { ownsEdge: boolean; down: boolean; lastEnd: number; now: number }, windowMs = 600): boolean {
  if (event.hasUAVisualTransition !== undefined) return event.hasUAVisualTransition;
  if (touch.ownsEdge) return false;
  return touch.down || touch.now - touch.lastEnd < windowMs;
}
