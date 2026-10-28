// The page push and the edge back swipe in the app (docs/research/interaction-feel-prototype.md row 2; the
// lab's "2. Page push and pop"). The rules (when to animate, where the page underneath stands, when a released
// swipe goes back) are in ui/motion/page-motion.ts; this file is the DOM glue, covered by e2e/page-push.spec.ts.
//
// PageMotion sits between the router and the app's route state: it hears every change before the app renders
// it, so a View Transition can capture the old page first (Safari 18+, Chromium). Without View Transitions it
// asks the PageStack to keep the page it came from on screen while the Web Animations API slides the two. The
// root takes no part in the View Transition (only the two pages move, transform and opacity only: the lab found
// the browser's default root transition also animated width, height and backdrop-filter).
//
// PageStack renders the current page in the normal flow (so Home and Settings keep scrolling the window, as
// before) and, during a slide or a back swipe, one more page in a fixed layer: the page beneath (`under`) or
// the one sliding away (`over`). Pages are keyed by path, so the page beneath becomes the current page without
// remounting when a swipe completes. Home's scroll position is saved when it is left and put back when it is
// shown again; a pushed page opens at the top of the window (a session lands at its own bottom as before).
import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { VelocityTracker } from '../ui/motion/gesture';
import { motionOf, prefersReducedMotion } from '../ui/motion/motion';
import { navMotion, ownsEdgeSwipe, scrolledSideways, settleSwipe, swipeMove, swipeStart, underPose, type SwipePhase } from '../ui/motion/page-motion';
import { useDrag } from '../ui/motion/drag';
import { depthOf, routePath, type Direction, type Navigation, type Route } from './router';
import './pages.css';

type ViewTransition = { finished: Promise<void>; skipTransition?: () => void };
type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => ViewTransition };

type Extra = { route: Route; role: 'under' | 'over' };

interface StackHandle {
  setExtra(extra: Extra | null): void;
  top(): HTMLElement | null;
}

/** Whether this browser leaves the left edge to the app (ui/motion/page-motion.ts ownsEdgeSwipe). */
export function browserOwnsEdge(): boolean {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ownsEdgeSwipe({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone });
}

/** Runs each route change: saves the scroll of the page being left and plays the slide. One per app. */
export class PageMotion {
  /** The last change, for the page stack's scroll rule. */
  last: Navigation | undefined;
  private readonly scrolls = new Map<string, number>();
  private stack: StackHandle | null = null;
  private resolveRender: (() => void) | null = null;
  private transition: ViewTransition | null = null;

  constructor(private readonly doc: ViewTransitionDocument = document) {}

  attach(stack: StackHandle | null): void {
    this.stack = stack;
  }

  /** The window scroll saved for a page; 0 for a page never left. */
  scrollOf(route: Route): number {
    return this.scrolls.get(routePath(route)) ?? 0;
  }

  /** A route change heard from the router; `update` makes the app render it. */
  change(navigation: Navigation, update: () => void): void {
    this.last = navigation;
    this.scrolls.set(routePath(navigation.from), window.scrollY);
    this.transition?.skipTransition?.();
    this.finishRender();
    const mode = navMotion(navigation.direction, navigation.animate, {
      reduced: prefersReducedMotion(window),
      viewTransitions: typeof this.doc.startViewTransition === 'function',
    });
    const html = this.doc.documentElement;
    // Web Animations: the page left stays on screen, beneath a push or above a pop, while the two slide.
    const extra: Extra | null = mode === 'animate' ? { route: navigation.from, role: navigation.direction === 'push' ? 'under' : 'over' } : null;
    const apply = () => {
      this.stack?.setExtra(extra);
      update();
    };
    if (mode === 'view-transition') {
      html.dataset.nav = navigation.direction;
      this.stack?.top()?.setAttribute('data-vt-old', '');
      const transition = this.doc.startViewTransition!(
        () =>
          new Promise<void>((resolve) => {
            this.resolveRender = resolve;
            apply();
            // Never leave the page frozen if nothing renders (a change that leaves the page stack).
            setTimeout(() => this.finishRender(), 400);
          }),
      );
      this.transition = transition;
      void transition.finished
        .catch(() => undefined)
        .finally(() => {
          if (this.transition !== transition) return;
          this.transition = null;
          delete html.dataset.nav;
          this.doc.querySelectorAll('[data-vt-old]').forEach((el) => el.removeAttribute('data-vt-old'));
        });
      return;
    }
    if (extra !== null) html.dataset.nav = navigation.direction;
    apply();
  }

  /** The Web Animations slide ended. */
  slid(): void {
    delete this.doc.documentElement.dataset.nav;
  }

