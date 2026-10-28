// The comment sheet of the markup cover (docs/plan/image-markup.md, ticket 3): the app's bottom sheet with one
// field ("What about this spot?") and Save, Delete and Cancel. It opens for a new pin (no Delete) or for an
// existing one. It rides on the iOS keyboard the way the composer does (interaction lab technique 7): its layer
// takes the visible area above the keyboard (visualViewport) and follows it while iOS scrolls the page, so the
// field and Save stay in view over the full-screen canvas. Enter saves; a comment is one line in the sent text.
// The field takes focus on mount; the cover focused a stand-in field inside the tap, so iOS keeps its keyboard
// up (it only opens one for a focus inside a touch). Styles: .markup-comment* in markup.css.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { watchViewport } from '../../../lab/viewport';
import { Sheet, SheetHeader, useCloseOnEscape } from '../../../ui/Sheet';
import { cleanComment } from './comments';

export interface CommentSheetProps {
  /** The pin's number, as drawn on it. */
  number: number;
  /** The comment so far; empty for a new pin. */
  comment: string;
  /** A new pin: no Delete, and Cancel drops the pin. */
  isNew: boolean;
  onSave: (comment: string) => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function CommentSheet({ number, comment, isNew, onSave, onDelete, onCancel }: CommentSheetProps) {
  const [text, setText] = useState(comment);
  const field = useRef<HTMLTextAreaElement>(null);
  const clean = cleanComment(text);
  const save = () => clean !== '' && onSave(clean);
  useCloseOnEscape(onCancel);
  useLayoutEffect(() => {
    const el = field.current;
    if (el === null) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <KeyboardLayer>
      <Sheet labelledBy="markup-comment-title" class="markup-sheet markup-comment" onClose={onCancel}>
        <SheetHeader titleId="markup-comment-title" title={`Comment ${number}`} actionLabel="Cancel" onAction={onCancel} />
        <textarea
          ref={field}
          class="markup-comment-field"
          rows={3}
          value={text}
          placeholder="What about this spot?"
          aria-label={`Comment ${number}`}
          enterkeyhint="done"
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              save();
            }
          }}
        />
        <div class="actions markup-comment-actions">
          {!isNew && (
            <button type="button" class="small ghost markup-comment-delete" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="button" class="small primary" disabled={clean === ''} onClick={save}>
            Save
          </button>
        </div>
      </Sheet>
    </KeyboardLayer>
  );
}

/** A layer over the cover that is the visible area above the keyboard; a sheet inside sits on the keyboard. */
export function KeyboardLayer({ children }: { children: ComponentChildren }) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = layer.current;
    if (el === null) return;
    return watchViewport(window, (box) => {
      el.style.setProperty('--markup-vvh', `${box.height}px`);
      el.style.setProperty('--markup-vvtop', `${box.offsetTop}px`);
    });
  }, []);
  return (
    <div ref={layer} class="markup-keyboard">
      {children}
    </div>
  );
}
