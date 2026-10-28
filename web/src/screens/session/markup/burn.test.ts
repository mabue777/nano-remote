import { describe, expect, it } from 'vitest';

import { JPEG_QUALITY } from '../attachments/resize';
import { burnIn, exportMarkedImage, type ExportCanvas } from './burn';
import { MARKUP_COLORS, pinRadius, strokeWidths, type Mark } from './marks';

interface ContextState {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

class FakeContext {
  calls: { name: string; args: unknown[]; state: ContextState }[] = [];
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  globalAlpha = 1;
  font = '';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  private snapshot(): ContextState {
    return {
      strokeStyle: this.strokeStyle,
      fillStyle: this.fillStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      globalAlpha: this.globalAlpha,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    };
  }

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args, state: this.snapshot() });
  }

  save(): void {
    this.record('save');
  }

  restore(): void {
    this.record('restore');
  }

  beginPath(): void {
    this.record('beginPath');
  }

  closePath(): void {
    this.record('closePath');
  }

  moveTo(x: number, y: number): void {
    this.record('moveTo', x, y);
  }

  lineTo(x: number, y: number): void {
    this.record('lineTo', x, y);
  }

  arc(x: number, y: number, radius: number, start: number, end: number): void {
    this.record('arc', x, y, radius, start, end);
  }

  stroke(): void {
    this.record('stroke');
  }

  fill(): void {
    this.record('fill');
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record('strokeRect', x, y, w, h);
  }

  fillText(text: string, x: number, y: number): void {
    this.record('fillText', text, x, y);
  }

  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void {
    this.record('drawImage', image, dx, dy, dw, dh);
  }
}

function fakeCanvas(context: FakeContext): ExportCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => context as unknown as CanvasRenderingContext2D,
    toBlob: (callback, type, quality) => {
      const blob = new Blob([], { type });
      Object.assign(blob, { quality });
      callback(blob as Blob);
    },
  };
}

