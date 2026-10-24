// The iOS 18 haptic trick (interaction lab technique 10): a light system tick on Accept and Send.

export interface HapticDocument {
  createElement(tag: 'label'): HTMLLabelElement;
  createElement(tag: 'input'): HTMLInputElement;
  body: { appendChild(node: Node): unknown; removeChild(node: Node): unknown };
  activeElement?: Element | null;
}

/**
 * A light haptic tick on iPhone (iOS 18+): Safari plays the system tick when a `<input type="checkbox" switch>`
 * is toggled by a tap on its label. Must run inside the tap's handler. Elsewhere it does nothing visible, and
 * without a document (tests, workers) it does nothing at all. Undocumented by Apple, so it can stop working in
 * any release. The focused field keeps its focus (Send must not close the keyboard).
 */
export function hapticTick(doc: HapticDocument | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (doc === undefined) return;
  const label = doc.createElement('label');
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none';
  label.appendChild(input);
  const focused = doc.activeElement;
  doc.body.appendChild(label);
  label.click();
  doc.body.removeChild(label);
  if (focused != null && focused !== doc.activeElement) (focused as HTMLElement).focus({ preventScroll: true });
}
