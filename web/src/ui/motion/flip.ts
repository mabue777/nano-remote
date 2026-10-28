// FLIP for lists: First (measure every row), Last (let the change render, measure again), Invert (offset each
// row back to where it was), Play (animate the offset away). Only transform and opacity animate, so the
// browser moves layers instead of laying the page out on every frame. Rows carry `data-flip-key`.
// withLeaving keeps a removed row on screen at its old place while it fades out.

export interface Box {
  left: number;
  top: number;
}

export interface Delta {
  key: string;
  dx: number;
  dy: number;
}

export interface FlipPlan {
  moved: Delta[];
  entered: string[];
  left: string[];
}

/** What moved (and by how much), what is new and what is gone between two measurements. */
export function flipPlan(before: ReadonlyMap<string, Box>, after: ReadonlyMap<string, Box>, minPx = 0.5): FlipPlan {
  const moved: Delta[] = [];
  const entered: string[] = [];
  for (const [key, box] of after) {
    const old = before.get(key);
    if (old === undefined) {
      entered.push(key);
      continue;
    }
    const dx = old.left - box.left;
    const dy = old.top - box.top;
    if (Math.abs(dx) >= minPx || Math.abs(dy) >= minPx) moved.push({ key, dx, dy });
  }
  const left = [...before.keys()].filter((key) => !after.has(key));
  return { moved, entered, left };
}

export interface Shown<T> {
  item: T;
  leaving: boolean;
}

/**
 * The next list plus the rows that left it, each still at its old place (after the row it followed), flagged
 * `leaving` so it can fade out before it is dropped. Rows already leaving in `previous` stay until `drop`.
 */
export function withLeaving<T>(previous: readonly Shown<T>[], next: readonly T[], keyOf: (item: T) => string): Shown<T>[] {
  const nextKeys = new Set(next.map(keyOf));
  const result: Shown<T>[] = next.map((item) => ({ item, leaving: false }));
  let anchor = -1; // index in result after which a leaving row goes
  for (const entry of previous) {
    const key = keyOf(entry.item);
    if (nextKeys.has(key)) {
      anchor = result.findIndex((r) => !r.leaving && keyOf(r.item) === key);
      continue;
    }
    result.splice(anchor + 1, 0, { item: entry.item, leaving: true });
    anchor += 1;
  }
  return result;
}

/** The list without the leaving row `key`. */
export function drop<T>(shown: readonly Shown<T>[], key: string, keyOf: (item: T) => string): Shown<T>[] {
  return shown.filter((entry) => !(entry.leaving && keyOf(entry.item) === key));
}

// The DOM side, kept to the few calls it needs so tests can pass plain objects.

export interface FlipElement {
  dataset: { flipKey?: string; flipAnim?: string };
  getBoundingClientRect(): Box;
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): unknown;
}

export interface FlipContainer {
  querySelectorAll(selector: string): ArrayLike<FlipElement>;
}

export interface FlipTiming {
  duration: number;
  easing: string;
}

/** Positions of every `[data-flip-key]` element in the container. */
export function measure(container: FlipContainer): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const elements = container.querySelectorAll('[data-flip-key]');
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    const key = element.dataset.flipKey;
    if (key === undefined) continue;
    const rect = element.getBoundingClientRect();
    boxes.set(key, { left: rect.left, top: rect.top });
  }
  return boxes;
}

/**
 * Animates the container's rows from the positions in `before` to where they are now; new rows fade and
 * scale in unless `enter` is false (they have their own entrance). Returns the plan it played.
 */
export function play(container: FlipContainer, before: ReadonlyMap<string, Box>, timing: FlipTiming, enter = true): FlipPlan {
  const elements = new Map<string, FlipElement>();
  const list = container.querySelectorAll('[data-flip-key]');
  for (let i = 0; i < list.length; i++) {
    const key = list[i]!.dataset.flipKey;
    if (key !== undefined) elements.set(key, list[i]!);
  }
  const after = new Map<string, Box>();
  for (const [key, element] of elements) {
    const rect = element.getBoundingClientRect();
    after.set(key, { left: rect.left, top: rect.top });
  }
  const plan = flipPlan(before, after);
  for (const { key, dx, dy } of plan.moved) {
    elements.get(key)!.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { ...timing, fill: 'backwards' });
  }
  if (enter && before.size > 0) {
    for (const key of plan.entered) {
      elements.get(key)!.animate(
        [
          { opacity: 0, transform: 'scale(0.96)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { ...timing, fill: 'backwards' },
      );
    }
  }
  return plan;
}

/**
 * Marks what the last FLIP played: `data-flip-anim="move"` on rows that slid, `"enter"` on rows that faded
 * in; marks from an earlier change are cleared. The e2e smoke reads it (a list change ran through FLIP).
 */
export function markPlayed(container: FlipContainer, plan: FlipPlan): void {
  const moved = new Set(plan.moved.map((m) => m.key));
  const entered = new Set(plan.entered);
  const list = container.querySelectorAll('[data-flip-key]');
  for (let i = 0; i < list.length; i++) {
    const element = list[i]!;
    const key = element.dataset.flipKey!;
    if (moved.has(key)) element.dataset.flipAnim = 'move';
    else if (entered.has(key)) element.dataset.flipAnim = 'enter';
    else delete element.dataset.flipAnim;
  }
}
