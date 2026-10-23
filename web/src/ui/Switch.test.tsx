import { describe, expect, it, vi } from 'vitest';

import { childNodes, fire, type Node } from '../../test/vnode';
import { Switch } from './Switch';

describe('Switch', () => {
  it('is a button with the switch role, its state in aria-checked and its label by id', () => {
    const tree = Switch({ checked: true, onChange: () => {}, labelledBy: 'bypass-title' }) as Node;
    expect(tree.type).toBe('button');
    expect(tree.props).toMatchObject({ type: 'button', role: 'switch', class: 'switch', 'aria-checked': true, 'aria-labelledby': 'bypass-title', disabled: false });
    expect(tree.props['aria-describedby']).toBeUndefined();
    const [knob] = childNodes(tree);
    expect(knob!.props).toMatchObject({ class: 'knob', 'aria-hidden': 'true' });
  });

  it('reports off as aria-checked false', () => {
    const tree = Switch({ checked: false, onChange: () => {}, labelledBy: 'l' }) as Node;
    expect(tree.props['aria-checked']).toBe(false);
  });

  it('a tap asks for the other state', () => {
    const onChange = vi.fn();
    fire(Switch({ checked: false, onChange, labelledBy: 'l' }) as Node, 'onClick');
    expect(onChange).toHaveBeenLastCalledWith(true);
    fire(Switch({ checked: true, onChange, labelledBy: 'l' }) as Node, 'onClick');
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('can be described by a status line and disabled while a change is pending', () => {
    const tree = Switch({ checked: true, onChange: () => {}, labelledBy: 'keep-awake-title', describedBy: 'keep-awake-status', disabled: true }) as Node;
    expect(tree.props).toMatchObject({ 'aria-describedby': 'keep-awake-status', disabled: true });
  });
});