describe('burn-in', () => {
  it('sizes strokes relative to the long edge with a minimum pen width', () => {
    expect(strokeWidths(1000)).toEqual({ pen: 5, highlighter: 25 });
    expect(strokeWidths(400)).toEqual({ pen: 3, highlighter: 10 });
    expect(pinRadius(1000)).toBe(17.5);
    expect(pinRadius(200)).toBe(3.5);
    expect(pinRadius(100)).toBe(3); // minimum radius
  });

  it('draws a pen stroke with round caps and the chosen colour', () => {
    const ctx = new FakeContext();
    const marks: Mark[] = [{ kind: 'pen', id: 'p1', color: 'blue', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }];
    burnIn(ctx as unknown as CanvasRenderingContext2D, marks, 1000, 500);
    const stroke = ctx.calls.find((c) => c.name === 'stroke');
    expect(stroke).toBeDefined();
    expect(stroke!.state).toMatchObject({
      lineCap: 'round',
      lineJoin: 'round',
      lineWidth: 5,
      strokeStyle: MARKUP_COLORS.blue,
      fillStyle: MARKUP_COLORS.blue,
    });
  });

  it('draws a highlighter stroke at 35% opacity', () => {
    const ctx = new FakeContext();
    const marks: Mark[] = [
      { kind: 'highlighter', id: 'h1', color: 'yellow', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
    ];
    burnIn(ctx as unknown as CanvasRenderingContext2D, marks, 1000, 500);
    const stroke = ctx.calls.find((c) => c.name === 'stroke');
    expect(stroke!.state).toMatchObject({
      globalAlpha: 0.35,
      lineWidth: 25,
      strokeStyle: MARKUP_COLORS.yellow,
    });
  });

  it('draws a rectangle and an arrow with the pen width', () => {
    const ctx = new FakeContext();
    const marks: Mark[] = [
      { kind: 'rectangle', id: 'r1', color: 'green', from: { x: 10, y: 10 }, to: { x: 90, y: 90 } },
      { kind: 'arrow', id: 'a1', color: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
    ];
    burnIn(ctx as unknown as CanvasRenderingContext2D, marks, 1000, 500);
    const rect = ctx.calls.find((c) => c.name === 'strokeRect');
    expect(rect).toMatchObject({ name: 'strokeRect', args: [10, 10, 80, 80] });
    expect(rect!.state).toMatchObject({ lineWidth: 5, strokeStyle: MARKUP_COLORS.green });
    const fills = ctx.calls.filter((c) => c.name === 'fill');
    expect(fills.length).toBeGreaterThanOrEqual(1); // arrow head
  });

  it('draws numbered pins on top of other marks with a white ring and number', () => {
    const ctx = new FakeContext();
    const marks: Mark[] = [
      { kind: 'rectangle', id: 'r1', color: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
      { kind: 'pin', id: 'pin1', x: 50, y: 50, comment: 'first' },
      { kind: 'pin', id: 'pin2', x: 60, y: 60, comment: 'second' },
    ];
    burnIn(ctx as unknown as CanvasRenderingContext2D, marks, 1000, 500);
    const fillTexts = ctx.calls.filter((c) => c.name === 'fillText');
    expect(fillTexts.map((c) => c.args[0])).toEqual(['1', '2']);
    const arcs = ctx.calls.filter((c) => c.name === 'arc');
    // Two arcs per pin: filled body + white ring.
    expect(arcs.length).toBe(4);
    const ring = ctx.calls.find((c) => c.name === 'arc' && c.state.strokeStyle === '#ffffff');
    expect(ring).toBeDefined();
  });

  it('burns pins at 3.5% of the long edge, or at a given size (the live canvas: one screen size at any zoom)', () => {
    const marks: Mark[] = [{ kind: 'pin', id: 'pin1', x: 50, y: 50, comment: 'first' }];
    const burnt = new FakeContext();
    burnIn(burnt as unknown as CanvasRenderingContext2D, marks, 2000, 1000);
    expect(burnt.calls.find((c) => c.name === 'arc')!.args[2]).toBe(35); // 3.5% of 2000, halved
    // 26 CSS px at 4x zoom is 6.5 image px: the number and ring scale with it, no burn-in floor
    const live = new FakeContext();
    burnIn(live as unknown as CanvasRenderingContext2D, marks, 2000, 1000, 6.5);
    const arc = live.calls.find((c) => c.name === 'arc')!;
    expect(arc.args[2]).toBe(3.25);
    const text = live.calls.find((c) => c.name === 'fillText')!;
    expect(text.state.font).toBe(`bold ${3.25 * 1.2}px sans-serif`);
    const ring = live.calls.find((c) => c.name === 'stroke' && c.state.strokeStyle === '#ffffff')!;
    expect(ring.state.lineWidth).toBeCloseTo(0.52);
  });

  it('pins are drawn in mark order even when another mark is added after a pin', () => {
    const ctx = new FakeContext();
    const marks: Mark[] = [
      { kind: 'pin', id: 'pin1', x: 10, y: 10, comment: 'first' },
      { kind: 'rectangle', id: 'r1', color: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
    ];
    burnIn(ctx as unknown as CanvasRenderingContext2D, marks, 1000, 500);
    const names = ctx.calls.map((c) => c.name);
    const pinTextIndex = names.indexOf('fillText');
    const rectIndex = names.indexOf('strokeRect');
    expect(pinTextIndex).toBeGreaterThan(rectIndex);
  });

  it('exports at the prepared size, reuses outputType and the encode step from resize.ts', async () => {
    const ctx = new FakeContext();
    const canvas = fakeCanvas(ctx);
    const image = { width: 3000, height: 2000, close: () => {} };
    const file = new File([], 'photo.heic', { type: 'image/heic' });
    const marks: Mark[] = [{ kind: 'pin', id: 'p1', x: 100, y: 100, comment: 'note' }];
    const prepared = await exportMarkedImage(file as Blob & { name: string; type: string }, image, marks, canvas);
    expect(prepared).toMatchObject({
      name: 'photo.jpg',
      type: 'image/jpeg',
      width: 2048,
      height: 1365,
    });
    expect(canvas.width).toBe(2048);
    expect(canvas.height).toBe(1365);
    const draw = ctx.calls.find((c) => c.name === 'drawImage');
    expect(draw).toMatchObject({ name: 'drawImage', args: [image, 0, 0, 2048, 1365] });
    const pin = ctx.calls.find((c) => c.name === 'fillText' && c.args[0] === '1');
    expect(pin).toBeDefined();
  });

  it('draws nothing for strokes with no points', () => {
    const ctx = new FakeContext();
    const marks: Mark[] = [
      { kind: 'pen', id: 'p1', color: 'red', points: [] },
      { kind: 'highlighter', id: 'h1', color: 'yellow', points: [] },
    ];
    burnIn(ctx as unknown as CanvasRenderingContext2D, marks, 1000, 500);
    expect(ctx.calls.some((c) => c.name === 'stroke')).toBe(false);
  });

  it('rejects export when the canvas has no 2d context', async () => {
    const canvas: ExportCanvas = {
      width: 0,
      height: 0,
      getContext: () => null,
      toBlob: () => {},
    };
    const file = new File([], 'shot.png', { type: 'image/png' });
    await expect(
      exportMarkedImage(file as Blob & { name: string; type: string }, { width: 100, height: 100 }, [], canvas),
    ).rejects.toThrow(/no 2d canvas/);
  });

  it('rejects export when encoding produces no blob', async () => {
    const ctx = new FakeContext();
    const canvas: ExportCanvas = {
      width: 0,
      height: 0,
      getContext: () => ctx as unknown as CanvasRenderingContext2D,
      toBlob: (callback) => callback(null),
    };
    const file = new File([], 'shot.png', { type: 'image/png' });
    await expect(
      exportMarkedImage(file as Blob & { name: string; type: string }, { width: 100, height: 100 }, [], canvas),
    ).rejects.toThrow(/the image could not be encoded/);
  });

  it('exports a PNG unchanged as PNG even when small', async () => {
    const ctx = new FakeContext();
    const canvas = fakeCanvas(ctx);
    const image = { width: 300, height: 200 };
    const file = new File([], 'shot.png', { type: 'image/png' });
    const prepared = await exportMarkedImage(file as Blob & { name: string; type: string }, image, [], canvas);
    expect(prepared).toMatchObject({ name: 'shot.png', type: 'image/png', width: 300, height: 200 });
  });
});
