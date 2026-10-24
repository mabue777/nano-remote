import { afterEach, describe, expect, it } from 'vitest';

import { hapticTick, type HapticDocument } from './haptic';

function fakeDocument(calls: string[]) {
  const input = { type: '', setAttribute: (n: string) => calls.push(`input ${n}`) };
  const label = {
    style: { cssText: '' },
    setAttribute: (n: string, v: string) => calls.push(`label ${n}=${v}`),
    appendChild: () => calls.push('append input'),
    click: () => calls.push('click'),
  };
  const doc = {
    createElement: (tag: string) => (tag === 'label' ? label : input),
    body: { appendChild: () => calls.push('attach'), removeChild: () => calls.push('detach') },
  } as unknown as HapticDocument;
  return { doc, input, label };
}

describe('hapticTick', () => {
  const realDocument = globalThis.document;
  afterEach(() => {
    globalThis.document = realDocument;
  });

  it('clicks the label of a hidden switch input and removes it again', () => {
    const calls: string[] = [];
    const { doc, input, label } = fakeDocument(calls);
    hapticTick(doc);
    expect(input.type).toBe('checkbox');
    expect(calls).toEqual(['input switch', 'label aria-hidden=true', 'append input', 'attach', 'click', 'detach']);
    expect(label.style.cssText).toContain('opacity:0');
  });

  it('gives the focus back to the field that had it', () => {
    const calls: string[] = [];
    const { doc } = fakeDocument(calls);
    const field = { focus: (options: unknown) => calls.push(`focus ${JSON.stringify(options)}`) };
    let active: unknown = field;
    Object.defineProperty(doc, 'activeElement', { get: () => active });
    (doc.body as unknown as { appendChild: () => void }).appendChild = () => {
      calls.push('attach');
      active = null; // the click moved the focus away
    };
    hapticTick(doc);
    expect(calls.slice(-2)).toEqual(['detach', 'focus {"preventScroll":true}']);

    calls.length = 0;
    active = field; // the focus stayed put: nothing to give back
    (doc.body as unknown as { appendChild: () => void }).appendChild = () => calls.push('attach');
    hapticTick(doc);
    expect(calls.at(-1)).toBe('detach');
  });

  it('uses the page document by default', () => {
    const calls: string[] = [];
    globalThis.document = fakeDocument(calls).doc as unknown as Document;
    hapticTick();
    expect(calls).toContain('click');
  });

  it('does nothing without a document', () => {
    expect(globalThis.document).toBeUndefined();
    expect(() => hapticTick()).not.toThrow();
    expect(() => hapticTick(undefined)).not.toThrow();
  });
});
