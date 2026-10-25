// The floating composer (docs/research/new-look-prototype.md item 3), shared by the session view, local chat
// and the lab's New look: a raised rounded card above the bottom edge with a round + at the left (only where
// attachments are offered) and one round button at the right, the arrow (Send) when there is something to
// send or the filled square (Stop) while a turn or reply runs. Typing into a running turn that takes input
// shows the run hint above the card, the right button becomes Send (Steer or Queue) and a small Stop stays
// next to it. The rules are in composer-rules.ts; styles in Composer.css.
//
// The card floats over the transcript: the bar writes its height to `--composer-height` on its parent (the
// page), which pads the conversation by that much and lifts the jump pill above the card.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { composerButtons, composerRows, isSendShortcut } from './composer-rules';
import { Icon } from './Icon';
import { hapticTick } from './motion/haptic';

export interface ComposerStop {
  onStop: () => void;
  /** Stop cannot be tapped now (no turn to stop yet, or one is stopping). */
  disabled?: boolean;
  /** A stop was asked for and has not landed yet. */
  busy?: boolean;
}

export interface ComposerAttach {
  /** The + button's name. */
  label?: string;
  /** The file picker's `accept` ('' takes anything). */
  accept?: string;
  /** Picked files; with it the + opens the system file picker. */
  onPick?: (files: File[]) => void;
  /** Without onPick, the + calls this instead (the lab opens a sheet). */
  onOpen?: () => void;
}

export interface ComposerProps {
  draft: string;
  placeholder: string;
  onDraft: (text: string) => void;
  /** Whether Send does something now; the arrow is greyed out otherwise. */
  canSend: boolean;
  /** Send, Steer or Queue: from the button (with the haptic tick) or Cmd/Ctrl-Enter. Only called when canSend. */
  onSend: () => void;
  /** The send button's name. */
  sendLabel?: string;
  /** A turn or reply is running: the right button is Stop while there is nothing to send into it. */
  running: boolean;
  /** Send goes into the running turn (steer or queue); local chat cannot, so Stop stays. */
  sendsWhileRunning?: boolean;
  /** Shown above the card while typing into a running turn ("Steers the running turn"). */
  runHint?: string;
  /** Attachments picked for the next message: they count as something to send. */
  attachments?: number;
  stop?: ComposerStop;
  attach?: ComposerAttach;
  /** The field cannot take text (a closed session, a missing chat). */
  disabled?: boolean;
  onFocus?: () => void;
  /** The haptic tick on Send (default on); the lab plays its own behind its switch. */
  haptic?: boolean;
  /** Lines above the card: usage, notes, errors, pinned questions. */
  above?: ComponentChildren;
  /** Inside the card above the field: the picked attachments. */
  tray?: ComponentChildren;
}

export function Composer(props: ComposerProps) {
  const { draft, canSend, onSend, running, stop, attach } = props;
  const bar = useRef<HTMLElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => (bar.current === null ? undefined : trackHeight(bar.current)), []);
  const buttons = composerButtons({ draft, attachments: props.attachments ?? 0, running, sendsWhileRunning: props.sendsWhileRunning === true });
  const sendLabel = props.sendLabel ?? 'Send';
  const send = () => {
    if (canSend) onSend();
  };
  return (
    <footer class="composer-bar" ref={bar}>
      {props.above}
      {buttons.hint && props.runHint !== undefined && <p class="composer-hint">{props.runHint}</p>}
      <form
        class="composer-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend && props.haptic !== false) hapticTick(); // inside the tap, where iOS allows it
          send();
        }}
      >
        {props.tray}
        <div class="composer-row">
          {attach !== undefined && (
            <>
              <button
                type="button"
                class="composer-round composer-add"
                aria-label={attach.label ?? 'Attach photos or files'}
                title={attach.label ?? 'Attach photos or files'}
                onClick={() => (attach.onPick !== undefined ? picker.current?.click() : attach.onOpen?.())}
              >
                <Icon name="plus" size={22} />
              </button>
              {attach.onPick !== undefined && (
                <input
                  ref={picker}
                  class="composer-file"
                  type="file"
                  multiple
                  accept={attach.accept === '' ? undefined : attach.accept}
                  aria-hidden="true"
                  tabIndex={-1}
                  onChange={(event) => {
                    const input = event.currentTarget as HTMLInputElement;
                    attach.onPick!([...(input.files ?? [])]);
                    input.value = ''; // the same file can be picked again
                  }}
                />
              )}
            </>
          )}
          <textarea
            aria-label="Message"
            rows={composerRows(draft)}
            placeholder={props.placeholder}
            value={draft}
            disabled={props.disabled === true}
            onInput={(event) => props.onDraft((event.currentTarget as HTMLTextAreaElement).value)}
            onFocus={props.onFocus}
            onKeyDown={(event) => {
              if (!isSendShortcut(event)) return;
              event.preventDefault();
              send();
            }}
          />
          {/* Keyed, so a tap on Stop never lands on the Send that replaces it (that would submit the form). */}
          {buttons.smallStop && stop !== undefined && stopButton(stop, true)}
          {buttons.action === 'stop' && stop !== undefined ? (
            stopButton(stop, false)
          ) : (
            <button key="send" type="submit" class="composer-round composer-send" aria-label={sendLabel} title={sendLabel} disabled={!canSend}>
              <Icon name="send" size={18} />
            </button>
          )}
        </div>
      </form>
    </footer>
  );
}

function stopButton(stop: ComposerStop, small: boolean) {
  const label = stop.busy === true ? 'Stopping…' : 'Stop';
  return (
    <button
      key={small ? 'small-stop' : 'stop'}
      type="button"
      class={`composer-round composer-stop${small ? ' small' : ''}`}
      aria-label={label}
      title={label}
      disabled={stop.disabled === true}
      onClick={() => stop.onStop()}
    >
      {stop.busy === true ? <Icon name="spinner" size={small ? 16 : 18} class="spin" /> : <Icon name="stop" size={small ? 14 : 18} />}
    </button>
  );
}

interface HeightTarget {
  offsetHeight: number;
  parentElement: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } } | null;
}

/**
 * Writes the bar's height to `--composer-height` on its parent now and whenever it changes (a second line,
 * the hint, the attachment chips), so the transcript's last message ends above the card. Returns the cleanup.
 */
export function trackHeight(bar: HeightTarget, Observer: typeof ResizeObserver | undefined = globalThis.ResizeObserver): () => void {
  const page = bar.parentElement;
  if (page === null) return () => {};
  const write = () => page.style.setProperty('--composer-height', `${bar.offsetHeight}px`);
  write();
  const observer = Observer === undefined ? undefined : new Observer(write);
  observer?.observe(bar as unknown as Element);
  return () => {
    observer?.disconnect();
    page.style.removeProperty('--composer-height');
  };
}
