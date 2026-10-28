// A label that cross-fades when its value changes (docs/research/interaction-feel-prototype.md, technique 8:
// "Status words cross-fade"): the old one fades out in the same place while the new one fades in. Built in
// the lab, shared by Home's session rows and the lab. With `smooth` false (Reduce Motion) it simply changes.
// Styles: .xfade* in styles/components.css (opacity only).
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface CrossFadeProps {
  value: string;
  smooth: boolean;
  render: (value: string) => ComponentChildren;
}

export function CrossFade({ value, smooth, render }: CrossFadeProps) {
  const [leaving, setLeaving] = useState<string[]>([]);
  const last = useRef(value);
  useLayoutEffect(() => {
    if (last.current === value) return;
    const old = last.current;
    last.current = value;
    if (smooth) setLeaving((list) => [...list.filter((v) => v !== value), old]);
  }, [value, smooth]);
  if (!smooth) return <>{render(value)}</>;
  return (
    <span class="xfade">
      {leaving.map((v) => (
        <span key={`out-${v}`} class="xfade-out" aria-hidden="true" onAnimationEnd={() => setLeaving((list) => list.filter((x) => x !== v))}>
          {render(v)}
        </span>
      ))}
      <span key={`in-${value}`} class={leaving.length > 0 ? 'xfade-in' : undefined}>
        {render(value)}
      </span>
    </span>
  );
}
