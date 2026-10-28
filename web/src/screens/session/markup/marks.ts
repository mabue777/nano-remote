// Pure model for image markup: kinds, hit testing, bounding boxes, undo/redo, pin numbering and the
// comment-line composer. Coordinates are always in image pixels. The canvas layer (ticket 2) converts
// screen taps to image coordinates before calling these functions.

export type MarkupColor = 'red' | 'yellow' | 'blue' | 'green';

/** Fixed colours; the marked picture does not change with light or dark mode. */
export const MARKUP_COLORS: Record<MarkupColor, string> = {
  red: '#ff3b30',
  yellow: '#ffcc00',
  blue: '#007aff',
  green: '#34c759',
};

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A freehand pen or highlighter stroke. */
export interface StrokeMark {
  kind: 'pen' | 'highlighter';
  id: string;
  color: MarkupColor;
  points: Point[];
}

/** A rectangle or arrow shape. */
export interface ShapeMark {
  kind: 'rectangle' | 'arrow';
  id: string;
  color: MarkupColor;
  from: Point;
  to: Point;
}

/** A numbered comment pin. When placed on a mark it carries the mark's id so the comment line can use
 * the mark's bounding box ("around"); otherwise the line uses the pin's own point ("at"). */
export interface PinMark {
  kind: 'pin';
  id: string;
  x: number;
  y: number;
  comment: string;
  markId?: string;
}

export type Mark = StrokeMark | ShapeMark | PinMark;

