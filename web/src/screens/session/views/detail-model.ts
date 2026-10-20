// The item detail sheet: opened from any item in the turn list, it hosts two review views.
//
// - Output (command items only): the command's output as plain text (cleanOutput: ANSI codes stripped,
//   carriage-return redraws settled). It grows as `item/delta` events reach the Replica; while the command
//   runs the view follows the end unless the user scrolled up. A copy button puts the text on the clipboard.
// - Changes (every item): turn/diff for the item's turn, one collapsible section per file with its kind and
//   +/- counts. `not_supported` means the agent does not provide diffs. The diff is fetched again when the
//   turn's status changes (a running turn's diff is not final).
//
// Command items open on Output, every other item on Changes.
import type { TurnDiffResult } from '../../../generated/methods';
import type { Item, SessionView } from '../../../replica/types';
import { errorText, Model } from '../../model';
import { commandSummary, oneLine, unwrapShell } from '../session-model';
import { cleanOutput } from './ansi';
import { FILE_KIND_LABEL, fileKind, parseUnifiedDiff, type DiffLine, type FileKind } from './diff';

/** What the detail sheet needs from the Replica; Replica fits. */
export interface DetailReplica {
  session(sessionId: string): SessionView | undefined;
  subscribe(listener: () => void): () => void;
  turnDiff(sessionId: string, turnId: string): Promise<TurnDiffResult>;
}

/** The clipboard as the copy button needs it; navigator.clipboard fits. */
export interface Clipboard {
  writeText(text: string): Promise<void>;
}

export type DetailTab = 'output' | 'changes';

export interface DiffFileRow {
  path: string;
  kind: FileKind;
  label: string;
  renamedFrom?: string;
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
  expanded: boolean;
}

export type DiffState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; files: DiffFileRow[] }
  | { state: 'unsupported' }
  | { state: 'error'; message: string };

export const NOT_SUPPORTED_TEXT = 'This agent does not provide diffs.';

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
}

export class ItemDetailModel extends Model {
  readonly sessionId: string;
  readonly itemId: string;
  tab: DetailTab;
  /** False once the user scrolled up in the output; the view stops following the end then. */
  following = true;
  copied = false;
  copyError: string | undefined;
  private diffState: DiffState = { state: 'idle' };
  private files: { path: string; kind: FileKind; renamedFrom?: string; added: number; removed: number; binary: boolean; lines: DiffLine[] }[] = [];
  private readonly expanded = new Set<string>();
  /** The turn status the shown diff was fetched for. */
  private diffFor: string | undefined;
  private diffRequest = 0;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly replica: DetailReplica;
  private readonly clipboard: Clipboard | undefined;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(options: ItemDetailModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.itemId = options.itemId;
    this.replica = options.replica;
    this.clipboard = options.clipboard;
    this.tab = this.item?.type === 'command' ? 'output' : 'changes';
    this.unsubscribe = this.replica.subscribe(() => {
      if (this.tab === 'changes' && this.diffFor !== undefined && this.diffFor !== this.turnStatus) void this.loadDiff();
      this.changed();
    });
  }

  /** Fetches the diff when the sheet opens on Changes. */
  start(): void {
    if (this.tab === 'changes') void this.loadDiff();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    clearTimeout(this.copiedTimer);
  }

  // ---- reading ----------------------------------------------------------------------------------

  get item(): Item | undefined {
    return this.replica.session(this.sessionId)?.items[this.itemId];
  }

  get turnId(): string | undefined {
    return this.item?.turnId;
  }

  private get turnStatus(): string | undefined {
    const turnId = this.turnId;
    return this.replica.session(this.sessionId)?.turns.find((t) => t.turnId === turnId)?.status;
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

  get tabs(): DetailTab[] {
    return this.item?.type === 'command' ? ['output', 'changes'] : ['changes'];
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

  get diff(): DiffState {
    if (this.diffState.state !== 'ready') return this.diffState;
    return {
      state: 'ready',
      files: this.files.map((file) => ({ ...file, label: FILE_KIND_LABEL[file.kind], expanded: this.expanded.has(file.path) })),
    };
  }

  // ---- actions ----------------------------------------------------------------------------------

  selectTab(tab: DetailTab): void {
    if (tab === this.tab || !this.tabs.includes(tab)) return;
    this.tab = tab;
    this.changed();
    if (tab === 'changes' && this.diffState.state === 'idle') void this.loadDiff();
  }

  /** turn/diff for the item's turn. A newer fetch wins over one still in flight. */
  async loadDiff(): Promise<void> {
    const turnId = this.turnId;
    if (turnId === undefined) return;
    const request = ++this.diffRequest;
    this.diffFor = this.turnStatus;
    if (this.diffState.state !== 'ready') this.diffState = { state: 'loading' };
    this.changed();
    let next: DiffState;
    let files: typeof this.files = [];
    try {
      const result = await this.replica.turnDiff(this.sessionId, turnId);
      files = result.files.map((file) => {
        const parsed = parseUnifiedDiff(file.diff);
        return {
          path: file.path,
          kind: fileKind(file.kind, parsed),
          ...(parsed.renamedFrom !== undefined ? { renamedFrom: parsed.renamedFrom } : {}),
          added: parsed.added,
          removed: parsed.removed,
          binary: parsed.binary,
          lines: parsed.lines,
        };
      });
      next = { state: 'ready', files: [] };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      next = code === 'not_supported' ? { state: 'unsupported' } : { state: 'error', message: `Could not load the changes: ${errorText(error)}` };
    }
    if (request !== this.diffRequest || this.disposed) return;
    // A single file opens expanded the first time; with more, the list of files comes first.
    if (next.state === 'ready' && this.diffState.state !== 'ready' && files.length === 1) this.expanded.add(files[0]!.path);
    this.files = files;
    this.diffState = next;
    this.changed();
  }

  toggleFile(path: string): void {
    if (!this.expanded.delete(path)) this.expanded.add(path);
    this.changed();
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
