import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../test/hook-host';
import { Model } from './model';
import { useModel } from './use-model';

// The hook host runs effects right after each render, the way a layout effect runs before paint.
vi.mock('preact/hooks', async () => {
  const { hooks } = await import('../../test/hook-host');
  return { ...hooks, useLayoutEffect: hooks.useEffect };
});

class Counter extends Model {
  value = 0;
  bump(): void {
    this.value += 1;
    this.changed();
  }
}

describe('useModel', () => {
  it('re-renders on every change after mount', () => {
    const model = new Counter();
    const seen: number[] = [];
    renderHook(() => seen.push(useModel(model).value));
    model.bump();
    model.bump();
    expect(seen).toEqual([0, 1, 2]);
  });

  it('catches up on a change made between render and subscription (the race)', () => {
    const model = new Counter();
    const seen: number[] = [];
    let first = true;
    renderHook(() => {
      seen.push(useModel(model).value);
      // A stream event or keystroke lands after the render read the model but before the effect subscribed.
      if (first) {
        first = false;
        model.bump();
      }
    });
    expect(seen).toEqual([0, 1]);
    model.bump();
    expect(seen).toEqual([0, 1, 2]);
  });

  it('does not render again on mount when nothing changed', () => {
    const model = new Counter();
    const seen: number[] = [];
    renderHook(() => seen.push(useModel(model).value));
    expect(seen).toEqual([0]);
  });

  it('stops listening on unmount', () => {
    const model = new Counter();
    const seen: number[] = [];
    const host = renderHook(() => seen.push(useModel(model).value));
    host.unmount();
    model.bump();
    expect(seen).toEqual([0]);
  });
});
