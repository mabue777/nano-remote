import { describe, expect, it } from 'vitest';

import { blockPinchZoom, ZOOM_GESTURES } from './no-zoom';

describe('blockPinchZoom', () => {
  it("cancels Safari's gesturestart, gesturechange and gestureend with non-passive listeners", () => {
    const target = new EventTarget();
    const options: unknown[] = [];
    const add = target.addEventListener.bind(target);
    blockPinchZoom({
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null, opts?: AddEventListenerOptions | boolean) => {
        options.push(opts);
        add(type, listener, opts);
      },
    });
    expect(options).toEqual([{ passive: false }, { passive: false }, { passive: false }]);
    for (const type of ZOOM_GESTURES) {
      const event = new Event(type, { cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(true);
    }
  });

  it('leaves touch events alone, so one-finger scrolling and drags are never cancelled or delayed', () => {
    const types: string[] = [];
    blockPinchZoom({ addEventListener: (type: string) => void types.push(type) });
    expect(types).toEqual(['gesturestart', 'gesturechange', 'gestureend']);

    const target = new EventTarget();
    blockPinchZoom(target);
    for (const type of ['touchstart', 'touchmove', 'pointermove', 'scroll']) {
      const event = new Event(type, { cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(false);
    }
  });
});
