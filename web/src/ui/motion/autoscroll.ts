// Following a growing transcript. While the reader is at the bottom, each frame eases the scroll position
// toward the new bottom instead of snapping to it. The moment the reader touches the list or scrolls up,
// following stops and stays stopped until they come back to the bottom or tap "Jump to latest".

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Within this many px of the bottom counts as at the bottom (the real session view uses the same). */
export const BOTTOM_SLACK = 48;

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

export class Follower {
  following = true;
  private touching = false;
  private lastSet: number | undefined;

  /** Fraction of the remaining distance covered per frame (0.35: about 90% within 100 ms at 60 fps). */
  constructor(private readonly ease = 0.35) {}

  /** A finger or the wheel is on the list: the reader is in charge. */
  hold(): void {
    this.touching = true;
    this.following = false;
  }

  /** The finger lifted: follow again only if they left the list at the bottom. */
  release(m: ScrollMetrics): void {
    this.touching = false;
    this.following = distanceFromBottom(m) <= BOTTOM_SLACK;
  }

  /** A scroll event. One this class caused is ignored; the reader's own scroll decides whether to follow. */
  onScroll(m: ScrollMetrics): void {
    if (this.lastSet !== undefined && Math.abs(m.scrollTop - this.lastSet) <= 1) return;
    this.lastSet = undefined;
    if (this.touching) return;
    this.following = distanceFromBottom(m) <= BOTTOM_SLACK;
  }

  /** "Jump to latest": follow again from here. */
  jump(): void {
    this.following = true;
  }

  /** The scrollTop to set this frame, or undefined to leave it. */
  step(m: ScrollMetrics): number | undefined {
    if (!this.following || this.touching) return undefined;
    const target = m.scrollHeight - m.clientHeight;
    const remaining = target - m.scrollTop;
    if (remaining <= 0.5) return undefined;
    const next = Math.min(target, m.scrollTop + Math.max(1, remaining * this.ease));
    this.lastSet = next;
    return next;
  }
}
