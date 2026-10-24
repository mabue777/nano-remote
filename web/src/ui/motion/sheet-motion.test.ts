import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Motion } from './motion';
import { browserSheetEnv, copyScroll, ghostOf, GHOST_CLASS, SheetMotion, type SheetMotionEnv, type SheetParts } from './sheet-motion';
import { SHEET_SPRING, springEasing } from './spring';

const MOTION: Motion = { fast: 150, moderate: 200, relaxed: 300, standard: 'std', enter: 'enter', exit: 'exit' };

interface Played {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
}

/** Just enough of an element for the controller: inline style, animations, size, scroll, a query table. */
class FakeElement {
  style: Record<string, string> = { transform: '', opacity: '' };
  played: Played[] = [];
  offsetHeight = 600;
  scrollTop = 0;
  scrollLeft = 0;
  parentElement: FakeElement | null = null;
  tagName = 'DIV';
  isContentEditable = false;
  /** The computed transform and opacity the env reports. */
  computed = { transform: 'none', opacity: '1' };
  attributes = new Map<string, string>();
  classes = new Set<string>();
  queries: Record<string, FakeElement[]> = {};
  clone: FakeElement | null = null;
  removed = false;
  value = '';
  checked = false;
  type = 'text';
  focus?: () => void;

  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): Played {
    const played = { keyframes, options, cancel: vi.fn() };
    this.played.push(played);
    return played;
  }
  getAnimations(): Played[] {
    return this.played;
  }
  cloneNode(): FakeElement {
    return this.clone!;
  }
  get classList() {
    return { add: (name: string) => this.classes.add(name) };
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.queries[selector] ?? [];
  }
  querySelector(selector: string): FakeElement | null {
    return this.queries[selector]?.[0] ?? null;
  }
  remove(): void {
    this.removed = true;
  }
}

