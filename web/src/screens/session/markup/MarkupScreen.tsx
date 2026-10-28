// The markup cover (docs/plan/image-markup.md, ticket 2): a full-screen layer over the app with the picture
// fitted to the screen, Cancel at the top left, undo, redo and clear in the middle, Done at the top right, and
// the tools and colours at the bottom. One finger draws with the chosen tool, two fingers pan and pinch (up to
// 8x); a double tap fits the picture again (gestures.ts). Marks live in ticket 1's model (marks.ts) in image
// pixels and are drawn by its burn-in (burn.ts), so what is on screen is what gets exported.
//
// The cover is not part of the page stack, so the left-edge back swipe never starts under it. It rises like the
// app's sheets (the sheet spring) and is not dragged down: a downward stroke must draw. With Reduce Motion it
// cross-fades. Loaded lazily: the owner imports this module on first use. Styles: markup.css.
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { Icon } from '../../../ui/Icon';
import { motionOf, prefersReducedMotion } from '../../../ui/motion/motion';
import { SHEET_SPRING, springEasing } from '../../../ui/motion/spring';
import { burnIn } from './burn';
import { clampView, fitView, GestureTracker, lerpView, pinchView, sameView, toImage, zoomAt, type Size, type View } from './gestures';
import { MARKUP_COLORS, markId, MarkupState, type Mark, type MarkupColor, type Point } from './marks';
import './markup.css';

export type MarkupTool = 'pen' | 'highlighter' | 'rectangle' | 'arrow';

export interface MarkupScreenProps {
  /** The picture to mark up (an object URL or an asset URL); its own pixels are the marks' coordinates. */
  src: string;
  /** What the picture is, for VoiceOver ("Screenshot"). */
  label?: string;
  /** Done: the cover has left the screen; `marks` are in image pixels. */
  onDone: (marks: readonly Mark[], size: Size) => void;
  /** Cancel (or Escape): the cover has left the screen; nothing changed. */
  onCancel: () => void;
}

const TOOLS: { id: MarkupTool; label: string }[] = [
  { id: 'pen', label: 'Pen' },
  { id: 'highlighter', label: 'Highlighter' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'arrow', label: 'Arrow' },
];

const COLORS: { id: MarkupColor; label: string }[] = [
  { id: 'red', label: 'Red' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
];

/** Red for the pen and shapes, yellow for the highlighter; a colour picked for a tool stays with it. */
const DEFAULT_COLORS: Record<MarkupTool, MarkupColor> = { pen: 'red', highlighter: 'yellow', rectangle: 'red', arrow: 'red' };

/** The Reduce Motion cross-fade (ms). The duration tokens drop to 1 ms under Reduce Motion, so not a token. */
const FADE_MS = 200;
/** How long a double tap takes to fit the picture again (ms). */
const FIT_MS = 260;

// Lucide line icons (ISC licence, see ui/Icon.tsx) the main bundle does not need.
const GLYPHS: Record<MarkupTool | 'undo' | 'redo', JSX.Element> = {
  pen: <path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />,
  highlighter: (
    <>
      <path d="m9 11-6 6v3h9l3-3" />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </>
  ),
  rectangle: <rect width="18" height="14" x="3" y="5" rx="1.5" />,
  arrow: (
    <>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
};

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg class="icon" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}

const LINEAR_EASING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)');

