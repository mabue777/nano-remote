import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../../test/hook-host';
import { LONG_PRESS_MS, usePress } from './hooks';

vi.mock('preact/hooks', async () => {
  const { hooks } = await import('../../../test/hook-host');
  return { ...hooks, useLayoutEffect: hooks.useEffect };
});

function pointer(timeStamp: number, clientX = 100, clientY = 20, button = 0): PointerEvent {
  return { timeStamp, clientX, clientY, button } as PointerEvent;
}

function press() {
  const onLongPress = vi.fn();
  const onSwipeLeft = vi.fn();
  const host = renderHook(() => usePress({ onLongPress, onSwipeLeft }));
  return { handlers: host.value, onLongPress, onSwipeLeft, host };
}

describe('usePress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a hold fires the long-press when its timer runs, and the click after it is consumed', () => {
    const { handlers, onLongPress } = press();
    handlers.onPointerDown(pointer(0));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    handlers.onPointerUp(pointer(LONG_PRESS_MS + 100));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(handlers.consumed()).toBe(true);
    expect(handlers.consumed()).toBe(false);
  });

  it('a release after the full hold counts when the timer is late (busy main thread), and only once', () => {
    const { handlers, onLongPress } = press();
    handlers.onPointerDown(pointer(1000));
    handlers.onPointerUp(pointer(1000 + LONG_PRESS_MS + 150)); // the timer task has not run yet
    expect(onLongPress).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(handlers.consumed()).toBe(true);
  });

  it('a tap is not a long-press', () => {
    const { handlers, onLongPress } = press();
    handlers.onPointerDown(pointer(0));
    handlers.onPointerUp(pointer(LONG_PRESS_MS - 1));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(handlers.consumed()).toBe(false);
  });

  it('a hold that moved past the slop is not a long-press, even when released late', () => {
    const { handlers, onLongPress } = press();
    handlers.onPointerDown(pointer(0));
    handlers.onPointerMove(pointer(100, 100, 40));
    handlers.onPointerUp(pointer(LONG_PRESS_MS + 100, 100, 40));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('a cancelled pointer is not a long-press', () => {
    const { handlers, onLongPress } = press();
    handlers.onPointerDown(pointer(0));
    handlers.onPointerCancel();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('a swipe left fires the swipe, not the long-press', () => {
    const { handlers, onLongPress, onSwipeLeft } = press();
    handlers.onPointerDown(pointer(0, 300));
    handlers.onPointerMove(pointer(50, 240));
    handlers.onPointerUp(pointer(LONG_PRESS_MS + 100, 240));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(handlers.consumed()).toBe(true);
  });

  it('ignores a secondary button; the context menu is a long-press', () => {
    const { handlers, onLongPress } = press();
    handlers.onPointerDown(pointer(0, 100, 20, 2));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
    const preventDefault = vi.fn();
    handlers.onContextMenu({ preventDefault } as unknown as MouseEvent);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('unmounting drops a pending hold', () => {
    const { handlers, onLongPress, host } = press();
    handlers.onPointerDown(pointer(0));
    host.unmount();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
