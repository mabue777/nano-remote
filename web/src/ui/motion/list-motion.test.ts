import { describe, expect, it } from 'vitest';

import { ListMotion } from './list-motion';

interface Row {
  id: string;
  word: string;
}
const row = (id: string, word = 'Idle'): Row => ({ id, word });
const flat = (shown: { item: Row; leaving: boolean }[]) => shown.map(({ item, leaving }) => `${item.id}${leaving ? '-' : ''}:${item.word}`);

describe('ListMotion', () => {
  it('the first rows change nothing (no entrance on the first paint)', () => {
    const list = new ListMotion<Row>((r) => r.id);
    const step = list.next([row('a'), row('b')], true);
    expect(step.changed).toBe(false);
    expect(flat(step.shown)).toEqual(['a:Idle', 'b:Idle']);
  });

  it('same rows: no change to measure, each row takes its fresh data (a status word)', () => {
    const list = new ListMotion<Row>((r) => r.id);
    list.next([row('a'), row('b')], true);
    const step = list.next([row('a', 'Working'), row('b')], true);
    expect(step.changed).toBe(false);
    expect(flat(step.shown)).toEqual(['a:Working', 'b:Idle']);
  });

  it('a reorder or a new row is a change; a removed row stays, leaving, until it is dropped', () => {
    const list = new ListMotion<Row>((r) => r.id);
    list.next([row('a'), row('b'), row('c')], true);
    let step = list.next([row('c'), row('a')], true);
    expect(step.changed).toBe(true);
    expect(flat(step.shown)).toEqual(['c:Idle', 'a:Idle', 'b-:Idle']);
    expect(list.leaving('b')).toBe(true);
    expect(list.leaving('a')).toBe(false);
    // While it fades, the others update; the leaving row keeps its last data.
    step = list.next([row('c', 'Working'), row('a')], true);
    expect(flat(step.shown)).toEqual(['c:Working', 'a:Idle', 'b-:Idle']);
    expect(list.drop('b')).toBe(true);
    expect(list.drop('b')).toBe(false);
    expect(flat(list.next([row('c', 'Working'), row('a')], true).shown)).toEqual(['c:Working', 'a:Idle']);
  });

  it('without animation (Reduce Motion) a removed row goes at once, but the change is still reported', () => {
    const list = new ListMotion<Row>((r) => r.id);
    list.next([row('a'), row('b')], false);
    const step = list.next([row('b')], false);
    expect(step.changed).toBe(true);
    expect(flat(step.shown)).toEqual(['b:Idle']);
    expect(list.leaving('a')).toBe(false);
  });

  it('a row that comes back while it was leaving is a plain row again', () => {
    const list = new ListMotion<Row>((r) => r.id);
    list.next([row('a'), row('b')], true);
    list.next([row('a')], true);
    expect(flat(list.next([row('b'), row('a')], true).shown)).toEqual(['b:Idle', 'a:Idle']);
  });
});
