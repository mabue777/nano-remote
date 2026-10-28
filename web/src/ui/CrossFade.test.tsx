import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../test/hook-host';
import { childNodes, fire, text, type Node } from '../../test/vnode';
import { CrossFade } from './CrossFade';

vi.mock('preact/hooks', async () => (await import('../../test/hook-host')).hooks);

const render = (value: string) => <b>{value}</b>;

describe('CrossFade', () => {
  it('smooth: the old word fades out in place while the new one fades in; its animationend removes it', () => {
    let value = 'Working';
    const host = renderHook(() => CrossFade({ value, smooth: true, render }) as unknown as Node);
    expect(host.value.props.class).toBe('xfade');
    expect(childNodes(host.value).map((n) => n.props.class)).toEqual([undefined]);

    value = 'Needs approval';
    host.render();
    const [out, into] = childNodes(host.value);
    expect(out!.props).toMatchObject({ class: 'xfade-out', 'aria-hidden': 'true' });
    expect(text(out!.props.children)).toBe('Working');
    expect(into!.props.class).toBe('xfade-in');
    expect(text(into!.props.children)).toBe('Needs approval');

    fire(out!, 'onAnimationEnd');
    expect(childNodes(host.value).map((n) => n.props.class)).toEqual([undefined]);
  });

  it('going back to a word that is still fading out does not show it twice', () => {
    let value = 'a';
    const host = renderHook(() => CrossFade({ value, smooth: true, render }) as unknown as Node);
    value = 'b';
    host.render();
    value = 'a';
    host.render();
    expect(childNodes(host.value).map((n) => text(n.props.children))).toEqual(['b', 'a']);
  });

  it('not smooth (Reduce Motion): the word simply changes', () => {
    let value = 'Working';
    const host = renderHook(() => CrossFade({ value, smooth: false, render }) as unknown as Node);
    value = 'Finished';
    host.render();
    expect(text(host.value.props.children)).toBe('Finished');
  });
});
