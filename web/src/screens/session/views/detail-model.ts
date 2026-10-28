// The item detail sheet: opened from any item in the turn list, it hosts two review views.
//
// - Output (command items only): the command's output as plain text (cleanOutput: ANSI codes stripped,
//   carriage-return redraws settled). It grows as `item/delta` events reach the Replica; while the command
//   runs the view follows the end unless the user scrolled up. A copy button puts the text on the clipboard.
// - Changes (every item): the Changes view of the item's turn (ChangesModel): the files the turn changed,
//   then one file's diff at a time.
//
// - A file change item's Changes show its own diff (the adapter's `changes[].diff`), one section per file,
//   whether or not git sees the file. Only an item without any diff text falls back to its turn's Changes.
//
// Command items open on Output, every other item on Changes. When the agent's capabilities say it provides
// no diffs (spec 4), there is no turn Changes view: a command shows only its output, a file change item
// only its own diff, and other items have no detail sheet (the session view does not offer one).
import type { Item } from '../../../replica/types';
import { errorText, Model } from '../../model';
import { commandSummary, oneLine, unwrapShell } from '../session-model';
import { cleanOutput } from './ansi';
import { agentFile, ChangesModel, type ChangedFile, type ChangesReplica } from './changes-model';

/** What the detail sheet needs from the Replica; Replica fits. */
export type DetailReplica = ChangesReplica;

/** The clipboard as the copy button needs it; navigator.clipboard fits. */
export interface Clipboard {
  writeText(text: string): Promise<void>;
}

export type DetailTab = 'output' | 'changes';

/** How long the copy button says "Copied". */
const COPIED_MS = 2000;

const TITLES: Record<string, string> = {
  userMessage: 'Your message',
  agentMessage: 'Agent message',
  reasoning: 'Thinking',
  command: 'Command',
  fileChange: 'File change',
  toolCall: 'Tool call',
  plan: 'Plan',
};

export interface ItemDetailModelOptions {
  sessionId: string;
  itemId: string;
  replica: DetailReplica;
  clipboard?: Clipboard;
  /** The agent provides turn diffs (default true: an older host sends no capabilities). */
  diffs?: boolean;
}

export class ItemDetailModel extends Model {
  readonly sessionId: string;
  readonly itemId: string;
  tab: DetailTab;
  /** False once the user scrolled up in the output; the view stops following the end then. */
  following = true;
  copied = false;
  copyError: string | undefined;
  /** The Changes view of the item's turn. */
  readonly changes: ChangesModel;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly replica: DetailReplica;
  private readonly clipboard: Clipboard | undefined;
  private readonly diffs: boolean;
  private readonly unsubscribe: (() => void)[];

  constructor(options: ItemDetailModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.itemId = options.itemId;
    this.replica = options.replica;
    this.clipboard = options.clipboard;
    this.diffs = options.diffs ?? true;
    this.tab = this.item?.type === 'command' || (!this.diffs && this.ownChanges.length === 0) ? 'output' : 'changes';
    this.changes = new ChangesModel({ sessionId: this.sessionId, turnId: this.item?.turnId, replica: this.replica });
    this.unsubscribe = [this.replica.subscribe(() => this.changed()), this.changes.subscribe(() => this.changed())];
  }

  /** Fetches the diff when the sheet opens on Changes. */
  start(): void {
    if (this.tab === 'changes' && this.ownChanges.length === 0) this.changes.start();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.changes.dispose();
    clearTimeout(this.copiedTimer);
  }

  // ---- reading ----------------------------------------------------------------------------------

  get item(): Item | undefined {
    return this.replica.session(this.sessionId)?.items[this.itemId];
  }

  get turnId(): string | undefined {
    return this.item?.turnId;
  }

  get title(): string {
    const type = this.item?.type;
    return type === undefined ? 'Item' : (TITLES[type] ?? 'Other activity');
  }

  /** One line naming the item: the command, the tool, the first line of a message. */
  get subtitle(): string {
    const item = this.item;
    switch (item?.type) {
      case 'command':
        return commandSummary(item);
      case 'toolCall':
        return item.server !== undefined && item.server !== '' ? `${item.server}/${item.tool}` : item.tool;
      case 'agentMessage':
      case 'plan':
        return oneLine(item.text);
      case 'reasoning':
        return oneLine(item.summary);
      case 'fileChange':
        return item.changes.map((c) => c.path).join(', ');
      case 'userMessage':
        return oneLine(item.content.map((p) => (p.type === 'text' ? p.text : p.type === 'mention' ? `@${p.name}` : '')).join(' '));
      default:
        return '';
    }
  }

  /**
   * A file change item's own changes, one per file, as the agent sent them; empty when the item is not a
   * file change or none of its changes has diff text (the turn's Changes are shown then).
   */
  get ownChanges(): ChangedFile[] {
    const item = this.item;
    if (item?.type !== 'fileChange' || !item.changes.some((c) => c.diff.trim() !== '')) return [];
    return item.changes.map((c) => agentFile(c.path, [c]));
  }

  get tabs(): DetailTab[] {
    const changes: DetailTab[] = this.diffs || this.ownChanges.length > 0 ? ['changes'] : [];
    return this.item?.type === 'command' ? ['output', ...changes] : changes;
  }

  /** The full command (shell wrapper removed) and its folder, for the output view's header. */
  get command(): { text: string; cwd: string } | undefined {
    const item = this.item;
    return item?.type === 'command' ? { text: unwrapShell(item.command), cwd: item.cwd } : undefined;
  }

  get output(): string {
    const item = this.item;
    return item?.type === 'command' ? cleanOutput(item.output) : '';
  }

  /** True while the command runs: its output still grows. */
  get running(): boolean {
    return this.item?.status === 'inProgress';
  }

  // ---- actions ----------------------------------------------------------------------------------

  selectTab(tab: DetailTab): void {
    if (tab === this.tab || !this.tabs.includes(tab)) return;
    this.tab = tab;
    this.changed();
    if (tab === 'changes' && this.ownChanges.length === 0) this.changes.start();
  }

  /** The output view reports whether it is scrolled to the end. */
  setFollowing(following: boolean): void {
    if (following === this.following) return;
    this.following = following;
    this.changed();
  }

  /** Copies the shown output (plain text) to the clipboard. */
  async copy(): Promise<void> {
    this.copyError = undefined;
    try {
      if (this.clipboard === undefined) throw new Error('The clipboard is not available here.');
      await this.clipboard.writeText(this.output);
      this.copied = true;
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.copied = false;
        this.changed();
      }, COPIED_MS);
    } catch (error) {
      this.copied = false;
      this.copyError = `Could not copy: ${errorText(error)}`;
    }
    this.changed();
  }
}
