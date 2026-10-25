import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '../../test/hook-host';
import { allNodes, byType, childNodes, fire, only, text, type Node } from '../../test/vnode';
import { Composer, trackHeight, type ComposerProps } from './Composer';
import { Icon } from './Icon';

vi.mock('preact/hooks', async () => (await import('../../test/hook-host')).hooks);
const tick = vi.hoisted(() => vi.fn());
vi.mock('./motion/haptic', () => ({ hapticTick: tick }));

afterEach(() => tick.mockClear());

function composer(props: Partial<ComposerProps> = {}) {
  const onSend = vi.fn();
  const onDraft = vi.fn();
  const host = renderHook(() => Composer({ draft: '', placeholder: 'Message the agent…', onDraft, canSend: false, onSend, running: false, ...props }) as Node);
  const tree = host.value;
  const buttons = allNodes(tree).filter(byType('button'));
  const named = (name: string) => buttons.find((b) => b.props['aria-label'] === name);
  return { tree, onSend, onDraft, buttons, named, host };
}

const submit = () => ({ preventDefault: vi.fn() });

describe('Composer', () => {
  it('is the floating bar holding the card: field and the round Send arrow, greyed out while empty', () => {
    const { tree, buttons, named } = composer();
    expect(tree.type).toBe('footer');
    expect(tree.props.class).toBe('composer-bar');
    const form = only(tree, byType('form'));
    expect(form.props.class).toBe('composer-card');
    const field = only(tree, byType('textarea'));
    expect(field.props).toMatchObject({ 'aria-label': 'Message', placeholder: 'Message the agent…', rows: 1, value: '', disabled: false });
    expect(buttons).toHaveLength(1);
    const send = named('Send')!;
    expect(send.props).toMatchObject({ type: 'submit', class: 'composer-round composer-send', disabled: true });
    expect(childNodes(send)[0]!.props.name).toBe('send');
    expect(childNodes(send)[0]!.type).toBe(Icon);
  });

  it('Send ticks and sends when there is something to send; never while it cannot', () => {
    const ready = composer({ draft: 'hi', canSend: true });
    const event = submit();
    fire(only(ready.tree, byType('form')), 'onSubmit', event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(ready.onSend).toHaveBeenCalledTimes(1);
    expect(ready.named('Send')!.props.disabled).toBe(false);

    const blocked = composer({ draft: 'hi', canSend: false });
    fire(only(blocked.tree, byType('form')), 'onSubmit', submit());
    expect(blocked.onSend).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('the lab plays its own tick: haptic off sends without one', () => {
    const { tree, onSend } = composer({ draft: 'hi', canSend: true, haptic: false });
    fire(only(tree, byType('form')), 'onSubmit', submit());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
  });

  it('typing reports the text; the field grows with its lines; it can be disabled', () => {
    const { tree, onDraft } = composer({ draft: 'a\nb', disabled: true });
    const field = only(tree, byType('textarea'));
    expect(field.props.rows).toBe(2);
    expect(field.props.disabled).toBe(true);
    fire(field, 'onInput', { currentTarget: { value: 'abc' } });
    expect(onDraft).toHaveBeenCalledWith('abc');
  });

  it('Cmd/Ctrl-Enter sends without a tick; Enter alone makes a new line', () => {
    const { tree, onSend } = composer({ draft: 'hi', canSend: true });
    const field = only(tree, byType('textarea'));
    const plain = { key: 'Enter', metaKey: false, ctrlKey: false, preventDefault: vi.fn() };
    fire(field, 'onKeyDown', plain);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    const shortcut = { key: 'Enter', metaKey: true, ctrlKey: false, preventDefault: vi.fn() };
    fire(field, 'onKeyDown', shortcut);
    expect(shortcut.preventDefault).toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
  });

  it('running with an empty field: the filled square Stop replaces Send', () => {
    const onStop = vi.fn();
    const { buttons, named } = composer({ running: true, sendsWhileRunning: true, stop: { onStop } });
    expect(buttons).toHaveLength(1);
    const stop = named('Stop')!;
    expect(stop.props).toMatchObject({ type: 'button', class: 'composer-round composer-stop', disabled: false });
    expect(childNodes(stop)[0]!.props.name).toBe('stop');
    fire(stop, 'onClick');
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('typing into a running turn: the hint shows, Send is named for what it does, a small Stop stays', () => {
    const { tree, buttons, named } = composer({ running: true, sendsWhileRunning: true, draft: 'also', canSend: true, sendLabel: 'Steer', runHint: 'Steers the running turn', stop: { onStop: () => {} } });
    expect(text(only(tree, (n) => n.props.class === 'composer-hint').props.children)).toBe('Steers the running turn');
    expect(buttons.map((b) => b.props['aria-label'])).toEqual(['Stop', 'Steer']);
    expect(named('Stop')!.props.class).toBe('composer-round composer-stop small');
    expect(named('Steer')!.props.type).toBe('submit');
  });

  it('no hint text given: none shows', () => {
    const { tree } = composer({ running: true, sendsWhileRunning: true, draft: 'also', stop: { onStop: () => {} } });
    expect(allNodes(tree).some((n) => n.props.class === 'composer-hint')).toBe(false);
  });

  it('local chat: typing while a reply streams keeps Stop as the one button', () => {
    const { buttons } = composer({ running: true, draft: 'next', stop: { onStop: () => {} } });
    expect(buttons.map((b) => b.props['aria-label'])).toEqual(['Stop']);
  });

  it('a stop on its way: disabled, says Stopping…, spins', () => {
    const { named } = composer({ running: true, stop: { onStop: () => {}, disabled: true, busy: true } });
    const stop = named('Stopping…')!;
    expect(stop.props.disabled).toBe(true);
    expect(childNodes(stop)[0]!.props).toMatchObject({ name: 'spinner', class: 'spin' });
  });

  it('running without a stop handler: Send stays', () => {
    const { named } = composer({ running: true });
    expect(named('Send')).toBeDefined();
  });

  it('attachments: the round + opens the file picker; picked files go up and the picker is reset', () => {
    const onPick = vi.fn();
    const { tree, named, host } = composer({ attach: { accept: 'image/*', onPick }, attachments: 1, canSend: true });
    const add = named('Attach photos or files')!;
    expect(add.props.class).toBe('composer-round composer-add');
    const input = only(tree, byType('input'));
    expect(input.props).toMatchObject({ type: 'file', multiple: true, accept: 'image/*', 'aria-hidden': 'true', tabIndex: -1 });
    // the picker ref is the second ref of the component
    const click = vi.fn();
    (host.slots[1] as { current: unknown }).current = { click };
    fire(add, 'onClick');
    expect(click).toHaveBeenCalledTimes(1);
    const file = { name: 'a.png' };
    const target = { files: [file], value: 'C:\\fakepath\\a.png' };
    fire(input, 'onChange', { currentTarget: target });
    expect(onPick).toHaveBeenCalledWith([file]);
    expect(target.value).toBe('');
    fire(input, 'onChange', { currentTarget: { files: null, value: '' } });
    expect(onPick).toHaveBeenLastCalledWith([]);
  });

  it('attachments: an empty accept takes anything; a custom label; an attachment alone makes Send the button while running', () => {
    const { tree, named } = composer({ attach: { accept: '', onPick: () => {}, label: 'Add' }, running: true, sendsWhileRunning: true, attachments: 1, stop: { onStop: () => {} } });
    expect(only(tree, byType('input')).props.accept).toBeUndefined();
    expect(named('Add')).toBeDefined();
    expect(named('Send')).toBeDefined();
  });

  it('the + without a picker calls onOpen (the lab opens a sheet)', () => {
    const onOpen = vi.fn();
    const { tree, named } = composer({ attach: { label: 'Add files', onOpen } });
    expect(allNodes(tree).some(byType('input'))).toBe(false);
    fire(named('Add files')!, 'onClick');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('puts the lines above the card and the tray inside it, before the field', () => {
    const { tree } = composer({ above: <p class="usage">usage</p>, tray: <div class="attach-tray">tray</div> });
    const [usage, form] = childNodes(tree);
    expect(usage!.props.class).toBe('usage');
    const [tray, row] = childNodes(form!);
    expect(tray!.props.class).toBe('attach-tray');
    expect(row!.props.class).toBe('composer-row');
  });

  it('tracks its height once mounted', () => {
    const { host } = composer();
    const set = vi.fn();
    (host.slots[0] as { current: unknown }).current = { offsetHeight: 90, parentElement: { style: { setProperty: set, removeProperty: () => {} } } };
    host.slots.splice(2); // forget the effect so it runs again with the element in place
    host.render();
    expect(set).toHaveBeenCalledWith('--composer-height', '90px');
  });
});

describe('trackHeight', () => {
  it('writes the height to the page now and on every resize, and removes it on cleanup', () => {
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const bar = { offsetHeight: 80, parentElement: { style } };
    let resize = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    class Observer {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe = observe;
      disconnect = disconnect;
    }
    const cleanup = trackHeight(bar, Observer as unknown as typeof ResizeObserver);
    expect(style.setProperty).toHaveBeenLastCalledWith('--composer-height', '80px');
    expect(observe).toHaveBeenCalledWith(bar);
    bar.offsetHeight = 104;
    resize();
    expect(style.setProperty).toHaveBeenLastCalledWith('--composer-height', '104px');
    cleanup();
    expect(disconnect).toHaveBeenCalled();
    expect(style.removeProperty).toHaveBeenCalledWith('--composer-height');
  });

  it('without ResizeObserver it writes once; without a page it does nothing', () => {
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    trackHeight({ offsetHeight: 60, parentElement: { style } }, undefined)();
    expect(style.setProperty).toHaveBeenCalledTimes(1);
    expect(style.removeProperty).toHaveBeenCalledTimes(1);
    expect(() => trackHeight({ offsetHeight: 60, parentElement: null })()).not.toThrow();
  });
});
