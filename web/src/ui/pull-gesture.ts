// The pull-down gesture's rules, without the DOM: a pull starts only while the list is at its top, follows
// the finger at half speed up to 1.5 x the threshold, and fires on release once past the threshold.

/** How far (px) the indicator must be pulled down before letting go fires. */
export const PULL_THRESHOLD = 70;
/** The indicator stops growing here. */
export const PULL_MAX = PULL_THRESHOLD * 1.5;
/** The indicator moves this fraction of the finger's travel. */
const RESISTANCE = 0.5;

export class PullGesture {
  private start: number | undefined;
  /** The indicator's height (px); 0 when no pull is under way. */
  distance = 0;

  /** A touch went down at `y`; it can become a pull only if the list is at its top. */
  begin(y: number | undefined, atTop: boolean): void {
    this.start = atTop ? y : undefined;
  }

  /** The finger moved to `y`. Returns false when this touch is not a pull (the distance did not change). */
  move(y: number | undefined): boolean {
    if (this.start === undefined) return false;
    const dy = (y ?? this.start) - this.start;
    this.distance = dy > 0 ? Math.min(dy * RESISTANCE, PULL_MAX) : 0;
    return true;
  }

  /** The finger lifted. Returns true when the pull went past the threshold; the gesture resets. */
  end(): boolean {
    const fire = this.start !== undefined && this.distance >= PULL_THRESHOLD;
    this.start = undefined;
    this.distance = 0;
    return fire;
  }
}
