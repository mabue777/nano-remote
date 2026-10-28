// The session's Permissions sheet: change the approval mode of an open session (spec 6
// session/settings/update `approvalMode`), opened from the Permissions row of the ⋯ details sheet when the
// agent can change it (capabilities.settingsUpdate names approvalMode and capabilities.approvalModes lists
// modes). Each mode the agent lists is one row in plain words with the current one marked. Choosing full
// access (`never`) asks first, in the same words as the New session sheet's "Bypass approvals" row; any
// other mode switches at once. The sheet stays open on the mode the host answered with and, when the host
// says the change waits for the next turn (`appliesAt: "nextTurn"`, or an older host without it), shows
// "Applies from the next turn".
import type { SessionSettingsUpdateParams, SessionSettingsUpdateResult } from '../../generated/methods';
import { errorText, Model } from '../model';
import { ASKS_FIRST, FULL_ACCESS } from './session-details';

/** The approval mode that bypasses every approval (spec 5.1). */
export const BYPASS_MODE = 'never';

/** The footnote when the change waits for the next turn. */
export const APPLIES_NEXT_TURN = 'Applies from the next turn';

/** The New session sheet's words for full access, and its warning. */
export const BYPASS_TITLE = 'Bypass approvals (full access)';
export const BYPASS_WARNING = 'The agent runs every command and edit without asking, anywhere your user account can reach.';

export interface ModeWords {
  /** The row's title in the sheet. */
  title: string;
  /** One line under it: what the agent does in this mode. */
  detail: string;
  /** The Permissions row's value in the ⋯ sheet. */
  short: string;
}

/** Codex approval policies and Claude Code permission modes (spec 5.1), in plain words. */
const WORDS: Readonly<Record<string, ModeWords>> = {
  // Codex
  untrusted: { title: 'Ask for most commands', detail: 'Runs only commands known to be safe, like reading files; asks before anything else.', short: 'Asks for most commands' },
  'on-failure': { title: 'Ask when a command fails', detail: 'Runs commands in the sandbox; asks before retrying one that failed there.', short: 'Asks when a command fails' },
  'on-request': { title: 'Ask when it needs more access', detail: 'Works inside the folder; asks before going outside it or online.', short: ASKS_FIRST },
  // Claude Code
  default: { title: 'Ask before running', detail: 'Asks before every command and file edit.', short: ASKS_FIRST },
  acceptEdits: { title: 'Accept edits', detail: 'Edits files without asking; asks before running commands.', short: 'Accepts edits' },
  plan: { title: 'Plan only', detail: 'Reads and plans; changes nothing until you approve the plan.', short: 'Plans only' },
  // Both
  [BYPASS_MODE]: { title: BYPASS_TITLE, detail: BYPASS_WARNING, short: FULL_ACCESS },
};

/** The words for a mode; a mode this app does not know is shown by its name. */
export function modeWords(mode: string): ModeWords {
  return WORDS[mode] ?? { title: mode, detail: '', short: mode };
}

/** The Permissions row's value: the mode in effect, or "Asks before running" when the session names none. */
export function permissionsValue(mode: string | undefined): string {
  return mode === undefined ? ASKS_FIRST : modeWords(mode).short;
}

/** What the sheet needs from the Replica; Replica fits. */
export interface PermissionsReplica {
  updateSettings(sessionId: string, settings: SessionSettingsUpdateParams['settings']): Promise<SessionSettingsUpdateResult>;
}

export interface PermissionsOptions {
  sessionId: string;
  /** The agent's capabilities.approvalModes, in its order. */
  modes: readonly string[];
  /** Session.settings.approvalMode as the session reports it now. */
  current: string | undefined;
  replica: PermissionsReplica;
}

export interface ModeRow extends ModeWords {
  mode: string;
  current: boolean;
  /** Full access: the row is red, like the New session sheet's bypass row when on. */
  danger: boolean;
}

export class PermissionsModel extends Model {
  /** The mode in effect, as the host last answered. */
  current: string | undefined;
  /** Full access waits for the confirmation. */
  confirming = false;
  saving = false;
  error: string | undefined;
  /** The last change waits for the next turn. */
  nextTurn = false;
  private readonly options: PermissionsOptions;

  constructor(options: PermissionsOptions) {
    super();
    this.options = options;
    this.current = options.current;
  }

  get rows(): ModeRow[] {
    return this.options.modes.map((mode) => ({ mode, ...modeWords(mode), current: mode === this.current, danger: mode === BYPASS_MODE }));
  }

  get note(): string | undefined {
    return this.nextTurn ? APPLIES_NEXT_TURN : undefined;
  }

  /**
   * A tap on a mode: the current one does nothing, full access asks first (resolves false), any other
   * switches. Resolves true once the host took the change.
   */
  async choose(mode: string): Promise<boolean> {
    if (this.saving || mode === this.current || !this.options.modes.includes(mode)) return false;
    if (mode === BYPASS_MODE) {
      this.confirming = true;
      this.changed();
      return false;
    }
    return this.save(mode);
  }

  /** "Allow full access" in the confirmation. */
  async confirmBypass(): Promise<boolean> {
    if (!this.confirming) return false;
    this.confirming = false;
    return this.save(BYPASS_MODE);
  }

  cancelConfirm(): void {
    if (!this.confirming) return;
    this.confirming = false;
    this.changed();
  }

  private async save(mode: string): Promise<boolean> {
    this.saving = true;
    this.error = undefined;
    this.changed();
    try {
      const { session, appliesAt } = await this.options.replica.updateSettings(this.options.sessionId, { approvalMode: mode });
      const reported = session.settings.approvalMode;
      this.current = typeof reported === 'string' ? reported : mode;
      // An older host says nothing: the change is safe to expect from the next turn (spec 6).
      this.nextTurn = appliesAt !== 'now';
      return true;
    } catch (error) {
      this.error = `Could not change the permissions: ${errorText(error)}`;
      return false;
    } finally {
      this.saving = false;
      this.changed();
    }
  }
}
