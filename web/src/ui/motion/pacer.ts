// Streaming text, paced. The network delivers an answer in bursts (nothing for 300 ms, then 40 characters);
// shown as it arrives, the text jumps. The pacer holds what arrived and reveals it a few characters per
// animation frame, fast enough that the backlog clears within `catchUpMs`, so the text flows at the
// stream's own average speed and never lags far behind it. FreshSegments then splits the revealed text into
// a settled prefix and a handful of recent pieces, each of which fades in once. TextReveal puts the two
// together for a text that is given whole each time (the Replica's message text, which grows delta by
// delta): it paces what was appended, and shows a text that was rewritten (a snapshot, a replay that
// differs) at once, so nothing is lost or shown twice. Built in the lab (/lab, technique 4), used by the
// session and local chat views.

export interface PacerOptions {
  /** The backlog clears within about this long (ms). Lower follows the network more closely. */
  catchUpMs?: number;
  /** The slowest reveal speed while there is a backlog, in characters per second. */
  minCharsPerSecond?: number;
}

export class StreamPacer {
  private target = '';
  private shownCount = 0;
  private readonly catchUpMs: number;
  private readonly minCharsPerSecond: number;

  constructor(options: PacerOptions = {}) {
    this.catchUpMs = options.catchUpMs ?? 180;
    this.minCharsPerSecond = options.minCharsPerSecond ?? 90;
  }

  /** A chunk arrived from the stream. */
  push(chunk: string): void {
    this.target += chunk;
  }

  /** Characters received but not shown yet. */
  get backlog(): number {
    return this.target.length - this.shownCount;
  }

  /** The text to show now. */
  get text(): string {
    return this.target.slice(0, this.shownCount);
  }

  /** Advances by one frame that lasted `dtMs`; returns how many characters it revealed. */
  tick(dtMs: number): number {
    const backlog = this.backlog;
    if (backlog === 0) return 0;
    const dt = Math.max(0, Math.min(dtMs, 100)); // a frame after a stall or a hidden tab counts as 100 ms
    const byBacklog = Math.ceil((backlog * dt) / this.catchUpMs);
    const byFloor = Math.ceil((this.minCharsPerSecond * dt) / 1000);
    const step = Math.min(backlog, Math.max(1, byBacklog, byFloor));
    this.shownCount += step;
    return step;
  }

  /** Shows everything received (reduced motion, or the user leaves). */
  flush(): void {
    this.shownCount = this.target.length;
  }

  reset(): void {
    this.target = '';
    this.shownCount = 0;
  }
}

export interface Segment {
  /** Offset of the piece in the full text; a stable key, so a piece fades in once. */
  start: number;
  text: string;
  /** When the piece appeared (ms). */
  at: number;
}

/**
 * The revealed text as a settled prefix plus the recent pieces still fading in. A piece settles once it is
 * older than the fade (`lifeMs`); text that arrives within `joinMs` of the last piece joins it, so a fast
 * stream keeps only a handful of pieces (spans) on screen.
 */
export class FreshSegments {
  settled = '';
  fresh: Segment[] = [];

  constructor(
    private readonly lifeMs = 320,
    private readonly joinMs = 50,
  ) {}

  /** The full revealed text at time `now`; what is new since the last call becomes or joins a fresh piece. */
  update(text: string, now: number): void {
    this.prune(now);
    const known = this.settled.length + this.fresh.reduce((n, s) => n + s.text.length, 0);
    if (text.length < known) {
      // the stream restarted: start over
      this.settled = '';
      this.fresh = [];
      this.update(text, now);
      return;
    }
    if (text.length === known) return;
    const added = text.slice(known);
    const last = this.fresh[this.fresh.length - 1];
    if (last !== undefined && now - last.at < this.joinMs) last.text += added;
    else this.fresh.push({ start: known, text: added, at: now });
  }

  /** Shows `text` as settled at once, without a fade. */
  settle(text: string): void {
    this.settled = text;
    this.fresh = [];
  }

  /** Pieces whose fade is over join the settled text. Returns true when something settled. */
  prune(now: number): boolean {
    let changed = false;
    while (this.fresh.length > 0 && now - this.fresh[0]!.at >= this.lifeMs) {
      this.settled += this.fresh.shift()!.text;
      changed = true;
    }
    return changed;
  }
}

export interface RevealView {
  settled: string;
  fresh: Segment[];
}

/**
 * A text given whole on every change, revealed at the stream's pace. `set(text)` with a longer text that
 * starts with the known one paces the rest; any other text (shorter, or rewritten) is shown at once. With
 * `instant` (reduced motion) everything shows at once. `frame(dt, now)` advances one animation frame.
 */
export class TextReveal {
  private readonly pacer: StreamPacer;
  private readonly segments: FreshSegments;
  private known: string;

  constructor(
    initial = '',
    private readonly instant = false,
    options: PacerOptions & { lifeMs?: number; joinMs?: number } = {},
  ) {
    this.pacer = new StreamPacer(options);
    this.segments = new FreshSegments(options.lifeMs, options.joinMs);
    this.known = initial;
    this.pacer.push(initial);
    this.pacer.flush();
    this.segments.settle(initial);
  }

  /** The source text now. Returns whether frames are needed to reveal it. */
  set(text: string, now: number): boolean {
    if (text === this.known) return this.active;
    if (text.startsWith(this.known)) {
      this.pacer.push(text.slice(this.known.length));
      this.known = text;
      if (this.instant) this.showAll();
      else this.segments.update(this.pacer.text, now);
      return this.active;
    }
    this.known = text;
    this.pacer.reset();
    this.pacer.push(text);
    this.showAll();
    return false;
  }

  /** Advances by one frame that lasted `dtMs`, at time `now`. Returns whether more frames are needed. */
  frame(dtMs: number, now: number): boolean {
    this.pacer.tick(dtMs);
    this.segments.update(this.pacer.text, now);
    return this.active;
  }

  /** Shows everything known at once (reduced motion turned on, or the view leaves). */
  showAll(): void {
    this.pacer.flush();
    this.segments.settle(this.pacer.text);
  }

  /** Text received but not revealed, or pieces still fading in. */
  get active(): boolean {
    return this.pacer.backlog > 0 || this.segments.fresh.length > 0;
  }

  /** The revealed text. */
  get text(): string {
    return this.pacer.text;
  }

  get view(): RevealView {
    return { settled: this.segments.settled, fresh: [...this.segments.fresh] };
  }
}

export type RequestFrame = (callback: (time: number) => void) => number;
export type CancelFrame = (handle: number) => void;

/**
 * Runs `onFrame(dtMs)` on every animation frame while `active()` holds, and stops by itself when it does not.
 * `start()` again resumes it; calling it while running does nothing.
 */
export class FrameLoop {
  private handle: number | undefined;
  private last: number | undefined;

  constructor(
    private readonly onFrame: (dtMs: number) => void,
    private readonly active: () => boolean,
    private readonly raf: RequestFrame,
    private readonly caf: CancelFrame,
  ) {}

  get running(): boolean {
    return this.handle !== undefined;
  }

  start(): void {
    if (this.handle !== undefined) return;
    this.last = undefined;
    this.handle = this.raf(this.step);
  }

  stop(): void {
    if (this.handle !== undefined) this.caf(this.handle);
    this.handle = undefined;
  }

  private readonly step = (time: number): void => {
    const dt = this.last === undefined ? 16.7 : time - this.last;
    this.last = time;
    this.onFrame(dt);
    this.handle = this.active() ? this.raf(this.step) : undefined;
  };
}
