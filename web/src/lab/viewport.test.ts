import { describe, expect, it, vi } from 'vitest';

import { hapticTick, parseMs, prefersReducedMotion, viewportBox, watchViewport, type HapticDocument, type VisualViewportLike } from './viewport';

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

describe('prefersReducedMotion and parseMs', () => {
  it('reads the media query, false without matchMedia', () => {
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
  });

  it('parses ms and s, and falls back on anything else', () => {
    expect(parseMs('150ms', 1)).toBe(150);
    expect(parseMs(' 0.3s ', 1)).toBe(300);
    expect(parseMs('', 7)).toBe(7);
    expect(parseMs('fast', 7)).toBe(7);
    expect(parseMs('1.2.3ms', 7)).toBe(7);
  });
});

describe('hapticTick', () => {
  it('clicks the label of a hidden switch input and removes it again', () => {
    const calls: string[] = [];
    const input = { type: '', setAttribute: (n: string) => calls.push(`input ${n}`) };
    const label = {
      style: { cssText: '' },
      setAttribute: (n: string, v: string) => calls.push(`label ${n}=${v}`),
      appendChild: () => calls.push('append input'),
      click: () => calls.push('click'),
    };
    const doc = {
      createElement: (tag: string) => (tag === 'label' ? label : input),
      body: { appendChild: () => calls.push('attach'), removeChild: () => calls.push('detach') },
    } as unknown as HapticDocument;
    hapticTick(doc);
    expect(input.type).toBe('checkbox');
    expect(calls).toEqual(['input switch', 'label aria-hidden=true', 'append input', 'attach', 'click', 'detach']);
    expect(label.style.cssText).toContain('opacity:0');
  });
});
