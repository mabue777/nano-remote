import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../test/hook-host';
import { allNodes, byType, childNodes, fire, only, text, type Node } from '../../test/vnode';
import { isBackdropTap, Sheet, SheetHeader, useCloseOnEscape } from './Sheet';

vi.mock('preact/hooks', async () => (await import('../../test/hook-host')).hooks);

function sheet(props: Partial<Parameters<typeof Sheet>[0]> = {}): { tree: Node; onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  const tree = Sheet({ labelledBy: 'title-id', onClose, children: <p>Body</p>, ...props }) as Node;
  return { tree, onClose };
}

describe('Sheet', () => {
  it('is a backdrop holding a modal dialog named by the heading id, with the children inside', () => {
    const { tree } = sheet();
    expect(tree.type).toBe('div');
    expect(tree.props.class).toBe('sheet-backdrop');
    const [panel] = childNodes(tree);
    expect(panel!.type).toBe('section');
    expect(panel!.props).toMatchObject({ class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'title-id' });
    expect(text(panel!.props.children)).toBe('Body');
  });

  it('adds an extra class to the panel', () => {
    const { tree } = sheet({ class: 'detail-sheet' });
    expect(childNodes(tree)[0]!.props.class).toBe('sheet detail-sheet');
  });

  it('closes on a tap on the backdrop itself', () => {
    const { tree, onClose } = sheet();
    fire(tree, 'onClick', { target: tree, currentTarget: tree });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on a tap inside the panel, which reaches the backdrop by bubbling', () => {
    const { tree, onClose } = sheet();
    const panel = childNodes(tree)[0]!;
    fire(tree, 'onClick', { target: panel, currentTarget: tree });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tells a backdrop tap from a bubbled one', () => {
    const backdrop = {} as EventTarget;
    expect(isBackdropTap({ target: backdrop, currentTarget: backdrop })).toBe(true);
    expect(isBackdropTap({ target: {} as EventTarget, currentTarget: backdrop })).toBe(false);
    expect(isBackdropTap({ target: null, currentTarget: backdrop })).toBe(false);
  });
});

describe('SheetHeader', () => {
  it('puts the heading at the left and one ghost action at the right', () => {
    const onAction = vi.fn();
    const tree = SheetHeader({ titleId: 'new-session-title', title: 'New session', actionLabel: 'Cancel', onAction }) as Node;
    expect(tree.type).toBe('header');
    expect(tree.props.class).toBe('sheet-head');
    const [heading, action] = childNodes(tree);
    expect(heading!.type).toBe('h2');
    expect(heading!.props.id).toBe('new-session-title');
    expect(text(heading!.props.children)).toBe('New session');
    expect(action!.props).toMatchObject({ type: 'button', class: 'ghost' });
    expect(text(action!.props.children)).toBe('Cancel');
    fire(action!, 'onClick');
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('groups the title with its subtitle line', () => {
    const tree = SheetHeader({ titleId: 't', title: 'Changes', subtitle: '3 files changed', actionLabel: 'Close', onAction: () => {} }) as Node;
    const group = childNodes(tree)[0]!;
    expect(group.props.class).toBe('detail-title');
    expect(only(group, byType('h2')).props.id).toBe('t');
    const line = only(group, byType('p'));
    expect(line.props.class).toBe('muted small detail-subtitle');
    expect(text(line.props.children)).toBe('3 files changed');
  });

  it('keeps the group but shows no line for an empty subtitle', () => {
    const tree = SheetHeader({ titleId: 't', title: 'Changes', subtitle: '', actionLabel: 'Close', onAction: () => {} }) as Node;
    expect(childNodes(tree)[0]!.props.class).toBe('detail-title');
    expect(allNodes(tree).some(byType('p'))).toBe(false);
  });
});

describe('useCloseOnEscape', () => {
  const realWindow = globalThis.window;
  afterEach(() => {
    globalThis.window = realWindow;
  });

  function key(name: string): Event {
    return Object.assign(new Event('keydown'), { key: name });
  }

  it('closes on Escape only, and stops listening once unmounted', () => {
    const target = new EventTarget();
    globalThis.window = target as Window & typeof globalThis;
    const onClose = vi.fn();
    const host = renderHook(() => useCloseOnEscape(onClose));

    target.dispatchEvent(key('Enter'));
    expect(onClose).not.toHaveBeenCalled();
    target.dispatchEvent(key('Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);

    host.unmount();
    target.dispatchEvent(key('Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