  /** The app rendered the change (its layout effect): the View Transition captures the new page after effects ran. */
  rendered(): void {
    if (this.resolveRender === null) return;
    // After Preact's effects (they run on the next frame or within 35 ms), so a session has landed at its bottom.
    let done = false;
    const next = () => {
      if (done) return;
      done = true;
      setTimeout(() => setTimeout(() => this.finishRender()));
    };
    requestAnimationFrame(next);
    setTimeout(next, 35);
  }

  private finishRender(): void {
    const resolve = this.resolveRender;
    this.resolveRender = null;
    resolve?.();
  }
}

export interface PageStackProps {
  route: Route;
  motion: PageMotion;
  render: (route: Route) => VNode;
  /** The page Back goes to from `route`; null where there is none (Home). */
  parentOf: (route: Route) => Route | null;
  /** The back swipe completed (the page already slid away): go back without animating again. */
  onSwipeBack: (to: Route) => void;
  /** Whether the app's own edge swipe runs (browserOwnsEdge). */
  ownsEdge: boolean;
}

interface Swipe {
  phase: SwipePhase;
  x: number;
  y: number;
  dx: number;
}

export function PageStack({ route, motion, render, parentOf, onSwipeBack, ownsEdge }: PageStackProps) {
  const [extra, setExtra] = useState<Extra | null>(null);
  const [swiping, setSwiping] = useState(false);
  const elements = useRef(new Map<string, HTMLElement>());
  const topKey = routePath(route);
  const shownTop = useRef<string | null>(null);
  const generation = useRef(0);

  useLayoutEffect(() => {
    motion.attach({ setExtra, top: () => elements.current.get(routePath(route)) ?? null });
    return () => motion.attach(null);
  }, [motion, route]);

  // A page whose extra page belongs to an older route (a change came mid-slide) drops it.
  const shownExtra = extra !== null && routePath(extra.route) !== topKey ? extra : null;
  const parent = parentOf(route);

  // The scroll rule and the Web Animations slide, once per change of the current page.
  useLayoutEffect(() => {
    const previous = shownTop.current;
    shownTop.current = topKey;
    const top = elements.current.get(topKey);
    if (top !== undefined) settle(top);
    if (previous === null || previous === topKey) return;
    const direction: Direction = motion.last?.direction ?? 'none';
    if (direction === 'pop') window.scrollTo(0, motion.scrollOf(route));
    else if (direction === 'push') window.scrollTo(0, 0);
    if (shownExtra === null || top === undefined) return;
    const other = elements.current.get(routePath(shownExtra.route));
    if (other === undefined) return;
    if (shownExtra.role === 'under') other.scrollTop = motion.scrollOf(shownExtra.route);
    const m = motionOf(top);
    const width = top.offsetWidth || window.innerWidth;
    const under = underPose(0, width);
    const ticket = ++generation.current;
    const done = () => {
      if (generation.current !== ticket) return;
      motion.slid();
      setExtra(null);
    };
    const options = { duration: m.relaxed, easing: m.enter };
    if (shownExtra.role === 'under') {
      top.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], options).onfinish = done;
      other.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${under.x}px)`, opacity: under.opacity }], { ...options, fill: 'forwards' });
    } else {
      other.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], { ...options, fill: 'forwards' }).onfinish = done;
      top.animate([{ transform: `translateX(${under.x}px)`, opacity: under.opacity }, { transform: 'translateX(0)', opacity: 1 }], options);
    }
  }, [topKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page beneath a swipe shows Home where it was left.
  useLayoutEffect(() => {
    if (shownExtra?.role !== 'under' || !swiping) return;
    const el = elements.current.get(routePath(shownExtra.route));
    if (el === undefined) return;
    el.scrollTop = motion.scrollOf(shownExtra.route);
    const top = elements.current.get(topKey);
    pose(el, underPose(swipe.current.dx, top?.offsetWidth || window.innerWidth));
  }, [shownExtra, swiping]); // eslint-disable-line react-hooks/exhaustive-deps

  // The edge back swipe on a pushed page: listeners on the current page's element (a new ref per page, so
  // useDrag moves them when the page changes).
  const topRef = useMemo<{ current: HTMLElement | null }>(() => ({ current: null }), [topKey]);
  const swipe = useRef<Swipe>({ phase: 'ignore', x: 0, y: 0, dx: 0 });
  const tracker = useRef(new VelocityTracker());
  const underOf = () => (parent === null ? undefined : elements.current.get(routePath(parent)));
  const canSwipe = ownsEdge && parent !== null && depthOf(route) > 0 && (shownExtra === null || swiping);
  useDrag(topRef, canSwipe, {
    start(x, y, target, time) {
      const top = topRef.current;
      const claimed = document.querySelector('.sheet-backdrop:not(.sheet-ghost)') !== null || scrolledSideways(target, top);
      const phase = swipeStart(x, { back: parent !== null, claimed });
      swipe.current = { phase, x, y, dx: 0 };
      if (phase === 'ignore') return false;
      tracker.current.reset();
      tracker.current.add(time, x);
      return true;
    },
    move(x, y, time) {
      const state = swipe.current;
      const before = state.phase;
      state.phase = swipeMove(state.phase, x - state.x, y - state.y);
      if (state.phase !== 'drag') return false;
      const top = topRef.current;
      if (top === null || parent === null) return false;
      if (before === 'pending') {
        ++generation.current;
        top.dataset.swipe = 'drag';
        setExtra({ route: parent, role: 'under' });
        setSwiping(true);
      }
      const width = top.offsetWidth || 1;
      state.dx = Math.max(0, x - state.x);
      top.style.transform = `translateX(${state.dx}px)`;
      const under = underOf();
      if (under !== undefined) pose(under, underPose(state.dx, width));
      tracker.current.add(time, x);
      return true;
    },
    end(cancelled) {
      const state = swipe.current;
      const dragged = state.phase === 'drag';
      state.phase = 'ignore';
      const top = topRef.current;
      if (!dragged || top === null || parent === null) return;
      const width = top.offsetWidth || 1;
      const velocity = cancelled ? 0 : tracker.current.velocity();
      const { outcome, durationMs } = cancelled ? { outcome: 'snap' as const, durationMs: 0 } : settleSwipe(state.dx, velocity, width, motionOf(top).relaxed);
      const under = underOf();
      const reduced = prefersReducedMotion(window);
      const ticket = ++generation.current;
      const easing = velocity > 0.3 ? 'cubic-bezier(0.2, 0.6, 0.35, 1)' : motionOf(top).standard;
      const from = state.dx;
      const startPose = underPose(from, width);
      const animate = (target: number, after: () => void) => {
        if (reduced || durationMs === 0) {
          after();
          return;
        }
        top.dataset.swipe = 'settle';
        const endPose = underPose(target, width);
        top.style.transform = '';
        const a = top.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${target}px)` }], { duration: durationMs, easing, fill: 'forwards' });
        if (under !== undefined) {
          clearPose(under);
          under.animate(
            [
              { transform: `translateX(${startPose.x}px)`, opacity: startPose.opacity },
              { transform: `translateX(${endPose.x}px)`, opacity: endPose.opacity },
            ],
            { duration: durationMs, easing, fill: 'forwards' },
          );
        }
        a.onfinish = () => {
          if (generation.current === ticket) after();
        };
      };
      if (outcome === 'pop') {
        animate(width, () => {
          top.style.transform = `translateX(${width}px)`;
          top.dataset.swipe = 'done';
          onSwipeBack(parent);
        });
        return;
      }
      animate(0, () => {
        settle(top);
        setExtra(null);
        setSwiping(false);
      });
    },
  });

  // The swipe is over once the page it uncovered became the current page.
  useEffect(() => {
    if (swiping && (shownExtra === null || shownExtra.role !== 'under')) setSwiping(false);
  }, [swiping, shownExtra]);

  const pages: { route: Route; role: 'top' | 'under' | 'over' }[] = [];
  if (shownExtra?.role === 'under') pages.push({ route: shownExtra.route, role: 'under' });
  pages.push({ route, role: 'top' });
  if (shownExtra?.role === 'over') pages.push({ route: shownExtra.route, role: 'over' });

  return (
    <div class={`pages${shownExtra !== null ? ' stacked' : ''}`}>
      {pages.map((page) => {
        const key = routePath(page.route);
        return (
          <div
            key={key}
            class={`page${depthOf(page.route) > 0 ? ' page-pushed' : ''}`}
            data-page-role={page.role}
            aria-hidden={page.role === 'top' ? undefined : 'true'}
            inert={page.role === 'top' ? undefined : true}
            ref={(el) => {
              if (el === null) elements.current.delete(key);
              else elements.current.set(key, el);
              if (page.role === 'top') topRef.current = el;
            }}
          >
            {render(page.route)}
          </div>
        );
      })}
    </div>
  );
}

function pose(el: HTMLElement, p: { x: number; opacity: number }): void {
  el.style.transform = `translateX(${p.x}px)`;
  el.style.opacity = String(p.opacity);
}

function clearPose(el: HTMLElement): void {
  el.style.transform = '';
  el.style.opacity = '';
}

/** Back at rest: no leftover animation fill, inline pose or swipe mark. */
function settle(el: HTMLElement): void {
  for (const a of el.getAnimations?.() ?? []) if (a.effect instanceof KeyframeEffect && a.effect.target === el) a.cancel();
  clearPose(el);
  delete el.dataset.swipe;
}
