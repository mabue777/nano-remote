// The rules of the shared floating composer (ui/Composer.tsx; docs/research/new-look-prototype.md item 3):
// which round button sits at the right, whether a small Stop stays next to Send, when the "Steers the running
// turn" hint shows, how tall the field is, and which key sends. The session view and local chat both use it.

export interface ComposerInput {
  /** The field's text. */
  draft: string;
  /** Attachments picked for the next message (they count as something to send). */
  attachments: number;
  /** A turn (session) or a reply (local chat) is running. */
  running: boolean;
  /** Send goes into the running turn (steer or queue) instead of waiting; local chat cannot. */
  sendsWhileRunning: boolean;
}

export interface ComposerButtons {
  /** The round button at the right: the arrow (Send) or the filled square (Stop). */
  action: 'send' | 'stop';
  /**
   * A small Stop next to Send: something is typed while a turn runs, so the right button is Send (steer) and
   * Stop must stay reachable. The lab has one button only; this keeps Stop one tap away.
   */
  smallStop: boolean;
  /** Show the run hint ("Steers the running turn" or the queue wording) above the field. */
  hint: boolean;
}

export function hasContent(input: Pick<ComposerInput, 'draft' | 'attachments'>): boolean {
  return input.draft.trim() !== '' || input.attachments > 0;
}

export function composerButtons(input: ComposerInput): ComposerButtons {
  if (!input.running) return { action: 'send', smallStop: false, hint: false };
  if (input.sendsWhileRunning && hasContent(input)) return { action: 'send', smallStop: true, hint: true };
  return { action: 'stop', smallStop: false, hint: false };
}

/** The field grows with its lines, one to six; past that it scrolls. */
export function composerRows(draft: string): number {
  return Math.min(6, Math.max(1, draft.split('\n').length));
}

/** Enter makes a new line; Cmd-Enter or Ctrl-Enter sends (a hardware keyboard on the iPad or the Mac). */
export function isSendShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey);
}
