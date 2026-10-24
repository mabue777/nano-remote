// The motion of the bottom sheet (ui/Sheet.tsx), from the interaction lab's Smooth sheet (lab/LabSheet.tsx,
// technique 3): the panel slides up on a spring while the dim layer fades in; a drag down follows the finger
// (from anywhere while the content is scrolled to its top) and on release the finger's speed and distance
// decide between dismissing and springing back; closing slides the panel out and fades the dim layer.
//
// The exit plays on every close path. The sheet's owner removes it the moment it closes (Cancel, Done, a
// backdrop tap, Escape, a confirmed delete, a saved form), so on unmount the controller leaves an inert copy
// of the sheet (the "ghost": no ids, no dialog role, aria-hidden, no pointer events) on the page, slides that
// out and removes it. With reduced motion nothing animates by itself; a drag still follows the finger.
// Only transform and opacity animate.
import { lockAxis, rubberBand, settleDuration, shouldComplete, VelocityTracker } from './gesture';
import { motionOf, prefersReducedMotion, scrolledAbove, type Motion } from './motion';
import { SHEET_SPRING, springEasing } from './spring';

export interface SheetParts {
  /** The fixed layer that holds the dim layer and the panel (.sheet-backdrop). */
  backdrop: HTMLElement;
  /** The dim layer (.sheet-scrim). */
  scrim: HTMLElement;
  /** The panel (.sheet). */
  panel: HTMLElement;
}

export interface SheetMotionEnv {
  reduced(): boolean;
  /** Whether CSS `linear()` easing works (Safari 17.2+); without it the spring falls back to --ease-enter. */
  linearEasing: boolean;
  motion(element: Element): Motion;
  /** The current transform and opacity, mid-animation included. */
  styleOf(element: Element): { transform: string; opacity: string };
  /** Where the exiting copy goes (document.body). */
  host(): { appendChild(node: Node): unknown } | null;
  setTimeout(run: () => void, ms: number): unknown;
}

export function browserSheetEnv(): SheetMotionEnv {
  return {
    reduced: () => prefersReducedMotion(),
    linearEasing: typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)'),
    motion: (element) => motionOf(element),
    styleOf: (element) => getComputedStyle(element),
    host: () => (typeof document === 'undefined' ? null : document.body),
    setTimeout: (run, ms) => window.setTimeout(run, ms),
  };
}

/** A pull past this share of the panel's height dismisses it on a slow release. */
export const DISMISS_RATIO = 0.3;
/** The class of the exiting copy (pointer-events: none in components.css). */
export const GHOST_CLASS = 'sheet-ghost';

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

type Phase = 'idle' | 'pending' | 'drag';

/** One open sheet's motion. Its start/move/end methods are the drag handlers for useDrag (drag.ts). */
export class SheetMotion {
  private parts: SheetParts | null = null;
  private readonly spring = springEasing(SHEET_SPRING);
  private readonly tracker = new VelocityTracker();
  private phase: Phase = 'idle';
  private startX = 0;
  private startY = 0;
  /** How far the panel is pulled down (px); 0 at rest. */
  private offset = 0;
  /** The finger's speed when a drag dismissed the sheet (px/ms, downwards); the exit carries it on. */
  private releaseVelocity = 0;
  /** A drag dismissed the sheet and is waiting for its owner to remove it. */
  private dismissing = false;
  private gone = false;

  constructor(
    private readonly onDismiss: () => void,
    private readonly env: SheetMotionEnv = browserSheetEnv(),
  ) {}

