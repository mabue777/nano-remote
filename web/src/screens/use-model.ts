import { useEffect, useState } from 'preact/hooks';

/** Re-renders the component whenever the model (anything with `subscribe`) reports a change. */
export function useModel<T extends { subscribe(listener: () => void): () => void }>(model: T): T {
  const [, setTick] = useState(0);
  useEffect(() => model.subscribe(() => setTick((n) => n + 1)), [model]);
  return model;
}
