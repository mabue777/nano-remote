import { describe, expect, it } from 'vitest';

import { drop, flipPlan, measure, play, withLeaving, type Box, type FlipElement, type Shown } from './flip';

const box = (top: number, left = 0): Box => ({ top, left });

describe('flipPlan', () => {
  it('finds moved, entered and left rows', () => {
    const before = new Map([
      ['a', box(0)],
      ['b', box(50)],
      ['c', box(100)],
    ]);
    const after = new Map([
      ['n', box(0)],
      ['a', box(50)],
      ['b', box(50.2)], // moved less than half a pixel: not animated
      ['d', box(150)],
    ]);
    const plan = flipPlan(before, after);
    expect(plan.moved).toEqual([{ key: 'a', dx: 0, dy: -50 }]);
    expect(plan.entered).toEqual(['n', 'd']);
    expect(plan.left).toEqual(['c']);
  });

  it('counts sideways moves too', () => {
    const plan = flipPlan(new Map([['a', box(0, 10)]]), new Map([['a', box(0, 0)]]));
    expect(plan.moved).toEqual([{ key: 'a', dx: 10, dy: 0 }]);
  });
});

describe('withLeaving and drop', () => {
  const keyOf = (s: string) => s;
  const shown = (...items: string[]): Shown<string>[] => items.map((item) => ({ item, leaving: false }));

  it('keeps a removed row at its old place, flagged', () => {
    const result = withLeaving(shown('a', 'b', 'c', 'd'), ['a', 'c', 'd'], keyOf);
    expect(result).toEqual([
      { item: 'a', leaving: false },
      { item: 'b', leaving: true },
      { item: 'c', leaving: false },
      { item: 'd', leaving: false },
    ]);
  });

  it('puts a removed first row first, keeps rows already leaving, and handles reorders', () => {
    const previous: Shown<string>[] = [
      { item: 'x', leaving: false },
      { item: 'old', leaving: true },
      { item: 'a', leaving: false },
      { item: 'b', leaving: false },
    ];
    const result = withLeaving(previous, ['n', 'b', 'a'], keyOf);
    expect(result).toEqual([
      { item: 'x', leaving: true },
      { item: 'old', leaving: true },
      { item: 'n', leaving: false },
      { item: 'b', leaving: false },
      { item: 'a', leaving: false },
    ]);
    expect(drop(result, 'old', keyOf).map((r) => r.item)).toEqual(['x', 'n', 'b', 'a']);
    expect(drop(result, 'b', keyOf)).toHaveLength(5); // only leaving rows are dropped
  });
});

class FakeElement implements FlipElement {
  animations: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  constructor(
    public dataset: { flipKey?: string },
    public rect: Box,
  ) {}
  getBoundingClientRect(): Box {
    return this.rect;
  }
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): unknown {
    this.animations.push({ keyframes, options });
    return {};
  }
}

const container = (elements: FakeElement[]) => ({ querySelectorAll: () => elements });

describe('measure and play', () => {
  it('measures keyed elements and skips unkeyed ones', () => {
    const boxes = measure(container([new FakeElement({ flipKey: 'a' }, box(5, 1)), new FakeElement({}, box(9))]));
    expect([...boxes]).toEqual([['a', { top: 5, left: 1 }]]);
  });

  it('animates moved rows from their old place and fades new rows in', () => {
    const a = new FakeElement({ flipKey: 'a' }, box(60));
    const n = new FakeElement({ flipKey: 'n' }, box(0));
    const still = new FakeElement({ flipKey: 's' }, box(200));
    const unkeyed = new FakeElement({}, box(300));
    const timing = { duration: 300, easing: 'ease' };
    const plan = play(
      container([n, a, still, unkeyed]),
      new Map([
        ['a', box(0)],
        ['s', box(200)],
      ]),
      timing,
    );
    expect(plan.moved).toEqual([{ key: 'a', dx: 0, dy: -60 }]);
    expect(a.animations[0]!.keyframes).toEqual([{ transform: 'translate(0px, -60px)' }, { transform: 'translate(0, 0)' }]);
    expect(a.animations[0]!.options).toEqual({ duration: 300, easing: 'ease', fill: 'backwards' });
    expect(n.animations[0]!.keyframes[0]).toEqual({ opacity: 0, transform: 'scale(0.96)' });
    expect(still.animations).toEqual([]);
  });

  it('does not fade in rows on the first measurement or when told not to', () => {
    const n = new FakeElement({ flipKey: 'n' }, box(0));
    play(container([n]), new Map(), { duration: 1, easing: 'linear' });
    expect(n.animations).toEqual([]);
    play(container([n]), new Map([['x', box(0)]]), { duration: 1, easing: 'linear' }, false);
    expect(n.animations).toEqual([]);
  });
});
