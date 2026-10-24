// The iOS keyboard (the visible viewport): a small browser fact behind an interface so it can be tested in
// Node. The reduced-motion setting, CSS time parsing and the haptic tick moved to src/ui/motion.

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
