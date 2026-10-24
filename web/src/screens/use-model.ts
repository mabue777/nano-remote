import { useLayoutEffect, useState } from 'preact/hooks';

/**
 * Re-renders the component whenever the model reports a change. It subscribes in a layout effect, before
 * the browser paints, and catches up on a change made between render and subscription: a stream event or
 * a first keystroke right after mount would otherwise change the model with nobody listening, and the
 * view would stay stale until the next change.
 */
export function useModel<T extends { version: number; subscribe(listener: () => void): () => void }>(model: T): T {
  const [, setTick] = useState(0);
  const rendered = model.version;
  useLayoutEffect(() => {
    const off = model.subscribe(() => setTick((n) => n + 1));
    if (model.version !== rendered) setTick((n) => n + 1);
    return off;
    // `rendered` is read once per subscription on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
  return model;
}