export function MarkupScreen({ src, label = 'Picture', onDone, onCancel }: MarkupScreenProps) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [model] = useState(() => new MarkupState());
  const [, setVersion] = useState(0);
  const [tool, setTool] = useState<MarkupTool>('pen');
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const color = colors[tool];
  // The canvas's working state lives in one mutable object: pointer moves must not re-render Preact.
  const paint = useRef<Painter | null>(null);
  paint.current ??= new Painter(model);
  const painter = paint.current;
  painter.tool = tool;
  painter.color = color;

  const changed = () => {
    setVersion((n) => n + 1);
    painter.schedule();
  };
  painter.onCommit = changed;

  // Rise like a sheet; cross-fade with Reduce Motion. Focus moves into the cover for VoiceOver.
  useLayoutEffect(() => {
    const el = root.current!;
    const before = document.activeElement as HTMLElement | null;
    el.focus({ preventScroll: true });
    if (typeof el.animate === 'function') {
      if (prefersReducedMotion()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
      else if (LINEAR_EASING) {
        const spring = springEasing(SHEET_SPRING);
        el.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: spring.durationMs, easing: spring.easing });
      } else {
        const m = motionOf(el);
        el.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: m.relaxed, easing: m.enter });
      }
    }
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  // The picture, the canvas at device pixel ratio, the pointer and wheel listeners.
  useEffect(() => {
    const el = canvas.current!;
    const box = stage.current!;
    let alive = true;
    const image = new Image();
    image.onload = () =>
      void image
        .decode()
        .catch(() => undefined)
        .then(() => {
          if (!alive) return;
          painter.setImage(image);
          setReady(true);
        });
    image.src = src;
    painter.attach(el);
    const resize = () => painter.resize(box.clientWidth, box.clientHeight, window.devicePixelRatio || 1);
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(box);
    const detach = painter.listen(el);
    return () => {
      alive = false;
      observer?.disconnect();
      detach();
      painter.stop();
    };
  }, [src, painter]);

  const leave = (done: boolean) => {
    if (closing) return;
    setClosing(true);
    painter.stop();
    const finish = () => (done ? onDone(model.marks, painter.imageSize()) : onCancel());
    const el = root.current;
    if (el === null || typeof el.animate !== 'function') return finish();
    const reduced = prefersReducedMotion();
    const m = motionOf(el);
    const a = reduced
      ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-in', fill: 'forwards' })
      : el.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }], { duration: m.relaxed, easing: m.exit, fill: 'forwards' });
    a.onfinish = finish;
  };

  const undo = () => {
    model.undo();
    changed();
  };
  const redo = () => {
    model.redo();
    changed();
  };
  const clear = () => {
    model.clear();
    changed();
  };

  // Escape cancels; Cmd/Ctrl+Z undoes, with Shift redoes (hardware keyboards).
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    if (event.key === 'Escape') leave(false);
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const count = model.marks.length;
  return (
    <div ref={root} class={`markup${closing ? ' markup-closing' : ''}`} role="dialog" aria-modal="true" aria-label="Mark up" tabIndex={-1}>
      <header class="markup-bar">
        <button type="button" class="ghost markup-cancel" onClick={() => leave(false)}>
          Cancel
        </button>
        <div class="markup-history">
          <button type="button" class="markup-icon" aria-label="Undo" disabled={!model.canUndo} onClick={undo}>
            <Glyph name="undo" />
          </button>
          <button type="button" class="markup-icon" aria-label="Redo" disabled={!model.canRedo} onClick={redo}>
            <Glyph name="redo" />
          </button>
          <button type="button" class="markup-icon" aria-label="Clear all marks" disabled={count === 0} onClick={clear}>
            <Icon name="trash" size={22} />
          </button>
        </div>
        <button type="button" class="primary small markup-done" onClick={() => leave(true)}>
          Done
        </button>
      </header>
      <div ref={stage} class="markup-stage">
        <canvas ref={canvas} class="markup-canvas" role="img" aria-label={`${label}, ${count === 0 ? 'no marks' : count === 1 ? '1 mark' : `${count} marks`}`} data-ready={ready ? 'true' : undefined} />
      </div>
      <footer class="markup-tools">
        <div class="markup-group" role="group" aria-label="Tool">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" class="markup-icon markup-tool" aria-label={t.label} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>
              <Glyph name={t.id} />
            </button>
          ))}
        </div>
        <div class="markup-group" role="group" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              class="markup-swatch"
              aria-label={c.label}
              aria-pressed={color === c.id}
              style={{ '--swatch': MARKUP_COLORS[c.id] }}
              onClick={() => setColors({ ...colors, [tool]: c.id })}
            />
          ))}
        </div>
      </footer>
    </div>
  );
}

