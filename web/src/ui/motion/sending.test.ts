import { describe, expect, it, vi } from 'vitest';

import { RISE_KEYFRAMES, riseEntered, type RiseElement } from './sending';

function row(key: string | undefined, classes: string[]) {
  return {
    dataset: key === undefined ? {} : { flipKey: key },
    style: { transformOrigin: '' },
    matches: (selector: string) => selector.split(',').some((s) => classes.includes(s.trim().replace(/^\./, ''))),
    animate: vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => undefined),
  } satisfies RiseElement;
}

const timing = { duration: 200, easing: 'ease' };

describe('riseEntered', () => {
  it('lets only the new rows that match rise, from below, anchored at the bottom right', () => {
    const old = row('t1/user', ['user']);
    const sent = row('t2/user', ['user']);
    const thinking = row('t2/thinking', ['thinking']);
    const keyless = row(undefined, ['user']);
    const container = { querySelectorAll: () => [old, sent, thinking, keyless] };
    expect(riseEntered(container, ['t2/user', 't2/thinking'], '.user', timing)).toBe(1);
    expect(sent.animate).toHaveBeenCalledWith(RISE_KEYFRAMES, { ...timing, fill: 'backwards' });
    expect(sent.style.transformOrigin).toBe('100% 100%');
    expect(old.animate).not.toHaveBeenCalled();
    expect(thinking.animate).not.toHaveBeenCalled();
    expect(keyless.animate).not.toHaveBeenCalled();
  });

  it('does nothing when no row entered', () => {
    const querySelectorAll = vi.fn(() => []);
    expect(riseEntered({ querySelectorAll }, [], '.user', timing)).toBe(0);
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it('animates only transform and opacity', () => {
    const props = new Set(RISE_KEYFRAMES.flatMap((frame) => Object.keys(frame)));
    expect([...props].sort()).toEqual(['opacity', 'transform']);
  });
});
