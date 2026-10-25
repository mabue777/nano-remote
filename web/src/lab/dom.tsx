// DOM glue shared by the lab's screens: a cross-fading label, and the shell that animates a box's height with
// transform only. The motion tokens (motionOf), the drag listener (useDrag) and scrolledAbove moved to
// src/ui/motion, the FLIP hook to screens/session/motion-hooks.tsx; they are re-exported here. Covered by the
// Playwright lab smoke; the rules they apply live in tested .ts modules.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { prefersReducedMotion } from '../ui/motion/motion';

export { motionOf, type Motion } from '../ui/motion/motion';
export { scrolledAbove } from '../ui/motion/motion';
export { useDrag, type DragHandlers } from '../ui/motion/drag';

export function reducedMotion(): boolean {
  return prefersReducedMotion(window);
}

// FLIP for one container (rows `[data-flip-key]`, shelled boxes `[data-shell-key]`): the session view adopted
// it, so it lives in screens/session/motion-hooks.tsx now.
export { useFlip, type FlipRequest } from '../screens/session/motion-hooks';

/** The background layer of a shelled box (see `.lab-shelled` in lab.css). */
export function Shell() {
  return <span class="lab-shell" aria-hidden="true" />;
}

/** A label that cross-fades when `value` changes (smooth), or simply changes (now). */
export function CrossFade({ value, smooth, render }: { value: string; smooth: boolean; render: (value: string) => ComponentChildren }) {
  const [leaving, setLeaving] = useState<string[]>([]);
  const last = useRef(value);
  useLayoutEffect(() => {
    if (last.current === value) return;
    const old = last.current;
    last.current = value;
    if (smooth) setLeaving((list) => [...list.filter((v) => v !== value), old]);
  }, [value, smooth]);
  if (!smooth) return <>{render(value)}</>;
  return (
    <span class="lab-xfade">
      {leaving.map((v) => (
        <span key={`out-${v}`} class="lab-xfade-out" aria-hidden="true" onAnimationEnd={() => setLeaving((list) => list.filter((x) => x !== v))}>
          {render(v)}
        </span>
      ))}
      <span key={`in-${value}`} class={leaving.length > 0 ? 'lab-xfade-in' : undefined}>
        {render(value)}
      </span>
    </span>
  );
}
