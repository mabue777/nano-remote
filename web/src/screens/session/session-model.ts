// The session view (/s/:sessionId): renders one session's Replica and drives its turns (spec 5 and 7).
//
// Everything shown comes from the Replica's SessionView: turns oldest first with their items (message
// text grows as `item/delta` events are applied), the session status from `status/changed`, usage from
// `usage/updated`, and the pending requests. This model turns that into rows a component can render and
// adds what only the screen knows: the composer draft, steers in flight, which reasoning items are open,
// whether the user scrolled away from the bottom, and the older-turns pager.
//
// Composer rules (spec 7): with no turn running, send is turn/start through Replica.sendMessage (an
// optimistic `sending` turn until the host's turn arrives; refused sends show the error with retry). While
// a turn runs, send becomes turn/steer into it. `session_busy` on a send offers "steer instead";
// `turn_mismatch` on a steer (the turn just ended) sends it as a new turn; `not_supported` queues it until
// the running turn ends, then sends it as a new turn. Interrupt is turn/interrupt for the running turn.
import type { RequestError } from '../../stream/client';
import type { InputPart, Item, SessionSummary, SessionView, TurnView, Usage } from '../../replica/types';
import { folderOf, statusOf, type SessionRow } from '../home-model';
import { errorText, Model } from '../model';

/** What the session view needs from the Replica; Replica fits. */
export interface SessionReplica {
  readonly sessions: SessionSummary[];
  session(sessionId: string): SessionView | undefined;
  open(sessionId: string): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: () => void): () => void;
  sendMessage(sessionId: string, input: InputPart[]): string;
  retrySend(sessionId: string, clientMessageId: string): void;
  discardSend(sessionId: string, clientMessageId: string): void;
  interrupt(sessionId: string, turnId: string): Promise<void>;
  steer(sessionId: string, turnId: string, input: InputPart[], clientMessageId: string): Promise<unknown>;
  newClientMessageId(): string;
  loadOlderTurns(sessionId: string, limit?: number): Promise<boolean>;
}

export type Tone = SessionRow['tone'];

export type ItemRow =
  | { kind: 'user'; itemId: string; text: string; attachments: number }
  | { kind: 'agent'; itemId: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; itemId: string; summary: string; text: string; expanded: boolean; streaming: boolean }
  | { kind: 'command'; itemId: string; summary: string; state: string; tone: Tone; output: string }
  | { kind: 'fileChange'; itemId: string; files: { path: string; kind: string }[]; state: string; tone: Tone }
  | { kind: 'tool'; itemId: string; summary: string; state: string; tone: Tone; error?: string }
  | { kind: 'plan'; itemId: string; text: string }
  | { kind: 'other'; itemId: string; label: string };

export interface TurnRow {
  turnId: string;
  status: TurnView['status'];
  /** "Working…", "Interrupted", "Failed", "Sending…", "Not sent"; empty for a completed turn. */
  label: string;
  tone: Tone;
  items: ItemRow[];
  /** A failed turn's error, shown inline. */
  error?: string;
  /** Optimistic turns (spec 7): the clientMessageId and, when refused, why and what to offer. */
  send?: { clientMessageId: string; failure?: string; busy: boolean };
}

export interface SteerRow {
  clientMessageId: string;
  text: string;
  state: 'sending' | 'sent' | 'queued' | 'failed';
  label: string;
  error?: string;
}

interface Steer {
  clientMessageId: string;
  text: string;
  turnId: string;
  state: SteerRow['state'];
  error?: string;
}

/** Copy for the error codes a send or steer can meet (spec 10); the host's message is for logs only. */
export function sendErrorText(code: string, fallback?: string): string {
  switch (code) {
    case 'session_busy':
      return 'The agent is busy with another turn.';
    case 'turn_mismatch':
      return 'That turn has already ended.';
    case 'not_found':
      return 'The host does not know this session any more.';
    case 'agent_unavailable':
      return 'The agent is not available on the host right now.';
    case 'not_supported':
      return 'This agent cannot take input while it works.';
    case 'rate_limited':
      return 'Too many requests; wait a moment and retry.';
    case 'connection_lost':
    case 'timeout':
      return 'The host did not answer.';
    case 'unauthorized':
      return 'This device is no longer paired.';
    default:
      return fallback !== undefined && fallback !== '' ? fallback : 'The host refused the message.';
  }
}

