import { describe, expect, it } from 'vitest';

import {
  MARKUP_COLORS,
  MarkupState,
  boundingBox,
  composeCommentLines,
  hitTest,
  markId,
  numberedPins,
  type Mark,
} from './marks';

describe('markup model', () => {
  it('creates mark ids', () => {
    const a = markId();
    const b = markId();
    expect(a).toMatch(/^mark_/);
    expect(a).not.toBe(b);
  });

  it('adds, updates and removes marks', () => {
    const state = new MarkupState();
    const m1: Mark = { kind: 'pen', id: 'p1', color: 'red', points: [{ x: 0, y: 0 }] };
    state.add(m1);
    expect(state.marks).toEqual([m1]);
    state.update('p1', (m) => (m.kind === 'pen' ? { ...m, color: 'blue' } : m));
    expect(state.marks[0]).toMatchObject({ color: 'blue' });
    state.remove('p1');
    expect(state.marks).toEqual([]);
  });

  it('undo and redo walk the snapshot stack', () => {
    const state = new MarkupState();
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    state.add({ kind: 'rectangle', id: 'r1', color: 'red', from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    state.add({ kind: 'rectangle', id: 'r2', color: 'blue', from: { x: 20, y: 20 }, to: { x: 30, y: 30 } });
    expect(state.marks).toHaveLength(2);
    expect(state.canUndo).toBe(true);
    state.undo();
    expect(state.marks).toHaveLength(1);
    expect(state.canRedo).toBe(true);
    state.redo();
    expect(state.marks).toHaveLength(2);
    state.undo();
    state.undo();
    expect(state.marks).toHaveLength(0);
    expect(state.canUndo).toBe(false);
    state.redo();
    state.redo();
    expect(state.marks).toHaveLength(2);
  });

  it('clear is undoable', () => {
    const state = new MarkupState();
    state.add({ kind: 'pen', id: 'p1', color: 'red', points: [{ x: 0, y: 0 }] });
    state.clear();
    expect(state.marks).toHaveLength(0);
    state.undo();
    expect(state.marks).toHaveLength(1);
  });

  it('a new edit after an undo drops the redo branch', () => {
    const state = new MarkupState();
    state.add({ kind: 'pen', id: 'p1', color: 'red', points: [{ x: 0, y: 0 }] });
    state.add({ kind: 'pen', id: 'p2', color: 'red', points: [{ x: 1, y: 1 }] });
    state.undo();
    state.add({ kind: 'rectangle', id: 'r1', color: 'green', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } });
    expect(state.marks).toHaveLength(2);
    expect(state.marks[1]).toMatchObject({ kind: 'rectangle' });
    expect(state.canRedo).toBe(false);
  });

  it('numbers pins in creation order and renumbers after deletes', () => {
    const state = new MarkupState();
    state.add({ kind: 'pin', id: 'pin1', x: 10, y: 10, comment: 'first' });
    state.add({ kind: 'pin', id: 'pin2', x: 20, y: 20, comment: 'second' });
    state.add({ kind: 'pin', id: 'pin3', x: 30, y: 30, comment: 'third' });
    expect(numberedPins(state.marks).map((p) => ({ id: p.id, number: p.number }))).toEqual([
      { id: 'pin1', number: 1 },
      { id: 'pin2', number: 2 },
      { id: 'pin3', number: 3 },
    ]);
    state.remove('pin2');
    expect(numberedPins(state.marks).map((p) => ({ id: p.id, number: p.number }))).toEqual([
      { id: 'pin1', number: 1 },
      { id: 'pin3', number: 2 },
    ]);
  });

  it('hit tests pins within their radius plus tolerance', () => {
    const longEdge = 1000;
    const marks: Mark[] = [{ kind: 'pin', id: 'pin', x: 150, y: 150, comment: 'center' }];
    expect(hitTest(marks, { x: 150, y: 150 }, { longEdge })?.id).toBe('pin');
    // Radius is 17.5 px; 18 px away misses without tolerance, hits with one pixel of slop.
    expect(hitTest(marks, { x: 168, y: 150 }, { tolerance: 0, longEdge })).toBeUndefined();
    expect(hitTest(marks, { x: 168, y: 150 }, { tolerance: 1, longEdge })?.id).toBe('pin');
  });

  it('hit tests rectangles and arrows before strokes, with tolerance', () => {
    const longEdge = 1000;
    const marks: Mark[] = [
      { kind: 'rectangle', id: 'rect', color: 'red', from: { x: 100, y: 100 }, to: { x: 200, y: 200 } },
      { kind: 'arrow', id: 'arrow', color: 'red', from: { x: 0, y: 0 }, to: { x: 1000, y: 0 } },
    ];
    expect(hitTest(marks, { x: 120, y: 120 }, { longEdge })?.id).toBe('rect');
    expect(hitTest(marks, { x: 500, y: 2 }, { longEdge })?.id).toBe('arrow');
  });

  it('hit testing prefers pins over underlying shapes', () => {
    const longEdge = 1000;
    const marks: Mark[] = [
      { kind: 'rectangle', id: 'rect', color: 'red', from: { x: 100, y: 100 }, to: { x: 200, y: 200 } },
      { kind: 'pin', id: 'pin', x: 150, y: 150, comment: 'center' },
    ];
    expect(hitTest(marks, { x: 150, y: 150 }, { longEdge })?.id).toBe('pin');
  });

  it('hit tests strokes at zoom by scaling the tolerance in image pixels', () => {
    const longEdge = 1000;
    const marks: Mark[] = [
      { kind: 'pen', id: 'pen', color: 'red', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] },
    ];
    // At 1x, a 10 px screen tap is 10 image pixels.
    expect(hitTest(marks, { x: 500, y: 10 }, { tolerance: 10, longEdge })?.id).toBe('pen');
    expect(hitTest(marks, { x: 500, y: 30 }, { tolerance: 10, longEdge })).toBeUndefined();
    // At 2x zoom, the same 10 px screen tap is only 5 image pixels.
    expect(hitTest(marks, { x: 500, y: 5 }, { tolerance: 5, longEdge })?.id).toBe('pen');
    expect(hitTest(marks, { x: 500, y: 10 }, { tolerance: 5, longEdge })).toBeUndefined();
  });

  it('hit testing prefers the most recently drawn mark', () => {
    const longEdge = 1000;
    const marks: Mark[] = [
      { kind: 'rectangle', id: 'first', color: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
      { kind: 'rectangle', id: 'second', color: 'blue', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
    ];
    expect(hitTest(marks, { x: 50, y: 50 }, { longEdge })?.id).toBe('second');
  });

  it('hit testing returns undefined when nothing is close enough', () => {
    const longEdge = 1000;
    expect(hitTest([], { x: 50, y: 50 }, { longEdge })).toBeUndefined();
    expect(
      hitTest(
        [{ kind: 'pen', id: 'pen', color: 'red', points: [{ x: 0, y: 0 }] }],
        { x: 50, y: 50 },
        { longEdge },
      ),
    ).toBeUndefined();
    expect(
      hitTest(
        [{ kind: 'rectangle', id: 'rect', color: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }],
        { x: 200, y: 200 },
        { tolerance: 1, longEdge },
      ),
    ).toBeUndefined();
    expect(
      hitTest(
        [{ kind: 'pen', id: 'degenerate', color: 'red', points: [{ x: 50, y: 50 }, { x: 50, y: 50 }] }],
        { x: 50, y: 50 },
        { tolerance: 2, longEdge },
      )?.id,
    ).toBe('degenerate');
  });

  it('computes bounding boxes in image pixels, including arrow heads', () => {
    const longEdge = 1000;
    expect(boundingBox({ kind: 'pin', id: 'p', x: 50, y: 60, comment: '' }, longEdge)).toEqual({
      x: 50,
      y: 60,
      width: 0,
      height: 0,
    });
    expect(
      boundingBox(
        { kind: 'rectangle', id: 'r', color: 'red', from: { x: 10, y: 20 }, to: { x: 100, y: 200 } },
        longEdge,
      ),
    ).toEqual({ x: 10, y: 20, width: 90, height: 180 });
    expect(
      boundingBox(
        { kind: 'pen', id: 's', color: 'red', points: [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 10, y: 25 }] },
        longEdge,
      ),
    ).toEqual({ x: 5, y: 5, width: 10, height: 20 });
    expect(
      boundingBox(
        { kind: 'arrow', id: 'a', color: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
        longEdge,
      ),
    ).toEqual({ x: -15, y: -15, width: 130, height: 30 });
    expect(
      boundingBox({ kind: 'pen', id: 'empty', color: 'red', points: [] }, longEdge),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('rounds bounding-box percentages to whole numbers', () => {
    const state = new MarkupState();
    state.add({
      kind: 'rectangle',
      id: 'rect',
      color: 'red',
      from: { x: 62.4, y: 10.4 },
      to: { x: 79.6, y: 13.6 },
    });
    state.add({ kind: 'pin', id: 'pin1', x: 62.4, y: 10.4, comment: 'rounded', markId: 'rect' });
    const lines = composeCommentLines(1, 1, state.marks, { width: 100, height: 100 });
    expect(lines).toEqual([
      'Marks on the attached image (the numbers match the pins):',
      '1. rounded (around 62-80% across, 10-14% down)',
    ]);
  });

  it('produces "at" for a standalone pin and "around" for a pin on a mark', () => {
    const state = new MarkupState();
    state.add({ kind: 'rectangle', id: 'rect', color: 'red', from: { x: 0, y: 0 }, to: { x: 50, y: 50 } });
    state.add({ kind: 'pin', id: 'pin1', x: 75, y: 75, comment: 'standalone' });
    state.add({ kind: 'pin', id: 'pin2', x: 10, y: 10, comment: 'on mark', markId: 'rect' });
    const lines = composeCommentLines(1, 1, state.marks, { width: 100, height: 100 });
    expect(lines).toEqual([
      'Marks on the attached image (the numbers match the pins):',
      '1. standalone (at 75% across, 75% down)',
      '2. on mark (around 0-50% across, 0-50% down)',
    ]);
  });

  it('uses multi-image wording and skips empty comments', () => {
    const state = new MarkupState();
    state.add({ kind: 'pin', id: 'pin1', x: 35, y: 71, comment: 'comment one' });
    state.add({ kind: 'pin', id: 'pin2', x: 0, y: 0, comment: '   ' });
    state.add({ kind: 'pin', id: 'pin3', x: 60, y: 40, comment: 'comment three' });
    const lines = composeCommentLines(2, 3, state.marks, { width: 100, height: 100 });
    expect(lines).toEqual([
      'Marks on image 2 of 3 (the numbers match the pins):',
      '1. comment one (at 35% across, 71% down)',
      '3. comment three (at 60% across, 40% down)',
    ]);
  });

  it('clamps comment percentages to 0-100 when a mark extends outside the image', () => {
    const state = new MarkupState();
    state.add({
      kind: 'rectangle',
      id: 'rect',
      color: 'red',
      from: { x: -50, y: 900 },
      to: { x: 150, y: 1100 },
    });
    state.add({ kind: 'pin', id: 'pin1', x: -10, y: 1050, comment: 'outside', markId: 'rect' });
    const lines = composeCommentLines(1, 1, state.marks, { width: 1000, height: 1000 });
    expect(lines).toEqual([
      'Marks on the attached image (the numbers match the pins):',
      '1. outside (around 0-15% across, 90-100% down)',
    ]);
  });

  it('returns no lines when every comment is empty', () => {
    const state = new MarkupState();
    state.add({ kind: 'pin', id: 'p', x: 50, y: 50, comment: '' });
    expect(composeCommentLines(1, 1, state.marks, { width: 100, height: 100 })).toEqual([]);
  });

  it('exposes the fixed markup colours', () => {
    expect(MARKUP_COLORS).toMatchObject({
      red: expect.stringMatching(/^#/),
      yellow: expect.stringMatching(/^#/),
      blue: expect.stringMatching(/^#/),
      green: expect.stringMatching(/^#/),
    });
  });
});
