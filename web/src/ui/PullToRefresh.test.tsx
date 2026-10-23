import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../test/hook-host';
import { childNodes, text, type Node } from '../../test/vnode';
import { PULL_MAX, PULL_THRESHOLD, PullGesture } from './pull-gesture';
import { PullIndicator, usePullToRefresh } from './PullToRefresh';

vi.mock('preact/hooks', async () => (await import('../../test/hook-host')).hooks);

function touch(clientY?: number): TouchEvent {
  return { touches: clientY === undefined ? [] : [{ clientY }] } as unknown as TouchEvent;
}

describe('PullGesture', () => {
  it('follows the finger at half speed and fires past the threshold', () => {
    const pull = new PullGesture();
    pull.begin(100, true);
    expect(pull.move(160)).toBe(true);
    expect(pull.distance).toBe(30);
    pull.move(100 + 2 * PULL_THRESHOLD);
    expect(pull.distance).toBe(PULL_THRESHOLD);
    expect(pull.end()).toBe(true);
    expect(pull.distance).toBe(0);
  });

  it('does not fire short of the threshold', () => {
    const pull = new PullGesture();
    pull.begin(0, true);
    pull.move(2 * PULL_THRESHOLD - 2);
    expect(pull.end()).toBe(false);
  });

  it('stops growing at 1.5 x the threshold', () => {
    const pull = new PullGesture();
    pull.begin(0, true);
    pull.move(1000);
    expect(pull.distance).toBe(PULL_MAX);
    expect(PULL_MAX).toBe(PULL_THRESHOLD * 1.5);
  });

  it('a touch that starts below the top of the list is no pull', () => {
    const pull = new PullGesture();
    pull.begin(0, false);
    expect(pull.move(500)).toBe(false);
    expect(pull.distance).toBe(0);
    expect(pull.end()).toBe(false);
  });

  it('moving up shows nothing; a move without a touch point counts as no movement', () => {
    const pull = new PullGesture();
    pull.begin(300, true);
    pull.move(200);
    expect(pull.distance).toBe(0);
    pull.move(400);
    expect(pull.distance).toBe(50);
    pull.move(undefined);
    expect(pull.distance).toBe(0);
  });

  it('a touch without a touch point is no pull', () => {
    const pull = new PullGesture();
    pull.begin(undefined, true);
    expect(pull.move(500)).toBe(false);
  });

  it('ending twice fires once', () => {
    const pull = new PullGesture();
    pull.begin(0, true);
    pull.move(1000);
    expect(pull.end()).toBe(true);
    expect(pull.end()).toBe(false);
  });
});

describe('usePullToRefresh', () => {
  it('shows the pull while the finger moves and calls onPull on release past the threshold', () => {
    const onPull = vi.fn();
    const host = renderHook(() => usePullToRefresh(() => true, onPull));
    expect(host.value.distance).toBe(0);

    host.value.handlers.onTouchStart(touch(100));
    host.value.handlers.onTouchMove(touch(160));
    expect(host.value.distance).toBe(30);
    host.value.handlers.onTouchMove(touch(400));
    expect(host.value.distance).toBe(PULL_MAX);

    host.value.handlers.onTouchEnd();
    expect(onPull).toHaveBeenCalledTimes(1);
    expect(host.value.distance).toBe(0);
  });

  it('a short pull springs back without calling onPull', () => {
    const onPull = vi.fn();
    const host = renderHook(() => usePullToRefresh(() => true, onPull));
    host.value.handlers.onTouchStart(touch(0));
    host.value.handlers.onTouchMove(touch(60));
    expect(host.value.distance).toBe(30);
    host.value.handlers.onTouchEnd();
    expect(onPull).not.toHaveBeenCalled();
    expect(host.value.distance).toBe(0);
  });

  it('asks whether the list is at its top when the touch starts, and ignores the touch when not', () => {
    const atTop = vi.fn(() => false);
    const onPull = vi.fn();
    const host = renderHook(() => usePullToRefresh(atTop, onPull));
    host.value.handlers.onTouchStart(touch(0));
    expect(atTop).toHaveBeenCalledTimes(1);
    host.value.handlers.onTouchMove(touch(500));
    expect(host.value.distance).toBe(0);
    host.value.handlers.onTouchEnd();
    expect(onPull).not.toHaveBeenCalled();
  });

  it('keeps one gesture across renders', () => {
    const onPull = vi.fn();
    const host = renderHook(() => usePullToRefresh(() => true, onPull));
    host.value.handlers.onTouchStart(touch(0));
    host.render(); // e.g. the list re-rendered mid-gesture
    host.value.handlers.onTouchMove(touch(300));
    host.value.handlers.onTouchEnd();
    expect(onPull).toHaveBeenCalledTimes(1);
  });
});

describe('PullIndicator', () => {
  const labels = { pullLabel: 'Pull to refresh', releaseLabel: 'Release to refresh' };

  it('is an empty, hidden strip at rest', () => {
    const tree = PullIndicator({ distance: 0, ...labels }) as Node;
    expect(tree.props.class).toBe('pull');
    expect(tree.props.style).toEqual({ height: '0px' });
    expect(tree.props['aria-hidden']).toBe(true);
    expect(childNodes(tree)).toHaveLength(0);
  });

  it('grows with the pull and says what letting go does', () => {
    const pulling = PullIndicator({ distance: PULL_THRESHOLD - 1, ...labels }) as Node;
    expect(pulling.props.style).toEqual({ height: `${PULL_THRESHOLD - 1}px` });
    expect(pulling.props['aria-hidden']).toBe(false);
    expect(text(pulling.props.children)).toBe('Pull to refresh');

    const ready = PullIndicator({ distance: PULL_THRESHOLD, ...labels }) as Node;
    expect(text(ready.props.children)).toBe('Release to refresh');
  });
});
