import { describe, expect, it, vi } from 'vitest';

import { viewportBox, watchViewport, type VisualViewportLike } from './viewport';

class FakeViewport implements VisualViewportLike {
  listeners = new Map<string, Set<() => void>>();
  constructor(
    public height: number,
    public offsetTop = 0,
  ) {}
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }
}

describe('viewportBox', () => {
  it('is the window without visualViewport', () => {
    expect(viewportBox({ innerHeight: 844 })).toEqual({ height: 844, offsetTop: 0, keyboard: 0 });
    expect(viewportBox({ innerHeight: 844, visualViewport: null })).toEqual({ height: 844, offsetTop: 0, keyboard: 0 });
  });

  it('measures the keyboard from the visible area and the scroll iOS added', () => {
    expect(viewportBox({ innerHeight: 844, visualViewport: new FakeViewport(508.4, 0) })).toEqual({ height: 508, offsetTop: 0, keyboard: 336 });
    expect(viewportBox({ innerHeight: 844, visualViewport: new FakeViewport(508, 120) })).toEqual({ height: 508, offsetTop: 120, keyboard: 216 });
    expect(viewportBox({ innerHeight: 844, visualViewport: new FakeViewport(900, 0) }).keyboard).toBe(0); // pinch-zoom out: no keyboard
  });
});

describe('watchViewport', () => {
  it('reports now and on every resize or scroll, until stopped', () => {
    const vv = new FakeViewport(844);
    const seen: number[] = [];
    const stop = watchViewport({ innerHeight: 844, visualViewport: vv }, (box) => seen.push(box.keyboard));
    vv.height = 500;
    vv.emit('resize');
    vv.offsetTop = 44;
    vv.emit('scroll');
    expect(seen).toEqual([0, 344, 300]);
    stop();
    vv.emit('resize');
    expect(seen).toHaveLength(3);
  });

  it('reports once without visualViewport', () => {
    const seen = vi.fn();
    const stop = watchViewport({ innerHeight: 700 }, seen);
    expect(seen).toHaveBeenCalledWith({ height: 700, offsetTop: 0, keyboard: 0 });
    stop();
  });
});
