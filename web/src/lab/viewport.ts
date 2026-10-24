// The iOS keyboard, the reduced-motion setting, motion values from CSS, and the iOS 18 haptic trick: small
// browser facts behind interfaces so they can be tested in Node.

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
}

export interface ViewportWindow {
  innerHeight: number;
  visualViewport?: VisualViewportLike | null;
}

export interface ViewportBox {
  /** The visible height above the keyboard (px). */
  height: number;
  /** How far iOS scrolled the page up to show the focused field (px). */
  offsetTop: number;
  /** The keyboard's height (px); 0 when it is closed. */
  keyboard: number;
}

/** The visible box now; without visualViewport, the window. */
export function viewportBox(win: ViewportWindow): ViewportBox {
  const vv = win.visualViewport;
  if (vv === undefined || vv === null) return { height: win.innerHeight, offsetTop: 0, keyboard: 0 };
  const keyboard = Math.max(0, Math.round(win.innerHeight - vv.height - vv.offsetTop));
  return { height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop), keyboard };
}

/** Calls `onChange` with the visible box whenever the keyboard or the page's offset changes. */
export function watchViewport(win: ViewportWindow, onChange: (box: ViewportBox) => void): () => void {
  const vv = win.visualViewport;
  const update = () => onChange(viewportBox(win));
  update();
  if (vv === undefined || vv === null) return () => undefined;
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}

export interface MediaWindow {
  matchMedia?: (query: string) => { matches: boolean };
}

export function prefersReducedMotion(win: MediaWindow): boolean {
  return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** "150ms" or "0.3s" as milliseconds; `fallback` for anything else. */
export function parseMs(value: string, fallback: number): number {
  const text = value.trim();
  const match = /^(-?[\d.]+)(ms|s)$/.exec(text);
  if (match === null) return fallback;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return fallback;
  return match[2] === 's' ? n * 1000 : n;
}

export interface HapticDocument {
  createElement(tag: 'label'): HTMLLabelElement;
  createElement(tag: 'input'): HTMLInputElement;
  body: { appendChild(node: Node): unknown; removeChild(node: Node): unknown };
}

/**
 * A light haptic tick on iPhone (iOS 18+): Safari plays the system tick when a `<input type="checkbox" switch>`
 * is toggled by a tap on its label. Must run inside the tap's handler. Elsewhere it does nothing visible.
 * Undocumented by Apple, so it can stop working in any release.
 */
export function hapticTick(doc: HapticDocument): void {
  const label = doc.createElement('label');
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none';
  label.appendChild(input);
  doc.body.appendChild(label);
  label.click();
  doc.body.removeChild(label);
}
