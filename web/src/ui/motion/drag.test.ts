import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../../test/hook-host';
import { useDrag, type DragHandlers } from './drag';

vi.mock('preact/hooks', async () => (await import('../../../test/hook-host')).hooks);

function touchEvent(type: string, points: { x: number; y: number }[], timeStamp = 0, cancelable = true): Event {
  const event = new Event(type, { cancelable });
  Object.defineProperty(event, 'touches', { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
}

function handlers(overrides: Partial<DragHandlers> = {}) {
  return {
    start: vi.fn<DragHandlers['start']>(() => true),
    move: vi.fn<DragHandlers['move']>(() => true),
    end: vi.fn<DragHandlers['end']>(),
    ...overrides,
  };
}

describe('useDrag', () => {
  it('passes a one-finger touch to the handlers and stops the page scrolling when the drag owns the move', () => {
    const el = new EventTarget();
    const h = handlers();
    renderHook(() => useDrag({ current: el }, true, h));

    el.dispatchEvent(touchEvent('touchstart', [{ x: 1, y: 2 }], 10));
    expect(h.start).toHaveBeenCalledWith(1, 2, el, 10);
    const move = touchEvent('touchmove', [{ x: 1, y: 30 }], 20);
    el.dispatchEvent(move);
    expect(h.move).toHaveBeenCalledWith(1, 30, 20);
    expect(move.defaultPrevented).toBe(true);
    el.dispatchEvent(touchEvent('touchend', []));
    expect(h.end).toHaveBeenCalledWith(false);
    el.dispatchEvent(touchEvent('touchend', []));
    expect(h.end).toHaveBeenCalledTimes(1); // only once per touch
  });

  it('lets the page scroll when the drag does not own the move, or the move cannot be cancelled', () => {
    const el = new EventTarget();
    let own = false;
    const h = handlers({ move: vi.fn(() => own) });
    renderHook(() => useDrag({ current: el }, true, h));
    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }]));
    const free = touchEvent('touchmove', [{ x: 0, y: 5 }]);
    el.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
    own = true;
    const fixed = touchEvent('touchmove', [{ x: 0, y: 6 }], 0, false);
    el.dispatchEvent(fixed);
    expect(fixed.defaultPrevented).toBe(false);
    el.dispatchEvent(touchEvent('touchmove', [])); // no touch point: ignored
    expect(h.move).toHaveBeenCalledTimes(2);
    el.dispatchEvent(touchEvent('touchcancel', []));
    expect(h.end).toHaveBeenCalledWith(true);
  });

  it('ignores a touch the start handler declines, and two-finger touches', () => {
    const el = new EventTarget();
    const h = handlers({ start: vi.fn(() => false) });
    renderHook(() => useDrag({ current: el }, true, h));
    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }]));
    el.dispatchEvent(touchEvent('touchmove', [{ x: 0, y: 50 }]));
    el.dispatchEvent(touchEvent('touchend', []));
    expect(h.move).not.toHaveBeenCalled();
    expect(h.end).not.toHaveBeenCalled();

    const pinch = handlers();
    renderHook(() => useDrag({ current: el }, true, pinch));
    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }, { x: 9, y: 9 }]));
    expect(pinch.start).not.toHaveBeenCalled();
    el.dispatchEvent(touchEvent('touchmove', [{ x: 0, y: 50 }]));
    expect(pinch.move).not.toHaveBeenCalled();
  });

  it('cancels a drag when a second finger lands', () => {
    const el = new EventTarget();
    const h = handlers();
    renderHook(() => useDrag({ current: el }, true, h));
    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }]));
    el.dispatchEvent(touchEvent('touchmove', [{ x: 30, y: 0 }]));
    el.dispatchEvent(touchEvent('touchstart', [{ x: 30, y: 0 }, { x: 90, y: 90 }]));
    expect(h.end).toHaveBeenCalledWith(true);
    el.dispatchEvent(touchEvent('touchmove', [{ x: 60, y: 0 }]));
    el.dispatchEvent(touchEvent('touchend', []));
    expect(h.move).toHaveBeenCalledTimes(1);
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it('listens only while enabled and an element is there, and stops listening on unmount', () => {
    const el = new EventTarget();
    const off = handlers();
    renderHook(() => useDrag({ current: el }, false, off));
    renderHook(() => useDrag({ current: null }, true, off));
    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }]));
    expect(off.start).not.toHaveBeenCalled();

    const h = handlers();
    const host = renderHook(() => useDrag({ current: el }, true, h));
    host.unmount();
    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }]));
    expect(h.start).not.toHaveBeenCalled();
  });

  it('calls the latest handlers after a re-render', () => {
    const el = new EventTarget();
    let h = handlers();
    const host = renderHook(() => useDrag({ current: el }, true, h));
    const first = h;
    h = handlers();
    host.render();
    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }]));
    expect(first.start).not.toHaveBeenCalled();
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});
