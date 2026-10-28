// DOM glue shared by the lab's screens: the shell that animates a box's height with
// transform only. The motion tokens (motionOf), the drag listener (useDrag) and scrolledAbove moved to
// src/ui/motion, the FLIP hook to ui/motion/use-flip.ts, the cross-fade to ui/CrossFade.tsx; they are re-exported here. Covered by the
// Playwright lab smoke; the rules they apply live in tested .ts modules.
import { prefersReducedMotion } from '../ui/motion/motion';

export { motionOf, type Motion } from '../ui/motion/motion';
export { scrolledAbove } from '../ui/motion/motion';
export { useDrag, type DragHandlers } from '../ui/motion/drag';

export function reducedMotion(): boolean {
  return prefersReducedMotion(window);
}

// FLIP for one container (rows `[data-flip-key]`, shelled boxes `[data-shell-key]`): the session view adopted
// it, then Home's list, so it lives in ui/motion/use-flip.ts now.
export { useFlip, type FlipRequest } from '../ui/motion/use-flip';

/** The background layer of a shelled box (see `.lab-shelled` in lab.css). */
export function Shell() {
  return <span class="lab-shell" aria-hidden="true" />;
}

// The cross-fading label moved to ui/CrossFade.tsx when Home's rows adopted it (look step 6).
export { CrossFade } from '../ui/CrossFade';
