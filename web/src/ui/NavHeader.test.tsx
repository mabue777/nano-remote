import { describe, expect, it, vi } from 'vitest';

import { allNodes, byType, childNodes, fire, only, text, type Node } from '../../test/vnode';
import { GroupList } from './GroupList';
import { Icon } from './Icon';
import { NavHeader } from './NavHeader';

describe('NavHeader', () => {
  const onBack = vi.fn();
  const onMore = vi.fn();
  const tree = NavHeader({ href: '/', backLabel: 'Sessions', onBack, title: 'Fix the parser', moreLabel: 'Session details', onMore, children: 'Working · 5s' }) as Node;

  it('is one bar: round back link (icon only, named), the centred title with one footnote, a round ⋯ button', () => {
    expect(tree.type).toBe('header');
    expect(tree.props.class).toBe('nav');
    const [back, middle, more] = childNodes(tree);
    expect(back!.props).toMatchObject({ class: 'round-button', href: '/', 'aria-label': 'Sessions' });
    expect(text(back!.props.children)).toBe('');
    expect(childNodes(back!)[0]!.type).toBe(Icon);
    expect(middle!.props.class).toBe('nav-title');
    expect(text(only(middle!, byType('h1')).props.children)).toBe('Fix the parser');
    expect(text(only(middle!, byType('p')).props.children)).toBe('Working · 5s');
    expect(more!.props).toMatchObject({ class: 'round-button', 'aria-label': 'Session details', 'aria-haspopup': 'dialog' });
  });

  it('a tap on back navigates in the app; ⋯ calls onMore', () => {
    const preventDefault = vi.fn();
    fire(childNodes(tree)[0]!, 'onClick', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    fire(childNodes(tree)[2]!, 'onClick');
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it('without children there is no footnote line', () => {
    const bare = NavHeader({ href: '/', backLabel: 'Sessions', onBack, title: 'T', moreLabel: 'More', onMore }) as Node;
    expect(allNodes(bare).filter(byType('p'))).toHaveLength(0);
  });
});

describe('GroupList', () => {
  it('plain rows are text; rows with a tap are buttons, with a chevron when they open a sheet', () => {
    const open = vi.fn();
    const remove = vi.fn();
    const tree = GroupList({
      label: 'Session details',
      rows: [
        { key: 'agent', icon: 'terminal', label: 'Agent', value: [{ text: 'Codex' }] },
        { key: 'model', icon: 'gear', label: 'Model', value: [{ text: 'gpt', label: 'Model' }, { text: 'High', label: 'Effort' }], onClick: open, opens: true, title: 'Change model and effort' },
        { key: 'delete', icon: 'trash', label: 'Delete…', value: [], onClick: remove, tone: 'error' },
      ],
    }) as Node;
    expect(tree.props['aria-label']).toBe('Session details');
    const [agent, model, del] = childNodes(tree).map((li) => childNodes(li)[0]!);
    expect(agent!.type).toBe('div');
    expect(model!.type).toBe('button');
    expect(model!.props).toMatchObject({ class: 'group-row', title: 'Change model and effort', 'aria-haspopup': 'dialog' });
    expect(del!.props.class).toBe('group-row error');
    expect(del!.props.title).toBeUndefined();
    fire(model!, 'onClick');
    fire(del!, 'onClick');
    expect(open).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