/** Creates a fresh mark id. */
export function markId(): string {
  return `mark_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** The undoable editing state. Every mutating operation pushes a new snapshot; undo/redo move through the
 * snapshot stack without mutating history entries. */
export class MarkupState {
  private _marks: readonly Mark[] = [];
  private history: readonly (readonly Mark[])[] = [[]];
  private index = 0;

  get marks(): readonly Mark[] {
    return this._marks;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.history.length - 1;
  }

  private pushState(): void {
    this.history = [...this.history.slice(0, this.index + 1), this._marks];
    this.index++;
  }

  add(mark: Mark): void {
    this._marks = [...this._marks, mark];
    this.pushState();
  }

  update(id: string, fn: (mark: Mark) => Mark): void {
    this._marks = this._marks.map((m) => (m.id === id ? fn(m) : m));
    this.pushState();
  }

  remove(id: string): void {
    this._marks = this._marks.filter((m) => m.id !== id);
    this.pushState();
  }

  clear(): void {
    this._marks = [];
    this.pushState();
  }

  undo(): void {
    if (!this.canUndo) return;
    this.index--;
    this._marks = this.history[this.index]!;
  }

  redo(): void {
    if (!this.canRedo) return;
    this.index++;
    this._marks = this.history[this.index]!;
  }
}

/** All pins in creation order with one-based numbers assigned in that order. */
export function numberedPins(marks: readonly Mark[]): Array<PinMark & { number: number }> {
  let n = 0;
  return marks
    .filter((m): m is PinMark => m.kind === 'pin')
    .map((p) => ({ ...p, number: ++n }));
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * abx, y: a.y + t * aby });
}

function normalizedRect(from: Point, to: Point): Box {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, width: Math.max(from.x, to.x) - x, height: Math.max(from.y, to.y) - y };
}

/** Thickness of a pen stroke and a highlighter stroke, relative to the image's long edge. */
export function strokeWidths(longEdge: number): { pen: number; highlighter: number } {
  return {
    pen: Math.max(3, Math.round(longEdge * 0.005 * 10) / 10),
    highlighter: Math.round(longEdge * 0.025 * 10) / 10,
  };
}

/** Radius of a numbered pin, relative to the image's long edge. */
export function pinRadius(longEdge: number): number {
  return Math.max(3, Math.round((longEdge * 0.035) / 2 * 10) / 10);
}

export interface HitOptions {
  /** Hit tolerance in image pixels. A tap this close to a stroke or shape counts as a hit. */
  tolerance?: number;
  /** Long edge of the image, used to size pins and strokes consistently at any zoom. */
  longEdge?: number;
}

/** Finds the mark hit by a tap in image coordinates. Pins are checked first, then shapes, then strokes,
 * matching the visual layering: a tap on a pin should select the comment even if a stroke passes under it. */
export function hitTest(marks: readonly Mark[], point: Point, options: HitOptions = {}): Mark | undefined {
  const tolerance = options.tolerance ?? 20;
  const longEdge = options.longEdge ?? Math.max(1000, 1);
  const widths = strokeWidths(longEdge);
  const pRadius = pinRadius(longEdge);

  // Reverse so the most recently drawn mark wins within a category.
  const reversed = [...marks].reverse();

  for (const m of reversed) {
    if (m.kind === 'pin') {
      if (dist(point, m) <= pRadius + tolerance) return m;
    }
  }

  for (const m of reversed) {
    if (m.kind === 'rectangle') {
      const box = normalizedRect(m.from, m.to);
      const half = widths.pen / 2 + tolerance;
      // Distance from the tap to the rectangle edges.
      const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
      const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
      if (Math.hypot(dx, dy) <= half) return m;
    }
    if (m.kind === 'arrow') {
      if (distToSegment(point, m.from, m.to) <= widths.pen / 2 + tolerance) return m;
    }
  }

  for (const m of reversed) {
    if (m.kind === 'pen' || m.kind === 'highlighter') {
      const width = m.kind === 'pen' ? widths.pen : widths.highlighter;
      const points = m.points;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        if (distToSegment(point, a, b) <= width / 2 + tolerance) return m;
      }
    }
  }

  return undefined;
}

/** Bounding box of a mark in image pixels. For strokes it is the point cloud; for shapes the normalized
 * rectangle or the arrow shaft; for pins a zero-size box at the pin point. */
export function boundingBox(mark: Mark, longEdge: number): Box {
  switch (mark.kind) {
    case 'pen':
    case 'highlighter': {
      if (mark.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of mark.points) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case 'rectangle':
      return normalizedRect(mark.from, mark.to);
    case 'arrow': {
      const box = normalizedRect(mark.from, mark.to);
      // Include the arrowhead: pad each edge by roughly three pen widths.
      const head = strokeWidths(longEdge).pen * 3;
      return {
        x: box.x - head,
        y: box.y - head,
        width: box.width + head * 2,
        height: box.height + head * 2,
      };
    }
    case 'pin':
      return { x: mark.x, y: mark.y, width: 0, height: 0 };
  }
}

function roundPercent(value: number, max: number): number {
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function formatPosition(
  pin: PinMark,
  marks: readonly Mark[],
  imageWidth: number,
  imageHeight: number,
  longEdge: number,
): string {
  const target = pin.markId !== undefined ? marks.find((m) => m.id === pin.markId) : undefined;
  if (target !== undefined) {
    const box = boundingBox(target, longEdge);
    const x1 = roundPercent(box.x, imageWidth);
    const x2 = roundPercent(box.x + box.width, imageWidth);
    const y1 = roundPercent(box.y, imageHeight);
    const y2 = roundPercent(box.y + box.height, imageHeight);
    return `around ${x1}-${x2}% across, ${y1}-${y2}% down`;
  }
  const x = roundPercent(pin.x, imageWidth);
  const y = roundPercent(pin.y, imageHeight);
  return `at ${x}% across, ${y}% down`;
}

/** Composes the numbered comment lines for a single image. Returns an empty array when there are no
 * comments to list. */
export function composeCommentLines(
  imageIndex: number,
  imageCount: number,
  marks: readonly Mark[],
  imageSize: { width: number; height: number },
): string[] {
  const pins = numberedPins(marks).filter((p) => p.comment.trim() !== '');
  if (pins.length === 0) return [];
  const longEdge = Math.max(imageSize.width, imageSize.height);
  const header =
    imageCount <= 1
      ? 'Marks on the attached image (the numbers match the pins):'
      : `Marks on image ${imageIndex} of ${imageCount} (the numbers match the pins):`;
  return [
    header,
    ...pins.map((p) => {
      const position = formatPosition(p, marks, imageSize.width, imageSize.height, longEdge);
      return `${p.number}. ${p.comment.trim()} (${position})`;
    }),
  ];
}
