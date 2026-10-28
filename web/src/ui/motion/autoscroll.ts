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

/** One frame at 60 fps, the rate the easing is tuned for. */
const FRAME_MS = 1000 / 60;

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

export class Follower {
  following = true;
  private touching = false;
  /** The last scroll we wrote ourselves, so we can tell a genuine reader scroll from one the layout caused. */
  private lastScroll: ScrollMetrics | undefined;
  /** The list's height when last seen, to tell a shrinking list from a scroll up. */
  private lastHeight: number | undefined;
  /** Nesting counter for app layout changes; scroll events during these are treated as app-caused. */
  private layoutChangeDepth = 0;

  /** Fraction of the remaining distance covered per 60 fps frame (0.35: about 90% within 100 ms). A longer
   *  frame covers what the 60 fps frames in it would have, so a slow device does not trail further behind. */
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

  /** Tells the follower an app layout change (FLIP, collapse) is about to happen. */
  startLayoutChange(): void {
    this.layoutChangeDepth++;
  }

  /** Tells the follower the app layout change finished. */
  endLayoutChange(): void {
    this.layoutChangeDepth = Math.max(0, this.layoutChangeDepth - 1);
  }

  /** A scroll event. One this class caused is ignored; the reader's own scroll decides whether to follow.
   *  A scroll caused by the app's own layout change is also ignored: either the helper told us one is in
   *  progress, or the new scrollTop is the last programmatic one shifted by the content-height delta. */
  onScroll(m: ScrollMetrics): void {
    const shrank = this.lastHeight !== undefined && m.scrollHeight < this.lastHeight - 0.5;
    this.lastHeight = m.scrollHeight;
    // While the app is explicitly changing the layout, scrolls are its own while we are following.
    if (this.layoutChangeDepth > 0 && this.following && !this.touching) {
      if (this.lastScroll !== undefined) {
        this.lastScroll = { ...m };
      }
      return;
    }
    if (this.lastScroll !== undefined && !this.touching) {
      const expected = this.lastScroll.scrollTop + (m.scrollHeight - this.lastScroll.scrollHeight);
      if (Math.abs(m.scrollTop - expected) <= 1 || Math.abs(m.scrollTop - this.lastScroll.scrollTop) <= 1) {
        // The layout moved the scroll position for us; keep the reference point up to date.
        this.lastScroll = { ...m };
        return;
      }
    }
    this.lastScroll = undefined;
    if (this.touching) return;
    // The list got shorter (a finished turn folded) and the browser pulled the view up with it: that is not
    // the reader scrolling away, so keep following.
    if (shrank && this.following) return;
    this.following = distanceFromBottom(m) <= BOTTOM_SLACK;
  }

  /** "Jump to latest": follow again from here. */
  jump(): void {
    this.following = true;
  }

  /** The caller scrolled to the metrics in `m` itself (a send pins to the bottom): its scroll event is not the reader's. */
  scrolledTo(m: ScrollMetrics): void {
    this.lastScroll = { ...m };
    this.lastHeight = m.scrollHeight;
  }

  /** The scrollTop to set this frame (`dtMs` since the last one), or undefined to leave it. */
  step(m: ScrollMetrics, dtMs = FRAME_MS): number | undefined {
    this.lastHeight = m.scrollHeight;
    if (!this.following || this.touching) return undefined;
    const target = m.scrollHeight - m.clientHeight;
    const remaining = target - m.scrollTop;
    if (remaining <= 0.5) return undefined;
    const share = 1 - (1 - this.ease) ** (Math.max(0, dtMs) / FRAME_MS);
    const next = Math.min(target, m.scrollTop + Math.max(1, remaining * share));
    this.lastScroll = { scrollTop: next, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight };
    return next;
  }
}
