import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../../test/hook-host';
import { useFlip, useListMotion } from './use-flip';

vi.mock('preact/hooks', async () => (await import('../../../test/hook-host')).hooks);

/** A row or a shelled box on a fake page: a position, a height, and the animations played on it. */
class FakeElement {
  readonly dataset: Record<string, string | undefined>;
  readonly style = { transformOrigin: '' };
  readonly played: Keyframe[][] = [];
  offsetHeight = 40;
  shell: FakeElement | null = null;

  constructor(
    key: Record<string, string>,
    public top = 0,
  ) {
    this.dataset = { ...key };
  }

  getBoundingClientRect() {
    return { left: 0, top: this.top };
  }

  animate(keyframes: Keyframe[]) {
    this.played.push(keyframes);
    return {};
  }

  matches(): boolean {
    return true;
  }

  querySelector(): FakeElement | null {
    return this.shell;
  }
}

/** The container: its rows (`[data-flip-key]`) and shelled boxes (`[data-shell-key]`). */
class FakeContainer {
  rows: FakeElement[] = [];
  shells: FakeElement[] = [];

  querySelectorAll(selector: string): FakeElement[] {
    return selector.includes('shell') ? this.shells : this.rows;
  }

  /** Lays the rows out top to bottom, 50 px apart, in this order. */
  layout(...keys: string[]): void {
    this.rows = keys.map((key, i) => this.rows.find((r) => r.dataset.flipKey === key) ?? new FakeElement({ flipKey: key }, i * 50));
    this.rows.forEach((row, i) => (row.top = i * 50));
  }

  row(key: string): FakeElement {
    return this.rows.find((r) => r.dataset.flipKey === key)!;
  }
}

const ref = (container: FakeContainer) => ({ current: container as unknown as HTMLElement });

beforeEach(() => {
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useFlip', () => {
  it('measures, lets the change render, slides the moved rows, fades the new ones and marks both', () => {
    const page = new FakeContainer();
    page.layout('a', 'b');
    const host = renderHook(() => useFlip(ref(page), true));
    const beforePlay = vi.fn();
    host.value(() => page.layout('n', 'b', 'a'), { beforePlay });
    host.render(); // the owner re-renders: the layout effect plays
    expect(beforePlay).toHaveBeenCalledTimes(1);
    expect(page.row('a').played).toEqual([[{ transform: 'translate(0px, -100px)' }, { transform: 'translate(0, 0)' }]]);
    expect(page.row('a').dataset.flipAnim).toBe('move');
    expect(page.row('n').dataset.flipAnim).toBe('enter');
    expect(page.row('n').played[0]![0]).toMatchObject({ opacity: 0 });
    expect(page.row('b').dataset.flipAnim).toBeUndefined();
    host.render(); // nothing pending: nothing plays again
    expect(page.row('a').played).toHaveLength(1);
  });

  it('new rows that match `rise` rise out of the composer instead', () => {
    const page = new FakeContainer();
    page.layout('a');
    const host = renderHook(() => useFlip(ref(page), true));
    host.value(() => page.layout('a', 'sent'), { enter: false, rise: '.sent' });
    host.render();
    expect(page.row('sent').played[0]![0]).toMatchObject({ opacity: 0, transform: 'translateY(12px) scale(0.98)' });
  });

  it('a shelled box that changed height scales its background from the old height', () => {
    const page = new FakeContainer();
    const box = new FakeElement({ shellKey: 'card' });
    box.offsetHeight = 120;
    box.shell = new FakeElement({});
    const flat = new FakeElement({ shellKey: 'line' });
    page.shells = [box, flat];
    const host = renderHook(() => useFlip(ref(page), true));
    host.value.prepare();
    box.offsetHeight = 40;
    host.render();
    expect(box.shell.played).toEqual([[{ transform: 'scaleY(3)' }, { transform: 'scaleY(1)' }]]);
    expect(flat.played).toEqual([]);
  });

  it('with Reduce Motion it only runs the update; without a container it does nothing', () => {
    const page = new FakeContainer();
    page.layout('a', 'b');
    const host = renderHook(() => useFlip(ref(page), false));
    const update = vi.fn(() => page.layout('b', 'a'));
    host.value(update);
    host.render();
    expect(update).toHaveBeenCalledTimes(1);
    expect(page.row('a').played).toEqual([]);
    const none = renderHook(() => useFlip({ current: null }, true));
    none.value.prepare();
    none.render();
  });
});

describe('useListMotion', () => {
  /** Renders the hook and then "commits": the fake page shows the rows it returned (leaving ones without a key). */
  function mount(page: FakeContainer, items: () => string[], enabled = true) {
    return renderHook(() => {
      const view = useListMotion(items(), (k) => k, ref(page), enabled);
      page.layout(...view.shown.filter((s) => !s.leaving).map((s) => s.item));
      return view;
    });
  }

  it('a status change moves a row: measured during the render, before the page changed, and slid after it', () => {
    const page = new FakeContainer();
    let items = ['a', 'b', 'c'];
    const host = mount(page, () => items);
    expect(host.value.shown.map((s) => s.item)).toEqual(['a', 'b', 'c']);
    expect(page.row('a').played).toEqual([]); // the first paint plays nothing

    items = ['c', 'a', 'b']; // c now needs you: it goes to the top
    host.render();
    expect(page.row('c').played).toEqual([[{ transform: 'translate(0px, 100px)' }, { transform: 'translate(0, 0)' }]]);
    expect(page.row('c').dataset.flipAnim).toBe('move');
    expect(page.row('a').dataset.flipAnim).toBe('move');
  });

  it('a removed row (archive, a filter switch) leaves at its old place, then goes and the rest close the gap', () => {
    const page = new FakeContainer();
    let items = ['a', 'b', 'c'];
    const host = mount(page, () => items);
    items = ['a', 'c'];
    host.render();
    expect(host.value.shown).toEqual([
      { item: 'a', leaving: false },
      { item: 'b', leaving: true },
      { item: 'c', leaving: false },
    ]);
    page.row('c').top = 100; // while b fades out, c still sits under it
    host.value.dropped('b'); // b's fade-out ended
    expect(host.value.shown.map((s) => s.item)).toEqual(['a', 'c']);
    expect(page.row('c').played.at(-1)).toEqual([{ transform: 'translate(0px, 50px)' }, { transform: 'translate(0, 0)' }]);
    const plays = page.row('c').played.length;
    host.value.dropped('b'); // a second animationend: nothing
    host.value.dropped('a'); // not leaving: nothing
    expect(page.row('c').played).toHaveLength(plays);
  });

  it('a new row fades and grows in', () => {
    const page = new FakeContainer();
    let items = ['a'];
    const host = mount(page, () => items);
    items = ['n', 'a'];
    host.render();
    expect(page.row('n').dataset.flipAnim).toBe('enter');
    expect(page.row('a').dataset.flipAnim).toBe('move');
  });

  it('with Reduce Motion a removed row goes at once and nothing plays', () => {
    const page = new FakeContainer();
    let items = ['a', 'b'];
    const host = mount(page, () => items, false);
    items = ['b', 'a'];
    host.render();
    items = ['a'];
    host.render();
    expect(host.value.shown).toEqual([{ item: 'a', leaving: false }]);
    expect(page.row('a').played).toEqual([]);
  });
});
