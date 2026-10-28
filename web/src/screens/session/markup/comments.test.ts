import { describe, expect, it } from 'vitest';

import { cleanComment, commentAt, marksSummary, PIN_SCREEN, pinLabel, TAP_SLOP } from './comments';
import { composeCommentLines, MarkupState, type Mark } from './marks';

const SIZE = { width: 1000, height: 2000 };
const rect: Mark = { kind: 'rectangle', id: 'r', color: 'red', from: { x: 100, y: 100 }, to: { x: 300, y: 200 } };
const pin = (id: string, x: number, y: number, comment: string, markId?: string): Mark => ({ kind: 'pin', id, x, y, comment, markId });

describe('commentAt', () => {
  it('places a new pin where the comment tool taps on nothing, numbered after the others', () => {
    const marks = [pin('a', 800, 800, 'one')];
    expect(commentAt(marks, { x: 500, y: 1500 }, 1, SIZE, true)).toEqual({ x: 500, y: 1500, number: 2, comment: '' });
  });

  it('does nothing for a tap on nothing with a drawing tool', () => {
    expect(commentAt([rect], { x: 600, y: 1500 }, 1, SIZE, false)).toBeNull();
  });

  it('opens an existing pin for editing with any tool', () => {
    const marks = [pin('a', 800, 800, 'one'), pin('b', 500, 500, 'two')];
    expect(commentAt(marks, { x: 505, y: 505 }, 1, SIZE, false)).toEqual({ id: 'b', x: 500, y: 500, markId: undefined, number: 2, comment: 'two' });
  });

  it('measures the pin reach in screen pixels, so it shrinks in image pixels when zoomed in', () => {
    const marks = [pin('a', 500, 500, 'one')];
    const reach = PIN_SCREEN / 2 + TAP_SLOP; // CSS px
    expect(commentAt(marks, { x: 500 + reach - 1, y: 500 }, 1, SIZE, false)?.id).toBe('a');
    // at 4x the same image distance is four times further on screen
    expect(commentAt(marks, { x: 500 + reach - 1, y: 500 }, 4, SIZE, false)).toBeNull();
    expect(commentAt(marks, { x: 500 + reach / 4 - 1, y: 500 }, 4, SIZE, false)?.id).toBe('a');
  });

  it('puts a new pin for a mark at the mark top-right corner and links it to the mark', () => {
    expect(commentAt([rect], { x: 200, y: 150 }, 1, SIZE, false)).toEqual({ x: 300, y: 100, markId: 'r', number: 1, comment: '' });
  });

  it('opens the pin a mark already has instead of adding a second one', () => {
    const marks = [rect, pin('p', 300, 100, 'too wide', 'r')];
    expect(commentAt(marks, { x: 150, y: 180 }, 1, SIZE, true)?.id).toBe('p');
  });
});

describe('pins renumber after a delete, on screen and in the composed text', () => {
  it('three comments, one deleted: the rest read 1 and 2', () => {
    const state = new MarkupState();
    state.add(pin('a', 100, 100, 'first'));
    state.add(pin('b', 200, 200, 'second'));
    state.add(pin('c', 300, 300, 'third'));
    state.update('c', (m) => ({ ...m, comment: 'third, edited' }));
    state.remove('a');
    expect(commentAt(state.marks, { x: 300, y: 300 }, 1, SIZE, false)?.number).toBe(2);
    expect(composeCommentLines(1, 1, state.marks, SIZE)).toEqual([
      'Marks on the attached image (the numbers match the pins):',
      '1. second (at 20% across, 10% down)',
      '2. third, edited (at 30% across, 15% down)',
    ]);
  });
});

describe('labels', () => {
  it('reads a pin with its comment', () => {
    expect(pinLabel(2, ' wrong colour here ')).toBe('Comment 2: wrong colour here');
    expect(pinLabel(1, '')).toBe('Comment 1');
  });

  it('keeps a comment on one line', () => {
    expect(cleanComment('  too wide\n  and too tall \n')).toBe('too wide and too tall');
  });

  it('summarises marks and comments apart', () => {
    expect(marksSummary([])).toBe('no marks');
    expect(marksSummary([rect])).toBe('1 mark');
    expect(marksSummary([rect, rect, pin('a', 1, 1, 'x')])).toBe('2 marks, 1 comment');
    expect(marksSummary([pin('a', 1, 1, 'x'), pin('b', 1, 1, 'y')])).toBe('2 comments');
  });
});
