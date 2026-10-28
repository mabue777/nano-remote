// Comments on marks (docs/plan/image-markup.md, ticket 3): what a tap on the canvas comments on, where a new
// pin goes, and the words VoiceOver reads for a pin. Pure, so it is tested in Node; the cover (MarkupScreen.tsx)
// turns screen taps into image pixels before calling these. The pins themselves are ticket 1's model (marks.ts).
import { boundingBox, hitTest, numberedPins, type Mark, type PinMark, type Point } from './marks';

/** A pin's diameter on screen (CSS px) at any zoom; the exported picture uses the burn-in size instead. */
export const PIN_SCREEN = 26;
/** How far outside a mark or pin (CSS px) a tap still counts as on it. */
export const TAP_SLOP = 10;

/** What the comment sheet edits: an existing pin, or a new one at `x`, `y` (on `markId` when it has one). */
export interface CommentTarget {
  /** The pin being edited; absent for a new pin. */
  id?: string;
  x: number;
  y: number;
  markId?: string;
  /** The pin's number as shown (a new pin's is one more than the last). */
  number: number;
  comment: string;
}

/**
 * The comment a tap at `at` (image pixels) opens, with the canvas at `scale` (CSS px per image pixel):
 * a pin under the finger edits that pin; a mark under it edits the mark's pin, or adds one at the mark's
 * top-right corner. Elsewhere, `place` (the comment tool) adds a pin where the finger was, else nothing.
 */
export function commentAt(marks: readonly Mark[], at: Point, scale: number, size: { width: number; height: number }, place: boolean): CommentTarget | null {
  const pins = numberedPins(marks);
  const reach = (PIN_SCREEN / 2 + TAP_SLOP) / scale;
  let nearest: (typeof pins)[number] | undefined;
  for (const pin of pins) {
    const d = Math.hypot(pin.x - at.x, pin.y - at.y);
    if (d <= reach && (nearest === undefined || d <= Math.hypot(nearest.x - at.x, nearest.y - at.y))) nearest = pin;
  }
  if (nearest !== undefined) return edit(nearest);
  const longEdge = Math.max(size.width, size.height);
  const drawn = marks.filter((m) => m.kind !== 'pin');
  const mark = hitTest(drawn, at, { tolerance: TAP_SLOP / scale, longEdge });
  if (mark !== undefined) {
    const own = pins.find((p) => p.markId === mark.id);
    if (own !== undefined) return edit(own);
    const box = boundingBox(mark, longEdge);
    return { x: box.x + box.width, y: box.y, markId: mark.id, number: pins.length + 1, comment: '' };
  }
  return place ? { x: at.x, y: at.y, number: pins.length + 1, comment: '' } : null;
}

function edit(pin: PinMark & { number: number }): CommentTarget {
  return { id: pin.id, x: pin.x, y: pin.y, markId: pin.markId, number: pin.number, comment: pin.comment };
}

/** One line for a comment: line breaks become spaces (the sent text lists each comment on one line). */
export function cleanComment(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/** What VoiceOver reads for a pin: "Comment 2: wrong colour here". */
export function pinLabel(number: number, comment: string): string {
  const text = comment.trim();
  return text === '' ? `Comment ${number}` : `Comment ${number}: ${text}`;
}

/** The canvas's summary for VoiceOver: "3 marks, 2 comments", "1 comment", "no marks". */
export function marksSummary(marks: readonly Mark[]): string {
  const pins = marks.filter((m) => m.kind === 'pin').length;
  const drawn = marks.length - pins;
  const parts: string[] = [];
  if (drawn > 0) parts.push(drawn === 1 ? '1 mark' : `${drawn} marks`);
  if (pins > 0) parts.push(pins === 1 ? '1 comment' : `${pins} comments`);
  return parts.length === 0 ? 'no marks' : parts.join(', ');
}
