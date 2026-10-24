// /lab: loads the lab in its own chunk, so the real app's bundle carries none of it (not even its styles).
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function LabRoute() {
  const [Lab, setLab] = useState<ComponentType | null>(null);
  useEffect(() => {
    void import('./Lab').then((module) => setLab(() => module.Lab));
  }, []);
  return Lab === null ? <main class="screen muted">Loading the lab…</main> : <Lab />;
}