function setup(options: { reduced?: boolean; linear?: boolean; host?: boolean } = {}) {
  const backdrop = new FakeElement();
  const scrim = new FakeElement();
  const panel = new FakeElement();
  panel.parentElement = backdrop;
  scrim.parentElement = backdrop;
  const ghost = { root: new FakeElement(), panel: new FakeElement(), scrim: new FakeElement() };
  ghost.root.queries[':scope > .sheet'] = [ghost.panel];
  ghost.root.queries[':scope > .sheet-scrim'] = [ghost.scrim];
  backdrop.clone = ghost.root;
  const appended: unknown[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  let reduced = options.reduced ?? false;
  const env: SheetMotionEnv = {
    reduced: () => reduced,
    linearEasing: options.linear ?? true,
    motion: () => MOTION,
    styleOf: (el) => (el as unknown as FakeElement).computed,
    host: () => (options.host === false ? null : { appendChild: (node: Node) => appended.push(node) }),
    setTimeout: (run, ms) => timers.push({ run, ms }),
  };
  const onDismiss = vi.fn();
  const motion = new SheetMotion(onDismiss, env);
  const parts = { backdrop, scrim, panel } as unknown as SheetParts;
  return {
    backdrop,
    scrim,
    panel,
    ghost,
    appended,
    timers,
    onDismiss,
    motion,
    parts,
    setReduced: (on: boolean) => {
      reduced = on;
    },
  };
}

/** A drag from y = 100 down to `to` in `steps` moves, `ms` apart. */
function drag(motion: SheetMotion, target: unknown, to: number, steps = 5, ms = 16): void {
  expect(motion.start(50, 100, target as EventTarget, 0)).toBe(true);
  for (let i = 1; i <= steps; i++) motion.move(50, 100 + ((to - 100) * i) / steps, i * ms);
}

describe('SheetMotion: opening', () => {
  it('slides the panel up on the sheet spring while the dim layer fades in', () => {
    const { motion, parts, panel, scrim } = setup();
    motion.open(parts);
    const spring = springEasing(SHEET_SPRING);
    expect(panel.played).toHaveLength(1);
    expect(panel.played[0]!.keyframes).toEqual([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }]);
    expect(panel.played[0]!.options).toEqual({ duration: spring.durationMs, easing: spring.easing });
    expect(scrim.played[0]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(scrim.played[0]!.options).toEqual({ duration: 200, easing: 'std' });
  });

  it('falls back to the relaxed duration and the enter easing without linear()', () => {
    const { motion, parts, panel } = setup({ linear: false });
    motion.open(parts);
    expect(panel.played[0]!.options).toEqual({ duration: 300, easing: 'enter' });
  });

  it('animates nothing with reduced motion, or where the Web Animations API is missing', () => {
    const reduced = setup({ reduced: true });
    reduced.motion.open(reduced.parts);
    expect(reduced.panel.played).toHaveLength(0);
    expect(reduced.scrim.played).toHaveLength(0);

    const old = setup();
    (old.panel as unknown as { animate: unknown }).animate = undefined;
    old.motion.open(old.parts);
    expect(old.scrim.played).toHaveLength(0);
  });
});

describe('SheetMotion: closing', () => {
  it('slides an inert copy of the sheet out from where the panel is, fades its dim layer, then removes it', () => {
    const { motion, parts, panel, scrim, ghost, appended, timers, backdrop } = setup();
    motion.open(parts);
    panel.computed = { transform: 'matrix(1, 0, 0, 1, 0, 120)', opacity: '1' }; // mid-entrance
    scrim.computed = { transform: 'none', opacity: '0.6' };
    motion.close();
    expect(appended).toEqual([ghost.root]);
    expect(ghost.root.classes.has(GHOST_CLASS)).toBe(true);
    expect(ghost.panel.played[0]!.keyframes).toEqual([{ transform: 'matrix(1, 0, 0, 1, 0, 120)' }, { transform: 'translateY(100%)' }]);
    expect(ghost.panel.played[0]!.options).toEqual({ duration: 260, easing: 'exit', fill: 'forwards' });
    expect(ghost.scrim.played[0]!.keyframes).toEqual([{ opacity: 0.6 }, { opacity: 0 }]);
    expect(ghost.scrim.played[0]!.options).toEqual({ duration: 260, easing: 'std', fill: 'forwards' });
    expect(timers).toEqual([{ run: expect.any(Function), ms: 260 }]);
    expect(ghost.root.removed).toBe(false);
    timers[0]!.run();
    expect(ghost.root.removed).toBe(true);
    expect(backdrop.removed).toBe(false); // the live sheet is its owner's to remove

    motion.close(); // a second close has nothing left to move
    expect(appended).toHaveLength(1);
  });

  it('starts a sheet at rest from its place, and a missing opacity from 1', () => {
    const { motion, parts, scrim, ghost } = setup();
    motion.open(parts);
    scrim.computed = { transform: 'none', opacity: '' };
    motion.close();
    expect(ghost.panel.played[0]!.keyframes[0]).toEqual({ transform: 'translateY(0)' });
    expect(ghost.scrim.played[0]!.keyframes[0]).toEqual({ opacity: 1 });
  });

  it('copies nothing with reduced motion, without a page to put the copy in, or when it never opened', () => {
    const reduced = setup();
    reduced.motion.open(reduced.parts);
    reduced.setReduced(true);
    reduced.motion.close();
    expect(reduced.appended).toHaveLength(0);

    const headless = setup({ host: false });
    headless.motion.open(headless.parts);
    headless.motion.close();
    expect(headless.ghost.panel.played).toHaveLength(0);

    const never = setup();
    never.motion.close();
    expect(never.appended).toHaveLength(0);
  });

  it('carries a flick on at the finger speed, in a straight line', () => {
    const { motion, parts, panel, ghost, onDismiss } = setup();
    motion.open(parts);
    drag(motion, panel, 400, 5, 10); // 300 px in 50 ms: 6 px/ms; the drag locks after the first 60 px
    motion.end();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    panel.computed = { transform: 'matrix(1, 0, 0, 1, 0, 240)', opacity: '1' };
    motion.close();
    const options = ghost.panel.played[0]!.options;
    expect(options.easing).toBe('linear');
    expect(options.duration).toBe(140); // 360 px left at 6 px/ms is 60 ms, raised to the 140 ms floor
  });
});

describe('SheetMotion: the drag down', () => {
  it('follows the finger downwards and dims the backdrop with it', () => {
    const { motion, parts, panel, scrim } = setup();
    motion.open(parts);
    expect(motion.start(50, 100, panel as unknown as EventTarget, 0)).toBe(true);
    expect(motion.move(52, 104, 8)).toBe(false); // still a tap
    expect(motion.move(50, 120, 16)).toBe(true); // locked downwards; the drag starts here
    expect(panel.played[0]!.cancel).toHaveBeenCalled(); // the entrance stops under the finger
    expect(scrim.played[0]!.cancel).toHaveBeenCalled();
    expect(panel.style.transform).toBe('translateY(0px)');
    expect(motion.move(50, 270, 32)).toBe(true);
    expect(panel.style.transform).toBe('translateY(150px)');
    expect(scrim.style.opacity).toBe(String(1 - 150 / 600));
  });

  it('resists a pull above the resting place', () => {
    const { motion, parts, panel, scrim } = setup();
    motion.open(parts);
    motion.start(50, 100, panel as unknown as EventTarget, 0);
    motion.move(50, 120, 10);
    motion.move(50, 80, 20); // 40 px above where the drag began
    expect(panel.style.transform).toBe('translateY(-20px)'); // rubber band: 40 * 40 / (40 + 40)
    expect(scrim.style.opacity).toBe('1');
  });

  it('leaves sideways and upward moves to the content', () => {
    const { motion, parts, panel } = setup();
    motion.open(parts);
    motion.start(50, 100, panel as unknown as EventTarget, 0);
    expect(motion.move(90, 105, 10)).toBe(false);
    expect(motion.move(50, 300, 20)).toBe(false); // the touch is the content's now
    motion.end();
    expect(panel.style.transform).toBe('');

    motion.start(50, 100, panel as unknown as EventTarget, 0);
    expect(motion.move(50, 60, 10)).toBe(false);
  });

  it('ignores a touch on a field, in scrolled content, before opening, or while a dismiss is pending', () => {
    const { motion, parts, panel, onDismiss, timers } = setup();
    expect(motion.start(0, 0, panel as unknown as EventTarget, 0)).toBe(false); // not open yet
    expect(motion.move(0, 50, 0)).toBe(false);
    motion.open(parts);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const field = new FakeElement();
      field.tagName = tagName;
      field.parentElement = panel;
      expect(motion.start(0, 0, field as unknown as EventTarget, 0)).toBe(false);
    }
    const editable = new FakeElement();
    editable.isContentEditable = true;
    expect(motion.start(0, 0, editable as unknown as EventTarget, 0)).toBe(false);
    const list = new FakeElement();
    list.parentElement = panel;
    list.scrollTop = 30;
    expect(motion.start(0, 0, list as unknown as EventTarget, 0)).toBe(false);
    panel.scrollTop = 10;
    expect(motion.start(0, 0, panel as unknown as EventTarget, 0)).toBe(false);
    panel.scrollTop = 0;

    drag(motion, panel, 500);
    motion.end();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(motion.start(0, 0, panel as unknown as EventTarget, 0)).toBe(false); // dismissing
    timers.find((t) => t.ms === 0)!.run();
    expect(motion.start(0, 0, panel as unknown as EventTarget, 0)).toBe(true);
  });

  it('springs back from a short, slow pull', () => {
    const { motion, parts, panel, scrim, onDismiss } = setup();
    motion.open(parts);
    drag(motion, panel, 220, 6, 50); // locks at 120, then 100 px (17%) over 250 ms
    motion.end();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe('');
    expect(scrim.style.opacity).toBe('');
    const back = panel.played.at(-1)!;
    expect(back.keyframes).toEqual([{ transform: 'translateY(100px)' }, { transform: 'translateY(0)' }]);
    expect(back.options.easing).toMatch(/^linear\(/);
    expect(scrim.played.at(-1)!.keyframes).toEqual([{ opacity: 1 - 100 / 600 }, { opacity: 1 }]);
  });

  it('dismisses a pull past 30%, and gets back in place when the owner keeps the sheet open', () => {
    const { motion, parts, panel, onDismiss, timers } = setup();
    motion.open(parts);
    drag(motion, panel, 340, 12, 60); // locks at 120, then 220 px (37%), slowly
    motion.end();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(panel.style.transform).toBe('translateY(220px)'); // stays where the finger left it
    const check = timers.find((t) => t.ms === 0)!;
    check.run(); // still open: e.g. the sheet is busy
    expect(panel.style.transform).toBe('');
    expect(panel.played.at(-1)!.keyframes[0]).toEqual({ transform: 'translateY(220px)' });
  });

  it('does not spring back once the owner removed the sheet', () => {
    const { motion, parts, panel, timers } = setup();
    motion.open(parts);
    drag(motion, panel, 500);
    motion.end();
    motion.close();
    const count = panel.played.length;
    timers.find((t) => t.ms === 0)!.run();
    expect(panel.played).toHaveLength(count);
  });

  it('with reduced motion still follows the finger, and settles without animating', () => {
    const { motion, parts, panel, onDismiss, timers } = setup({ reduced: true });
    motion.open(parts);
    drag(motion, panel, 220, 6, 50);
    expect(panel.style.transform).toBe('translateY(100px)');
    motion.end();
    expect(panel.style.transform).toBe('');
    expect(panel.played).toHaveLength(0);
    drag(motion, panel, 600);
    motion.end();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    timers.find((t) => t.ms === 0)!.run();
    expect(panel.played).toHaveLength(0);
  });

  it('a lift without a drag changes nothing', () => {
    const { motion, parts, panel } = setup();
    motion.end(); // not open
    motion.open(parts);
    motion.start(0, 100, panel as unknown as EventTarget, 0);
    motion.end();
    expect(panel.played).toHaveLength(1); // only the entrance
  });
});

describe('ghostOf and copyScroll', () => {
  it('copies the sheet without ids or the dialog role, hidden, inert, with what was typed', () => {
    const backdrop = new FakeElement();
    const root = new FakeElement();
    backdrop.clone = root;
    const heading = new FakeElement();
    heading.attributes.set('id', 'title');
    const section = new FakeElement();
    for (const [k, v] of [['role', 'dialog'], ['aria-modal', 'true'], ['aria-labelledby', 'title']]) section.attributes.set(k!, v!);
    root.queries['[id]'] = [heading];
    root.queries['[role="dialog"]'] = [section];
    const typed = Object.assign(new FakeElement(), { value: 'Fix the parser' });
    const ticked = Object.assign(new FakeElement(), { type: 'checkbox', checked: true });
    const file = Object.assign(new FakeElement(), { type: 'file', value: 'C:\\fakepath\\a.png' });
    backdrop.queries['input, textarea, select'] = [typed, ticked, file, new FakeElement()];
    const copies = [new FakeElement(), new FakeElement(), new FakeElement()];
    root.queries['input, textarea, select'] = copies;
    root.queries[':scope > .sheet'] = [section];

    const ghost = ghostOf(backdrop as unknown as HTMLElement);
    expect(ghost.root).toBe(root);
    expect(ghost.panel).toBe(section);
    expect(ghost.scrim).toBeNull();
    expect(root.classes.has(GHOST_CLASS)).toBe(true);
    expect(root.attributes.get('aria-hidden')).toBe('true');
    expect(root.attributes.has('inert')).toBe(true);
    expect(heading.attributes.has('id')).toBe(false);
    expect([...section.attributes.keys()]).toEqual([]);
    expect(copies[0]!.value).toBe('Fix the parser');
    expect(copies[1]!.checked).toBe(true);
    expect(copies[2]!.value).toBe(''); // a file input cannot take a value
  });

  it('scrolls the copy where the sheet was scrolled', () => {
    const live = new FakeElement();
    const copy = new FakeElement();
    const liveList = Object.assign(new FakeElement(), { scrollTop: 240 });
    const liveCode = Object.assign(new FakeElement(), { scrollLeft: 30 });
    live.scrollTop = 5;
    live.queries['*'] = [liveList, liveCode, new FakeElement()];
    const copies = [new FakeElement(), new FakeElement()];
    copy.queries['*'] = copies;
    copyScroll(live as unknown as HTMLElement, copy as unknown as HTMLElement);
    expect(copy.scrollTop).toBe(5);
    expect(copies[0]!.scrollTop).toBe(240);
    expect(copies[1]!.scrollLeft).toBe(30);
    expect(copies[1]!.scrollTop).toBe(0);
  });
});

describe('browserSheetEnv', () => {
  const saved = { window: globalThis.window, CSS: globalThis.CSS, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  afterEach(() => {
    Object.assign(globalThis, saved);
  });

  it('is inert in Node, without a window, CSS or a document', () => {
    const env = browserSheetEnv();
    expect(env.reduced()).toBe(false);
    expect(env.linearEasing).toBe(false);
    expect(env.host()).toBeNull();
  });

  it('reads the browser: the media query, linear() support, the body, computed styles and timers', () => {
    const body = {};
    const setTimer = vi.fn();
    Object.assign(globalThis, {
      window: { matchMedia: () => ({ matches: true }), setTimeout: setTimer },
      CSS: { supports: (property: string, value: string) => property === 'transition-timing-function' && value === 'linear(0, 1)' },
      document: { body },
      getComputedStyle: () => ({ transform: 'none', opacity: '1', getPropertyValue: () => '' }),
    });
    const env = browserSheetEnv();
    expect(env.reduced()).toBe(true);
    expect(env.linearEasing).toBe(true);
    expect(env.host()).toBe(body);
    expect(env.styleOf({} as Element).transform).toBe('none');
    expect(env.motion({} as Element).moderate).toBe(200);
    const run = () => undefined;
    env.setTimeout(run, 5);
    expect(setTimer).toHaveBeenCalledWith(run, 5);
  });
});
