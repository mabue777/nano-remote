// Sending (docs/research/interaction-feel-prototype.md, technique 6): the message you sent appears at once,
// rising out of the composer, while the older rows glide up through FLIP (ui/motion/flip.ts). Built in the lab
// (its .lab-enter keyframes), shared by the session view, local chat and the lab. Only transform and opacity
// animate; with Reduce Motion the screens skip the FLIP and nothing rises.

/** From 12 px lower and a hair smaller to its place, anchored at its bottom right corner (the composer's side). */
export const RISE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: 'translateY(12px) scale(0.98)' },
  { opacity: 1, transform: 'none' },
];

export interface RiseElement {
  dataset: { flipKey?: string };
  style: { transformOrigin: string };
  matches(selector: string): boolean;
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): unknown;
}

export interface RiseContainer {
  querySelectorAll(selector: string): ArrayLike<RiseElement>;
}

/**
 * The rows that `entered` (FLIP's new keys) and match `selector` rise in. Returns how many did, so a caller
 * (and the tests) can tell.
 */
export function riseEntered(container: RiseContainer, entered: readonly string[], selector: string, timing: { duration: number; easing: string }): number {
  if (entered.length === 0) return 0;
  const keys = new Set(entered);
  const rows = container.querySelectorAll('[data-flip-key]');
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const key = row.dataset.flipKey;
    if (key === undefined || !keys.has(key) || !row.matches(selector)) continue;
    row.style.transformOrigin = '100% 100%';
    row.animate(RISE_KEYFRAMES, { ...timing, fill: 'backwards' });
    count += 1;
  }
  return count;
}
