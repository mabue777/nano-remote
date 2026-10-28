// Burn-in: draw marks onto an injected 2D canvas context, and export a marked image using the same
// size and type rules as attachments/resize.ts.

import { JPEG_QUALITY, fitWithin, outputType, renamed, type Decoded, type PreparedImage } from '../attachments/resize';
import { MARKUP_COLORS, pinRadius, strokeWidths, type Mark, type MarkupColor, type PinMark, type Point, numberedPins } from './marks';

function pinDiameter(longEdge: number): number {
  return pinRadius(longEdge) * 2;
}

function withColor(ctx: CanvasRenderingContext2D, color: MarkupColor): void {
  ctx.strokeStyle = MARKUP_COLORS[color];
  ctx.fillStyle = MARKUP_COLORS[color];
}

function drawPen(ctx: CanvasRenderingContext2D, points: readonly Point[], width: number, color: MarkupColor): void {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  withColor(ctx, color);
  ctx.stroke();
}

function drawHighlighter(ctx: CanvasRenderingContext2D, points: readonly Point[], width: number, color: MarkupColor): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  withColor(ctx, color);
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.stroke();
  ctx.restore();
}

function drawRectangle(ctx: CanvasRenderingContext2D, from: Point, to: Point, width: number, color: MarkupColor): void {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const w = Math.max(from.x, to.x) - x;
  const h = Math.max(from.y, to.y) - y;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  withColor(ctx, color);
  ctx.strokeRect(x, y, w, h);
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, width: number, color: MarkupColor, longEdge: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  withColor(ctx, color);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  const headLength = Math.max(6, width * 3);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = MARKUP_COLORS[color];
  ctx.fill();
}

function drawPin(ctx: CanvasRenderingContext2D, pin: PinMark & { number: number }, diameter: number, color: MarkupColor): void {
  const radius = diameter / 2;
  const ringWidth = Math.max(1, diameter * 0.06);

  ctx.beginPath();
  ctx.arc(pin.x, pin.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = MARKUP_COLORS[color];
  ctx.fill();

  ctx.beginPath();
  ctx.arc(pin.x, pin.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = ringWidth;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.max(10, radius * 1.2)}px sans-serif`;
  ctx.fillText(String(pin.number), pin.x, pin.y);
}

/** Draw every mark onto the context. The caller is expected to have already drawn the background image.
 * Marks are drawn in order: shapes and strokes first, then numbered pins on top. */
export function burnIn(ctx: CanvasRenderingContext2D, marks: readonly Mark[], width: number, height: number): void {
  const longEdge = Math.max(width, height);
  const widths = strokeWidths(longEdge);
  const pinD = pinDiameter(longEdge);
  const pins = numberedPins(marks);
  const pinById = new Map(pins.map((p) => [p.id, p]));

  ctx.save();
  for (const mark of marks) {
    if (mark.kind === 'pin') continue;
    switch (mark.kind) {
      case 'pen':
        drawPen(ctx, mark.points, widths.pen, mark.color);
        break;
      case 'highlighter':
        drawHighlighter(ctx, mark.points, widths.highlighter, mark.color);
        break;
      case 'rectangle':
        drawRectangle(ctx, mark.from, mark.to, widths.pen, mark.color);
        break;
      case 'arrow':
        drawArrow(ctx, mark.from, mark.to, widths.pen, mark.color, longEdge);
        break;
    }
  }
  for (const mark of marks) {
    if (mark.kind !== 'pin') continue;
    const numbered = pinById.get(mark.id);
    drawPin(ctx, numbered!, pinD, 'red');
  }
  ctx.restore();
}

/** A canvas-like object for export; HTMLCanvasElement satisfies this interface. */
export interface ExportCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

/** Burns marks into a copy of the image and encodes it using the same type/quality rules as resize.ts.
 * PNG stays PNG; everything else becomes a JPEG at 0.9. */
export async function exportMarkedImage(
  file: Blob & { name: string; type: string },
  image: Decoded,
  marks: readonly Mark[],
  canvas: ExportCanvas,
): Promise<PreparedImage> {
  const size = fitWithin(image.width, image.height);
  const type = outputType(file.type);
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d canvas');
  ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, size.width, size.height);
  burnIn(ctx, marks, size.width, size.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b === null ? reject(new Error('the image could not be encoded')) : resolve(b)),
      type,
      JPEG_QUALITY,
    );
  });
  return { blob, name: renamed(file.name, file.type, type), type, ...size };
}
