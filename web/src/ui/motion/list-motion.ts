// List changes (docs/research/interaction-feel-prototype.md, technique 8) for a list fed by a model: which
// rows to render, including the ones that just left (still at their old place while they fade out), and
// whether this render changed the rows, so the caller measures them before the change reaches the page
// (FLIP, flip.ts). Used through useListMotion (use-flip.ts) by Home's session list and the chat list.
import { drop, withLeaving, type Shown } from './flip';

export interface ListStep<T> {
  shown: Shown<T>[];
  /** The rows (which, or their order) differ from the last call: measure before rendering them. */
  changed: boolean;
}

export class ListMotion<T> {
  private shown: Shown<T>[] = [];
  private keys: string | null = null;

  constructor(private readonly keyOf: (item: T) => string) {}

  /**
   * The rows to render for `items`. With `animate`, a row that left stays (flagged `leaving`) until
   * `drop`; without it (Reduce Motion), it goes at once. The first call changes nothing (no entrance on
   * the first paint). Same rows: each takes its fresh data, leaving rows keep their last.
   */
  next(items: readonly T[], animate: boolean): ListStep<T> {
    const keys = items.map(this.keyOf).join('\u0000');
    if (keys === this.keys) {
      const fresh = new Map(items.map((item) => [this.keyOf(item), item]));
      this.shown = this.shown.map((entry) => (entry.leaving ? entry : { item: fresh.get(this.keyOf(entry.item))!, leaving: false }));
      return { shown: this.shown, changed: false };
    }
    const first = this.keys === null;
    this.keys = keys;
    this.shown = animate && !first ? withLeaving(this.shown, items, this.keyOf) : items.map((item) => ({ item, leaving: false }));
    return { shown: this.shown, changed: !first };
  }

  /** Whether `key` is a row that is fading out. */
  leaving(key: string): boolean {
    return this.shown.some((entry) => entry.leaving && this.keyOf(entry.item) === key);
  }

  /** A leaving row finished fading out: it goes. Returns whether it was there. */
  drop(key: string): boolean {
    const before = this.shown.length;
    this.shown = drop(this.shown, key, this.keyOf);
    return this.shown.length !== before;
  }
}