/** `/bin/zsh -lc "echo hi"` → `echo hi`: the shell wrapper adapters report adds nothing on a phone. */
export function unwrapShell(command: string): string {
  const match = /^\S*\/?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(command.trim());
  return match !== null ? match[2]!.replace(/\\(["\\])/g, '$1') : command.trim();
}

/** First line, at most `max` characters (an ellipsis marks a cut). */
export function oneLine(text: string, max = 80): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const first = (lines[0] ?? '').trim();
  const cut = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return lines.length > 1 && cut === first ? `${cut} …` : cut;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Item status as a short label and tone. */
function stateOf(status: Item['status'], done = 'Done'): { state: string; tone: Tone } {
  switch (status) {
    case 'inProgress':
      return { state: 'Running', tone: 'busy' };
    case 'failed':
      return { state: 'Failed', tone: 'error' };
    case 'declined':
      return { state: 'Declined', tone: 'muted' };
    default:
      return { state: done, tone: 'ok' };
  }
}

/** The command's one-line summary: the command itself, then exit code and duration once known. */
export function commandSummary(item: Extract<Item, { type: 'command' }>): string {
  const parts = [oneLine(unwrapShell(item.command))];
  if (typeof item.exitCode === 'number') parts.push(`exit ${item.exitCode}`);
  if (typeof item.durationMs === 'number') parts.push(formatDuration(item.durationMs));
  return parts.join(' · ');
}

function inputText(content: readonly InputPart[]): { text: string; attachments: number } {
  const texts: string[] = [];
  let attachments = 0;
  for (const part of content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'mention') texts.push(`@${part.name}`);
    else attachments += 1;
  }
  return { text: texts.join('\n'), attachments };
}

function stringOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') return (value as { message: string }).message;
  return JSON.stringify(value);
}

export function itemRow(item: Item, expanded: boolean): ItemRow {
  const { itemId } = item;
  switch (item.type) {
    case 'userMessage':
      return { kind: 'user', itemId, ...inputText(item.content) };
    case 'agentMessage':
      return { kind: 'agent', itemId, text: item.text, streaming: item.status === 'inProgress' };
    case 'reasoning':
      return { kind: 'reasoning', itemId, summary: item.summary, text: item.text ?? '', expanded, streaming: item.status === 'inProgress' };
    case 'command': {
      const { state, tone } = stateOf(item.status, typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'Failed' : 'Done');
      const failedExit = item.status === 'completed' && typeof item.exitCode === 'number' && item.exitCode !== 0;
      return { kind: 'command', itemId, summary: commandSummary(item), state, tone: failedExit ? 'error' : tone, output: item.output };
    }
    case 'fileChange':
      return { kind: 'fileChange', itemId, files: item.changes.map((c) => ({ path: c.path, kind: c.kind })), ...stateOf(item.status) };
    case 'toolCall': {
      const error = stringOf(item.error);
      const name = item.server !== undefined && item.server !== '' ? `${item.server}/${item.tool}` : item.tool;
      return {
        kind: 'tool',
        itemId,
        summary: name,
        ...stateOf(error !== '' ? 'failed' : item.status),
        ...(error !== '' ? { error: oneLine(error, 160) } : {}),
      };
    }
    case 'plan':
      return { kind: 'plan', itemId, text: item.text };
    default: {
      // `other`, and item types newer than this client (spec 12): shown collapsed by name.
      const type = (item as { type: string }).type;
      return { kind: 'other', itemId, label: type === 'other' ? 'Other activity' : type };
    }
  }
}

function turnLabel(turn: TurnView): { label: string; tone: Tone } {
  switch (turn.status) {
    case 'inProgress':
      return { label: 'Working…', tone: 'busy' };
    case 'interrupted':
      return { label: 'Interrupted', tone: 'muted' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'sending':
      return { label: 'Sending…', tone: 'busy' };
    case 'failed_to_send':
      return { label: 'Not sent', tone: 'error' };
    default:
      return { label: '', tone: 'ok' };
  }
}

export function turnRow(turn: TurnView, items: Readonly<Record<string, Item>>, expanded: ReadonlySet<string>): TurnRow {
  const row: TurnRow = {
    turnId: turn.turnId,
    status: turn.status,
    ...turnLabel(turn),
    items: turn.items.flatMap((id) => {
      const item = items[id];
      if (item === undefined) return [];
      const row = itemRow(item, expanded.has(id));
      // An interrupted or failed turn may leave text items unfinished: they no longer stream.
      if ((row.kind === 'agent' || row.kind === 'reasoning') && turn.status !== 'inProgress') row.streaming = false;
      return [row];
    }),
  };
  if (turn.status === 'failed' && turn.error !== null) row.error = turn.error.message !== '' ? turn.error.message : turn.error.code;
  if (turn.optimistic !== undefined) {
    const error = turn.optimistic.error;
    row.send = {
      clientMessageId: turn.optimistic.clientMessageId,
      busy: error?.code === 'session_busy',
      ...(turn.status === 'failed_to_send' && error !== undefined ? { failure: sendErrorText(error.code, error.message) } : {}),
    };
  }
  return row;
}

/**
 * "Session total 1,200 in · 340 out · context 4% full". The counts sum every model request of the session
 * (each request re-sends the conversation, so "in" grows fast); the share is how full the context window
 * was at the latest request. The engine reports after each request, so it changes mid-turn, but not while
 * an approval is pending (Codex holds that request's numbers until its command finishes).
 */
export function usageLine(usage: Usage): string {
  const n = (value: number) => value.toLocaleString('en-US');
  const parts = [`Session total ${n(usage.inputTokens)} in`, `${n(usage.outputTokens)} out`];
  if (typeof usage.contextPercent === 'number') parts.push(`context ${usage.contextPercent}% full`);
  return parts.join(' · ');
}

const OLDER_PAGE = 5;

export interface SessionModelOptions {
  sessionId: string;
  replica: SessionReplica;
}

export class SessionModel extends Model {
  readonly sessionId: string;
  draft = '';
  /** False once the user scrolled up from the bottom; the view shows "jump to latest" then. */
  atBottom = true;
  loadingOlder = false;
  olderError: string | undefined;
  interruptError: string | undefined;
  /** Why the session could not be opened (the Replica keeps trying on each new stream). */
  openError: string | undefined;
  /** Bumped when the view should scroll to the bottom (after a send). */
  scrollRequest = 0;
  /** The item whose detail sheet (views/ItemDetailSheet) is open. */
  detailItemId: string | undefined;
  private interruptingTurn: string | undefined;
  private readonly replica: SessionReplica;
  private readonly expanded = new Set<string>();
  private readonly steers = new Map<string, Steer>();
  private readonly unsubscribe: (() => void)[] = [];
  private started = false;

  constructor(options: SessionModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.replica = options.replica;
    this.unsubscribe.push(
      this.replica.subscribe(() => {
        this.reconcileSteers();
        if (this.interruptingTurn !== undefined && this.runningTurnId !== this.interruptingTurn) this.interruptingTurn = undefined;
        this.changed();
      }),
    );
  }

  /** Opens the session in the Replica (session/open, then live events). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.replica.open(this.sessionId).then(
      () => {
        this.openError = undefined;
        this.changed();
      },
      (error: unknown) => {
        this.openError = `Could not open the session: ${errorText(error)}`;
        this.changed();
      },
    );
  }

  /** Stops listening and unsubscribes the stream from the session (session/close). */
  dispose(): void {
    for (const fn of this.unsubscribe.splice(0)) fn();
    if (this.started) void this.replica.close().catch(() => undefined);
  }

  // ---- reading ----------------------------------------------------------------------------------

  get view(): SessionView | undefined {
    return this.replica.session(this.sessionId);
  }

  private get summary(): SessionSummary | undefined {
    return this.view?.session ?? this.replica.sessions.find((s) => s.sessionId === this.sessionId);
  }

  get loaded(): boolean {
    return this.view?.loaded === true;
  }

  get title(): string {
    const title = this.summary?.title ?? '';
    return title.trim() === '' ? 'Session' : title;
  }

  /** The working folder's last part and the full path, once known. */
  get folder(): { name: string; path: string } | undefined {
    const cwd = this.summary?.cwd;
    return cwd === undefined ? undefined : { name: folderOf(cwd), path: cwd };
  }

  get agentId(): string | undefined {
    return this.summary?.agentId;
  }

  /** The status pill: the loaded view's status (status/changed), else the list row's. */
  get status(): { label: string; tone: Tone; status: SessionSummary['status'] } {
    const view = this.view;
    const status = view?.loaded ? view.status : (this.summary?.status ?? 'idle');
    const lastTurn = view === undefined ? undefined : [...view.turns].reverse().find((t) => t.optimistic === undefined);
    const lastTurnStatus = (lastTurn?.status ?? this.summary?.lastTurnStatus) as SessionSummary['lastTurnStatus'];
    return { ...statusOf({ status, lastTurnStatus }), status };
  }

  get usage(): string | undefined {
    const usage = this.view?.usage;
    return usage === null || usage === undefined ? undefined : usageLine(usage);
  }

  /** Pending request counters for the banner (spec 5.3); the cards are approvals/ApprovalsModel. */
  get pending(): { approvals: number; inputs: number; total: number } {
    const view = this.view;
    const counts = view?.loaded
      ? { approvals: Object.keys(view.approvals).length, inputs: Object.keys(view.inputs).length }
      : (this.summary?.pending ?? { approvals: 0, inputs: 0 });
    return { ...counts, total: counts.approvals + counts.inputs };
  }

  get needsDecision(): boolean {
    return this.pending.total > 0;
  }

  get turns(): TurnRow[] {
    const view = this.view;
    if (view === undefined) return [];
    return view.turns.map((turn) => turnRow(turn, view.items, this.expanded));
  }

  /** Steers not yet shown in their turn: sending, sent but not echoed, queued, or failed. */
  get steerRows(): SteerRow[] {
    return [...this.steers.values()].map((steer) => ({
      clientMessageId: steer.clientMessageId,
      text: steer.text,
      state: steer.state,
      label: { sending: 'Sending…', sent: 'Sent', queued: 'Queued until the turn ends', failed: 'Not sent' }[steer.state],
      ...(steer.error !== undefined ? { error: steer.error } : {}),
    }));
  }

  /** The newest host turn still in progress. */
  get runningTurnId(): string | undefined {
    const view = this.view;
    if (view === undefined) return undefined;
    for (let i = view.turns.length - 1; i >= 0; i -= 1) {
      const turn = view.turns[i]!;
      if (turn.optimistic === undefined) return turn.status === 'inProgress' ? turn.turnId : undefined;
    }
    return undefined;
  }

  get closed(): boolean {
    return this.status.status === 'closed';
  }

  /** `steer` while a turn is running (send adds to it), else `send` (a new turn). */
  get mode(): 'send' | 'steer' {
    return this.runningTurnId !== undefined ? 'steer' : 'send';
  }

  get canSend(): boolean {
    return this.draft.trim() !== '' && !this.closed;
  }

  get canInterrupt(): boolean {
    return this.runningTurnId !== undefined && this.interruptingTurn === undefined;
  }

  get interrupting(): boolean {
    return this.interruptingTurn !== undefined;
  }

  get hasOlder(): boolean {
    return this.view?.olderCursor !== undefined;
  }

  get showJumpToLatest(): boolean {
    return !this.atBottom;
  }

  // ---- actions ----------------------------------------------------------------------------------

  setDraft(text: string): void {
    if (text === this.draft) return;
    this.draft = text;
    this.changed();
  }

  /** Sends the draft: a new turn, or a steer into the running one. */
  send(): void {
    if (!this.canSend) return;
    const text = this.draft.trim();
    this.draft = '';
    this.atBottom = true;
    this.scrollRequest += 1;
    const running = this.runningTurnId;
    if (running !== undefined) void this.steer(text, running, this.replica.newClientMessageId());
    else this.replica.sendMessage(this.sessionId, [{ type: 'text', text }]);
    this.changed();
  }

  /** Sends a refused message again (same clientMessageId). */
  retry(clientMessageId: string): void {
    this.replica.retrySend(this.sessionId, clientMessageId);
  }

  discard(clientMessageId: string): void {
    this.replica.discardSend(this.sessionId, clientMessageId);
  }

  /** After `session_busy`: drops the refused turn and steers its text into the running turn instead. */
  steerInstead(clientMessageId: string): void {
    const view = this.view;
    const turn = view?.turns.find((t) => t.optimistic?.clientMessageId === clientMessageId);
    if (view === undefined || turn === undefined) return;
    const item = view.items[turn.items[0]!];
    const busyWith = turn.optimistic!.error?.data?.turnId;
    const target = typeof busyWith === 'string' ? busyWith : this.runningTurnId;
    if (item?.type !== 'userMessage' || target === undefined) {
      this.retry(clientMessageId);
      return;
    }
    this.replica.discardSend(this.sessionId, clientMessageId);
    void this.steer(inputText(item.content).text, target, this.replica.newClientMessageId());
  }

  /** Steers a failed steer again: into the running turn, or as a new turn when none runs any more. */
  retrySteer(clientMessageId: string): void {
    const steer = this.steers.get(clientMessageId);
    if (steer === undefined || steer.state !== 'failed') return;
    const running = this.runningTurnId;
    if (running === undefined) {
      this.steers.delete(clientMessageId);
      this.replica.sendMessage(this.sessionId, [{ type: 'text', text: steer.text }]);
      this.changed();
      return;
    }
    void this.steer(steer.text, running, clientMessageId);
  }

  discardSteer(clientMessageId: string): void {
    if (this.steers.delete(clientMessageId)) this.changed();
  }

  /** turn/interrupt for the running turn; it ends through the Journal (turn/completed interrupted). */
  async interrupt(): Promise<void> {
    const turnId = this.runningTurnId;
    if (turnId === undefined || this.interruptingTurn !== undefined) return;
    this.interruptingTurn = turnId;
    this.interruptError = undefined;
    this.changed();
    try {
      await this.replica.interrupt(this.sessionId, turnId);
    } catch (error) {
      this.interruptingTurn = undefined;
      this.interruptError = `Could not stop the turn: ${errorText(error)}`;
      this.changed();
    }
  }

  /** Pull-down at the top: the next page of older turns (session/history). */
  async loadOlder(): Promise<void> {
    if (this.loadingOlder || !this.hasOlder) return;
    this.loadingOlder = true;
    this.olderError = undefined;
    this.changed();
    try {
      await this.replica.loadOlderTurns(this.sessionId, OLDER_PAGE);
    } catch (error) {
      this.olderError = `Could not load earlier turns: ${errorText(error)}`;
    } finally {
      this.loadingOlder = false;
      this.changed();
    }
  }

  toggleReasoning(itemId: string): void {
    if (!this.expanded.delete(itemId)) this.expanded.add(itemId);
    this.changed();
  }

  /** Opens the detail sheet (output, changes) for an item of the turn list. */
  openItem(itemId: string): void {
    if (this.view?.items[itemId] === undefined || this.detailItemId === itemId) return;
    this.detailItemId = itemId;
    this.changed();
  }

  closeItem(): void {
    if (this.detailItemId === undefined) return;
    this.detailItemId = undefined;
    this.changed();
  }

  /** The view reports whether the list is scrolled to the bottom. */
  setAtBottom(atBottom: boolean): void {
    if (atBottom === this.atBottom) return;
    this.atBottom = atBottom;
    this.changed();
  }

  /** The "jump to latest" pill. */
  jumpToLatest(): void {
    this.atBottom = true;
    this.scrollRequest += 1;
    this.changed();
  }

  // ---- steering ---------------------------------------------------------------------------------

  private async steer(text: string, turnId: string, clientMessageId: string): Promise<void> {
    const steer: Steer = { clientMessageId, text, turnId, state: 'sending' };
    this.steers.set(clientMessageId, steer);
    this.changed();
    try {
      await this.replica.steer(this.sessionId, turnId, [{ type: 'text', text }], clientMessageId);
      steer.state = 'sent';
    } catch (error) {
      const code = (error as Partial<RequestError>).code ?? 'internal';
      if (code === 'turn_mismatch') {
        // The turn ended before the steer landed: the message becomes a new turn.
        this.steers.delete(clientMessageId);
        this.replica.sendMessage(this.sessionId, [{ type: 'text', text }]);
      } else if (code === 'not_supported') {
        steer.state = 'queued';
      } else {
        steer.state = 'failed';
        steer.error = sendErrorText(code, (error as Partial<Error>).message);
      }
    }
    this.reconcileSteers();
    this.changed();
  }

  /**
   * Steers leave the list once their userMessage (echoing clientMessageId) is in the view, or, once
   * sent, when their turn is over. Queued steers go out as a new turn once nothing runs.
   */
  private reconcileSteers(): void {
    if (this.steers.size === 0) return;
    const view = this.view;
    const echoed = new Set<string>();
    for (const item of Object.values(view?.items ?? {})) {
      if (item.type === 'userMessage' && typeof item.clientMessageId === 'string') echoed.add(item.clientMessageId);
    }
    const running = this.runningTurnId;
    for (const steer of [...this.steers.values()]) {
      if (echoed.has(steer.clientMessageId) || (steer.state === 'sent' && running !== steer.turnId)) {
        this.steers.delete(steer.clientMessageId);
      } else if (steer.state === 'queued' && running === undefined) {
        this.steers.delete(steer.clientMessageId);
        this.replica.sendMessage(this.sessionId, [{ type: 'text', text: steer.text }]);
      }
    }
  }
}