/** The canvas: the view, the stroke being drawn, and drawing at device pixel ratio, once per frame at most.
 * Image and committed marks are kept on a second canvas while a stroke is drawn, so each frame copies that
 * and draws only the new stroke, however many marks there are. */
class Painter {
  tool: MarkupTool = 'pen';
  color: MarkupColor = 'red';
  onCommit: () => void = () => undefined;
  private canvas: HTMLCanvasElement | null = null;
  private base: HTMLCanvasElement | null = null;
  /** What the cached layer shows: the marks list (a new array after every change) and the view. */
  private baseMarks: readonly Mark[] | null = null;
  private baseView = '';
  private image: HTMLImageElement | null = null;
  private box: Size = { width: 0, height: 0 };
  private dpr = 1;
  private view: View = { scale: 1, x: 0, y: 0 };
  /** The view follows the box (fitted) until the user zooms or pans. */
  private fitted = true;
  private live: Mark | null = null;
  private pinchFrom: View = this.view;
  private frame = 0;
  private fitAnimation = 0;
  private readonly gestures: GestureTracker;

  constructor(private readonly model: MarkupState) {
    this.gestures = new GestureTracker({
      strokeStart: (from) => this.strokeStart(from),
      strokeMove: (to) => this.strokeMove(to),
      strokeEnd: () => this.strokeEnd(),
      strokeCancel: () => {
        this.live = null;
        this.schedule();
      },
      pinchStart: () => {
        this.stopFit();
        this.pinchFrom = this.view;
        this.fitted = false;
      },
      pinch: (a0, b0, a1, b1) => this.setView(pinchView(this.pinchFrom, a0, b0, a1, b1, this.imageSize(), this.box)),
      pinchEnd: () => undefined,
      tap: () => undefined,
      doubleTap: () => this.fit(true),
    });
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  setImage(image: HTMLImageElement): void {
    this.image = image;
    this.fit(false);
  }

  imageSize(): Size {
    return { width: this.image?.naturalWidth || 1, height: this.image?.naturalHeight || 1 };
  }

  resize(width: number, height: number, dpr: number): void {
    const canvas = this.canvas;
    if (canvas === null || width === 0 || height === 0) return;
    this.box = { width, height };
    this.dpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (this.fitted) this.view = fitView(this.imageSize(), this.box);
    else this.view = clampView(this.view, this.imageSize(), this.box);
    this.draw();
  }

  /** Pointer and wheel listeners on the canvas; returns their removal. */
  listen(el: HTMLCanvasElement): () => void {
    let rect = el.getBoundingClientRect();
    const at = (event: PointerEvent): Point => ({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    const down = (event: PointerEvent) => {
      if (event.button > 0 || this.image === null) return;
      event.preventDefault();
      rect = el.getBoundingClientRect();
      try {
        el.setPointerCapture(event.pointerId); // moves outside the canvas still reach it
      } catch {
        // a pointer the browser no longer knows (already lifted): nothing to capture
      }
      this.gestures.down(event.pointerId, at(event));
    };
    const move = (event: PointerEvent) => {
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      for (const e of events.length > 0 ? events : [event]) this.gestures.move(event.pointerId, at(e));
    };
    const up = (event: PointerEvent) => this.gestures.up(event.pointerId, at(event), event.timeStamp);
    const cancel = (event: PointerEvent) => this.gestures.cancel(event.pointerId);
    // A trackpad pinch (ctrlKey) or a wheel zooms; a two-finger scroll pans.
    const wheel = (event: WheelEvent) => {
      if (this.image === null) return;
      event.preventDefault();
      rect = el.getBoundingClientRect();
      this.stopFit();
      this.fitted = false;
      const size = this.imageSize();
      if (event.ctrlKey || event.deltaMode !== 0) this.setView(zoomAt(this.view, { x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * 0.01), size, this.box));
      else this.setView(clampView({ ...this.view, x: this.view.x - event.deltaX, y: this.view.y - event.deltaY }, size, this.box));
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('wheel', wheel);
    };
  }

  schedule(): void {
    if (this.frame === 0 && typeof requestAnimationFrame === 'function') this.frame = requestAnimationFrame(() => this.draw());
  }

  stop(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.stopFit();
  }

  private setView(view: View): void {
    this.view = view;
    this.schedule();
  }

  /** Fits the picture to the screen; animated for a double tap unless Reduce Motion is on. */
  private fit(animated: boolean): void {
    this.stopFit();
    this.fitted = true;
    const to = fitView(this.imageSize(), this.box);
    const from = this.view;
    if (!animated || prefersReducedMotion() || sameView(from, to)) {
      this.setView(to);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FIT_MS);
      this.setView(lerpView(from, to, 1 - (1 - t) ** 3));
      this.fitAnimation = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.fitAnimation = requestAnimationFrame(step);
  }

  private stopFit(): void {
    if (this.fitAnimation !== 0) cancelAnimationFrame(this.fitAnimation);
    this.fitAnimation = 0;
  }

  private strokeStart(from: Point): void {
    this.stopFit();
    const p = toImage(this.view, from);
    const id = markId();
    const tool = this.tool;
    this.live = tool === 'pen' || tool === 'highlighter' ? { kind: tool, id, color: this.color, points: [p] } : { kind: tool, id, color: this.color, from: p, to: p };
  }

  private strokeMove(to: Point): void {
    const live = this.live;
    if (live === null || live.kind === 'pin') return;
    const p = toImage(this.view, to);
    if ('points' in live) {
      const last = live.points[live.points.length - 1]!;
      // Skip points closer than half a screen pixel to the last one.
      if (Math.hypot(p.x - last.x, p.y - last.y) * this.view.scale < 0.5) return;
      live.points.push(p);
    } else if ('to' in live) live.to = p;
    this.schedule();
  }

  private strokeEnd(): void {
    const live = this.live;
    this.live = null;
    if (live !== null) this.model.add(live);
    this.onCommit();
  }

  /** Paints into `ctx`: the picture and `marks` through the view, at device pixels. */
  private paint(ctx: CanvasRenderingContext2D, marks: readonly Mark[], withImage: boolean): void {
    const { scale, x, y } = this.view;
    const d = this.dpr;
    const size = this.imageSize();
    ctx.setTransform(d * scale, 0, 0, d * scale, d * x, d * y);
    if (withImage && this.image !== null) ctx.drawImage(this.image, 0, 0, size.width, size.height);
    burnIn(ctx, marks, size.width, size.height);
  }

  private draw(): void {
    this.frame = 0;
    const canvas = this.canvas;
    const ctx = canvas?.getContext('2d');
    if (canvas == null || ctx == null || this.image === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.live === null) {
      this.paint(ctx, this.model.marks, true);
      return;
    }
    // Drawing a stroke: the picture and the committed marks come from the cached layer.
    const base = (this.base ??= document.createElement('canvas'));
    const view = `${canvas.width}x${canvas.height}|${this.view.scale}|${this.view.x}|${this.view.y}`;
    if (this.baseMarks !== this.model.marks || this.baseView !== view) {
      base.width = canvas.width;
      base.height = canvas.height;
      const b = base.getContext('2d')!;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, base.width, base.height);
      this.paint(b, this.model.marks, true);
      this.baseMarks = this.model.marks;
      this.baseView = view;
    }
    ctx.drawImage(base, 0, 0);
    this.paint(ctx, [this.live], false);
  }
}
