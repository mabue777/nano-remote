import { describe, expect, it, vi } from 'vitest';

import { childNodes, fire, text, type Node } from '../../test/vnode';
import { BackHeader } from './BackHeader';
import { Icon } from './Icon';

describe('BackHeader', () => {
  it('is the top bar with a back chevron and "<label>" linking to the page it goes to', () => {
    const tree = BackHeader({ href: '/chats', label: 'Chats', onBack: () => {} }) as Node;
    expect(tree.type).toBe('header');
    expect(tree.props.class).toBe('topbar');
    const [link] = childNodes(tree);
    expect(link!.type).toBe('a');
    expect(link!.props).toMatchObject({ class: 'back', href: '/chats' });
    expect(text(link!.props.children)).toBe('Chats');
    const [chevron] = childNodes(link!);
    expect(chevron!.type).toBe(Icon);
    expect(chevron!.props.name).toBe('back');
  });

  it('a tap goes back in the app instead of loading the page', () => {
    const onBack = vi.fn();
    const tree = BackHeader({ href: '/', label: 'Sessions', onBack }) as Node;
    const preventDefault = vi.fn();
    fire(childNodes(tree)[0]!, 'onClick', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('puts its children after the link, at the right of the bar', () => {
    const tree = BackHeader({ href: '/', label: 'Sessions', onBack: () => {}, children: <span class="pill ok">Idle</span> }) as Node;
    const [link, pill] = childNodes(tree);
    expect(link!.props.class).toBe('back');
    expect(pill!.props.class).toBe('pill ok');
    expect(text(pill!.props.children)).toBe('Idle');
  });

  it('renders only the link without children', () => {
    const tree = BackHeader({ href: '/', label: 'Chats', onBack: () => {} }) as Node;
    expect(childNodes(tree)).toHaveLength(1);
  });
});