  /** The sheet is in the page: slide the panel up and fade the dim layer in. */
  open(parts: SheetParts): void {
    this.parts = parts;
    if (!this.animates()) return;
    parts.panel.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], this.springTiming());
    const m = this.env.motion(parts.panel);
    parts.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: m.moderate, easing: m.standard });
  }

  /** The owner removed the sheet (it is still in the page): slide a copy of it out, then drop the copy. */
  close(): void {
    const parts = this.parts;
    const animates = this.animates();
    this.parts = null;
    this.gone = true;
    if (parts === null || !animates) return;
    const host = this.env.host();
    if (host === null) return;
    const { panel, scrim } = parts;
    const height = panel.offsetHeight || 1;
    const fromTransform = cssTransform(this.env.styleOf(panel).transform);
    const fromOpacity = Number(this.env.styleOf(scrim).opacity || '1');
    const ghost = ghostOf(parts.backdrop);
    host.appendChild(ghost.root);
    copyScroll(parts.backdrop, ghost.root);
    const velocity = this.releaseVelocity;
    const m = this.env.motion(panel);
    const duration = settleDuration(height - this.offset, velocity, 140, 260);
    ghost.panel?.animate([{ transform: fromTransform }, { transform: 'translateY(100%)' }], { duration, easing: velocity > 0.3 ? 'linear' : m.exit, fill: 'forwards' });
    ghost.scrim?.animate([{ opacity: fromOpacity }, { opacity: 0 }], { duration, easing: m.standard, fill: 'forwards' });
    this.env.setTimeout(() => ghost.root.remove(), duration);
  }

  start(x: number, y: number, target: EventTarget | null, time: number): boolean {
    const panel = this.parts?.panel;
    if (panel === undefined || this.dismissing || isEditable(target) || scrolledAbove(target, panel)) return false;
    this.phase = 'pending';
    this.startX = x;
    this.startY = y;
    this.tracker.reset();
    this.tracker.add(time, y);
    return true;
  }

  move(x: number, y: number, time: number): boolean {
    const parts = this.parts;
    if (parts === null || this.phase === 'idle') return false;
    if (this.phase === 'pending') {
      const axis = lockAxis(x - this.startX, y - this.startY);
      if (axis === undefined) return false;
      if (axis === 'x' || y < this.startY) {
        this.phase = 'idle'; // sideways or upwards: not a dismiss; the content scrolls
        return false;
      }
      this.phase = 'drag';
      this.startY = y;
      for (const animation of parts.panel.getAnimations()) animation.cancel();
      for (const animation of parts.scrim.getAnimations()) animation.cancel();
    }
    const dy = y - this.startY;
    this.offset = dy >= 0 ? dy : -rubberBand(-dy, 40);
    parts.panel.style.transform = `translateY(${this.offset}px)`;
    parts.scrim.style.opacity = String(1 - Math.min(1, Math.max(0, this.offset) / (parts.panel.offsetHeight || 1)));
    this.tracker.add(time, y);
    return true;
  }

  end(): void {
    const parts = this.parts;
    const dragged = this.phase === 'drag';
    this.phase = 'idle';
    if (!dragged || parts === null) return;
    const velocity = this.tracker.velocity();
    const height = parts.panel.offsetHeight || 1;
    if (shouldComplete(this.offset, velocity, height, { distanceRatio: DISMISS_RATIO })) {
      this.dismissing = true;
      this.releaseVelocity = velocity;
      this.onDismiss();
      // An owner that keeps the sheet open (e.g. while it is busy) gets it back in place.
      this.env.setTimeout(() => {
        this.dismissing = false;
        if (!this.gone) this.springBack();
      }, 0);
      return;
    }
    this.springBack();
  }

  private springBack(): void {
    const parts = this.parts;
    if (parts === null) return;
    const from = this.offset;
    const height = parts.panel.offsetHeight || 1;
    this.offset = 0;
    this.releaseVelocity = 0;
    parts.panel.style.transform = '';
    parts.scrim.style.opacity = '';
    if (!this.animates()) return;
    parts.panel.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], this.springTiming());
    const m = this.env.motion(parts.panel);
    parts.scrim.animate([{ opacity: 1 - Math.min(1, Math.max(0, from) / height) }, { opacity: 1 }], { duration: m.moderate, easing: m.standard });
  }

  private animates(): boolean {
    return this.parts !== null && typeof this.parts.panel.animate === 'function' && !this.env.reduced();
  }

  private springTiming(): KeyframeAnimationOptions {
    if (this.env.linearEasing) return { duration: this.spring.durationMs, easing: this.spring.easing };
    const m = this.env.motion(this.parts!.panel);
    return { duration: m.relaxed, easing: m.enter };
  }
}

/** A computed transform as a keyframe value; `none` (at rest) is the panel in place. */
function cssTransform(value: string): string {
  return value === '' || value === 'none' ? 'translateY(0)' : value;
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  return el !== null && typeof el === 'object' && ((typeof el.tagName === 'string' && EDITABLE.has(el.tagName)) || el.isContentEditable === true);
}

interface Ghost {
  root: HTMLElement;
  panel: HTMLElement | null;
  scrim: HTMLElement | null;
}

/** An inert copy of the sheet as it looks now: typed field values kept, no ids, no dialog for screen readers. */
export function ghostOf(backdrop: HTMLElement): Ghost {
  const root = backdrop.cloneNode(true) as HTMLElement;
  root.classList.add(GHOST_CLASS);
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('inert', '');
  for (const el of root.querySelectorAll('[id]')) el.removeAttribute('id');
  for (const el of root.querySelectorAll('[role="dialog"]')) {
    el.removeAttribute('role');
    el.removeAttribute('aria-modal');
    el.removeAttribute('aria-labelledby');
  }
  // cloneNode copies attributes, not what was typed or picked since
  const fields = 'input, textarea, select';
  const live = backdrop.querySelectorAll<HTMLInputElement>(fields);
  const copies = root.querySelectorAll<HTMLInputElement>(fields);
  live.forEach((field, i) => {
    const copy = copies[i];
    if (copy === undefined || field.type === 'file') return;
    copy.value = field.value;
    copy.checked = field.checked;
  });
  return { root, panel: root.querySelector<HTMLElement>(':scope > .sheet'), scrim: root.querySelector<HTMLElement>(':scope > .sheet-scrim') };
}

/** Scrolls the copy's boxes where the live ones are (cloneNode starts every box at its top). */
export function copyScroll(live: HTMLElement, copy: HTMLElement): void {
  const from = [live, ...live.querySelectorAll<HTMLElement>('*')];
  const to = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
  from.forEach((el, i) => {
    const target = to[i];
    if (target === undefined) return;
    if (el.scrollTop !== 0) target.scrollTop = el.scrollTop;
    if (el.scrollLeft !== 0) target.scrollLeft = el.scrollLeft;
  });
}
