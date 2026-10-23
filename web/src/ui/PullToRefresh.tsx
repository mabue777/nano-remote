// Pull down at the top of a list to refresh it (touch screens): Home refreshes its sessions, the session
// page loads older turns. The hook wires PullGesture (pull-gesture.ts) to touch events; PullIndicator is the
// strip that grows above the list and says what letting go will do. Styles: .pull in styles/components.css.
import { useRef, useState } from 'preact/hooks';

import { PULL_THRESHOLD, PullGesture } from './pull-gesture';

export interface PullToRefresh {
  /** The indicator's height (px). */
  distance: number;
  /** Spread onto the element that receives the touches. */
  handlers: {
    onTouchStart: (event: TouchEvent) => void;
    onTouchMove: (event: TouchEvent) => void;
    onTouchEnd: () => void;
  };
}

/** `atTop`: whether the list is scrolled to its top when a touch starts. `onPull`: letting go past the threshold. */
export function usePullToRefresh(atTop: () => boolean, onPull: () => void): PullToRefresh {
  const [distance, setDistance] = useState(0);
  const gesture = useRef<PullGesture | null>(null);
  gesture.current ??= new PullGesture();
  const pull = gesture.current;
  return {
    distance,
    handlers: {
      onTouchStart: (event) => pull.begin(event.touches[0]?.clientY, atTop()),
      onTouchMove: (event) => {
        if (pull.move(event.touches[0]?.clientY)) setDistance(pull.distance);
      },
      onTouchEnd: () => {
        if (pull.end()) onPull();
        setDistance(0);
      },
    },
  };
}

export interface PullIndicatorProps {
  distance: number;
  /** Shown while pulling, before the threshold, e.g. "Pull to refresh". */
  pullLabel: string;
  /** Shown past the threshold, e.g. "Release to refresh". */
  releaseLabel: string;
}

export function PullIndicator({ distance, pullLabel, releaseLabel }: PullIndicatorProps) {
  return (
    <div class="pull" style={{ height: `${distance}px` }} aria-hidden={distance === 0}>
      {distance > 0 && <span>{distance >= PULL_THRESHOLD ? releaseLabel : pullLabel}</span>}
    </div>
  );
}
