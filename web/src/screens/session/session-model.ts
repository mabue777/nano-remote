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
// The agent's capabilities (spec 4) decide up front where they are known: an agent that cannot steer gets
// no steer attempt (the composer says the message waits, and it is queued at once), an agent without
// diffs offers no Changes view, and the "Bypass" tag needs an agent that honours approvalMode "never".
// With diffs, every finished turn asks turn/diff once and shows "N files changed" when it changed any;
// the line opens the turn's Changes sheet.
// Without capabilities (an older host) the rules above apply unchanged.
//
// Background tasks (spec 5.1 Session.backgroundTasks): the strip lists the agent's helpers with their
// elapsed time and status, a tap shows the latest activity line. An ended task (finished, cancelled,
// failed) leaves the strip TASK_LINGER_S after it ended, or with the next turn when the host drops it
// first. In a session whose agent stopped (status `error`) nothing can still run: a task the list still
// says is running shows "Ended", muted, and does not count as running. A turn whose message the host marks
// `queued` says it waits for the running tasks instead of "Working…". Stop asks first while tasks run,
// because stopping the turn also cancels them (Claude Code ends its background subagents on interrupt).
import type { RequestError } from '../../stream/client';
import type { Agent } from '../../generated/common';
import type { TurnDiffResult } from '../../generated/methods';
import type { InputPart, Item, SessionSummary, SessionView, TurnView, Usage } from '../../replica/types';
import { attachmentsFor, canBypass, canSteer, findAgent, hasDiff, type AgentsSource } from '../capabilities';
import { backgroundTasksText, folderOf, statusOf, type SessionRow } from '../home-model';
import { errorText, Model } from '../model';
import { effortLabel, modelLabel } from '../new-session-model';
import { ComposerAttachments, type AttachmentRules, type PickedFile } from './attachments/composer';
import type { ResizeDeps } from './attachments/resize';
import type { Uploader } from './attachments/upload';
import { filesChangedText } from './views/changes-model';

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
  turnDiff(sessionId: string, turnId: string): Promise<TurnDiffResult>;
}

export type Tone = SessionRow['tone'];

/** An image or file a message carries (spec 5.1 InputPart), for thumbnails and file chips. */
export interface AttachmentView {
  url: string;
  name: string;
  mediaType?: string;
}

export type ItemRow =
  | { kind: 'user'; itemId: string; text: string; images: AttachmentView[]; files: AttachmentView[] }
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
  /** "3 files changed" for a finished turn that changed files (turn/diff); opens its Changes sheet. */
  changes?: string;
  /** Its message waits in the engine behind background tasks (userMessage `queued`); `label` says so. */
  queued?: boolean;
}

/** How long an ended background task stays in the strip after it ended, in seconds. */
export const TASK_LINGER_S = 60;

/** One background task of the session, for the strip. */
export interface BackgroundTaskRow {
  id: string;
  title: string;
  /** `ended`: listed as running in a session whose agent stopped. */
  status: BackgroundTask['status'] | 'ended';
  /** "Running", "Finished", "Cancelled", "Failed", "Ended". */
  state: string;
  tone: Tone;
  /** Time since it started, or how long it ran: "45 s", "2 min 5 s", "1 h 3 min". */
  elapsed: string;
  /** The latest activity line, shown when the row is opened. */
  activity?: string;
  expanded: boolean;
}

type BackgroundTask = NonNullable<SessionSummary['backgroundTasks']>[number];

const TASK_STATE: Record<BackgroundTask['status'], { state: string; tone: Tone }> = {
  running: { state: 'Running', tone: 'busy' },
  finished: { state: 'Finished', tone: 'ok' },
  cancelled: { state: 'Cancelled', tone: 'muted' },
  failed: { state: 'Failed', tone: 'error' },
};

/** A task listed as running in a session whose agent stopped: it cannot still run. */
const STALE_STATE = { state: 'Ended', tone: 'muted' as Tone };

/** Whole seconds as "45 s", "2 min 5 s", "1 h 3 min". */
export function elapsedText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** The notice of a turn whose message waits behind background tasks. */
export function queuedText(running: number): string {
  return running > 0 ? `Queued: waiting for ${backgroundTasksText(running)} to finish` : 'Queued: waiting for the agent';
}

/** What Stop asks while background tasks run. */
export function stopConfirmText(running: number): string {
  return `This also cancels ${backgroundTasksText(running)}. Stop anyway?`;
}

export interface SteerRow {
  clientMessageId: string;
  text: string;
  images: AttachmentView[];
  files: AttachmentView[];
  state: 'sending' | 'sent' | 'queued' | 'failed';
  label: string;
  error?: string;
}

interface Steer {
  clientMessageId: string;
  input: InputPart[];
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

/** The last segment of an image URL as a name: `/v1/blob/blb_x` -> `blb_x`; data URLs are "image". */
function imageName(url: string): string {
  if (url.startsWith('data:')) return 'image';
  return url.split(/[?#]/)[0]!.split('/').pop() || 'image';
}

/** A message's text (mentions as `@name`), its images (thumbnails) and its files (chips). */
export function inputText(content: readonly InputPart[]): { text: string; images: AttachmentView[]; files: AttachmentView[] } {
  const texts: string[] = [];
  const images: AttachmentView[] = [];
  const files: AttachmentView[] = [];
  for (const part of content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'mention') texts.push(`@${part.name}`);
    else if (part.type === 'image') images.push({ url: part.url, name: imageName(part.url) });
    else if (part.type === 'file') files.push({ url: part.url, name: part.name, mediaType: part.mediaType });
  }
  return { text: texts.join('\n'), images, files };
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

export type TaskState = 'Running' | 'Waiting for your approval' | 'Waiting for your answer' | 'Finished' | 'Failed' | 'Interrupted' | 'Idle';

/**
 * The header's task state line, from the session status and how its newest turn ended. The tone is the
 * session list's (statusOf), so the line and the home row agree in color.
 */
export function taskStateOf(summary: Pick<SessionSummary, 'status' | 'lastTurnStatus'>): { label: TaskState; tone: Tone } {
  const { tone } = statusOf(summary);
  switch (summary.status) {
    case 'running':
      return { label: 'Running', tone };
    case 'waiting_approval':
      return { label: 'Waiting for your approval', tone };
    case 'waiting_input':
      return { label: 'Waiting for your answer', tone };
    case 'error':
      return { label: 'Failed', tone };
  }
  const label: Record<NonNullable<SessionSummary['lastTurnStatus']>, TaskState> = {
    inProgress: 'Running',
    completed: 'Finished',
    failed: 'Failed',
    interrupted: 'Interrupted',
  };
  return { label: summary.lastTurnStatus !== undefined ? (label[summary.lastTurnStatus] ?? 'Idle') : 'Idle', tone };
}

const OLDER_PAGE = 5;

/** What the composer needs to attach photos and files (spec 8.1). */
export interface AttachmentServices {
  /** `limits.maxAttachmentBytes` of the current stream's initialize; undefined: the host takes none. */
  maxBytes: () => number | undefined;
  uploader: Uploader;
  resize: ResizeDeps;
  objectUrls?: { create: (blob: Blob) => string; revoke: (url: string) => void };
}

export interface SessionModelOptions {
  sessionId: string;
  replica: SessionReplica;
  /** The host's agents with their capabilities (the stream client's initialize result). */
  agents?: AgentsSource;
  /** Uploads for the composer; without them the composer offers no attach button. */
  attachments?: AttachmentServices;
  /** Milliseconds since the epoch (background task times). Default Date.now. */
  now?: () => number;
}

/** The composer's note while a turn runs and the agent cannot steer. */
export const NO_STEER_NOTE = 'This agent cannot take input while it works. Your message is sent when the turn ends.';

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
  /** The turn whose Changes sheet (views/ChangesSheet) is open. */
  changesTurnId: string | undefined;
  /** Files changed per finished turn, once turn/diff answered (spec 7). */
  private readonly fileCounts = new Map<string, number>();
  private readonly counted = new Set<string>();
  private interruptingTurn: string | undefined;
  private readonly replica: SessionReplica;
  private readonly agents: AgentsSource | undefined;
  private readonly expanded = new Set<string>();
  private readonly steers = new Map<string, Steer>();
  private readonly unsubscribe: (() => void)[] = [];
  private started = false;
  private readonly attachmentServices: AttachmentServices | undefined;
  /** The photos and files picked for the next message. */
  readonly attachments: ComposerAttachments | undefined;
  /** Stop waits for this confirmation while background tasks run. */
  confirmingStop = false;
  private readonly openTasks = new Set<string>();
  private readonly now: () => number;

  constructor(options: SessionModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.now = options.now ?? Date.now;
    this.replica = options.replica;
    this.agents = options.agents;
    this.attachmentServices = options.attachments;
    if (options.attachments !== undefined) {
      this.attachments = new ComposerAttachments({
        sessionId: options.sessionId,
        uploader: options.attachments.uploader,
        resize: options.attachments.resize,
        ...(options.attachments.objectUrls !== undefined ? { objectUrls: options.attachments.objectUrls } : {}),
        onChange: () => this.changed(),
      });
    }
    this.unsubscribe.push(
      this.replica.subscribe(() => {
        this.reconcileSteers();
        if (this.interruptingTurn !== undefined && this.runningTurnId !== this.interruptingTurn) this.interruptingTurn = undefined;
        this.countChanges();
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
    if (this.attachments !== undefined && this.attachments.entries.length > 0) this.attachments.clear();
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

  /** The model the session runs on ("model · provider" for provider/model ids), once opened. */
  get model(): string | undefined {
    const id = this.view?.session?.settings?.model;
    return typeof id === 'string' && id !== '' ? modelLabel(id) : undefined;
  }

  /** The effort level in effect (settings.effort, spec 5.1) as a label, once opened; undefined when none is. */
  get effort(): string | undefined {
    const level = this.view?.session?.settings?.effort;
    return typeof level === 'string' && level !== '' ? effortLabel(level) : undefined;
  }

  /** The session's agent as the host lists it; undefined until known (or on an older host's list). */
  get agent(): Agent | undefined {
    return findAgent(this.agents, this.agentId);
  }

  /**
   * True while the session runs with approvals bypassed: Session.settings.approvalMode "never" and an agent
   * that honours it (a host that stored "never" for an agent ignoring it must not show "Bypass").
   */
  get bypass(): boolean {
    return this.view?.session?.settings?.approvalMode === 'never' && canBypass(this.agent);
  }

  /** The agent takes input while a turn runs (turn/steer). */
  get steerable(): boolean {
    return canSteer(this.agent);
  }

  /** The agent provides turn diffs: items offer the Changes view. */
  get diffs(): boolean {
    return hasDiff(this.agent);
  }

  /** The item has a detail sheet: a command (its output), or any item when the agent provides diffs. */
  hasDetail(kind: ItemRow['kind']): boolean {
    return kind === 'command' || this.diffs;
  }

  /** The status pill: the loaded view's status (status/changed), else the list row's. */
  get status(): { label: string; tone: Tone; status: SessionSummary['status'] } {
    const inputs = this.statusInputs;
    return { ...statusOf(inputs), status: inputs.status };
  }

  private get statusInputs(): Pick<SessionSummary, 'status' | 'lastTurnStatus'> {
    const view = this.view;
    const status = view?.loaded ? view.status : (this.summary?.status ?? 'idle');
    const lastTurn = view === undefined ? undefined : [...view.turns].reverse().find((t) => t.optimistic === undefined);
    const lastTurnStatus = (lastTurn?.status ?? this.summary?.lastTurnStatus) as SessionSummary['lastTurnStatus'];
    return lastTurnStatus === undefined ? { status } : { status, lastTurnStatus };
  }

  /** The compact task state line under the title. */
  get taskState(): { label: TaskState; tone: Tone } {
    return taskStateOf(this.statusInputs);
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

  /**
   * The session's background tasks (spec 5.1), running first as the host lists them; none once closed.
   * Ended ones go TASK_LINGER_S after they ended; in a session whose agent stopped none shows running.
   */
  get backgroundTasks(): BackgroundTaskRow[] {
    if (this.closed) return [];
    const nowSeconds = Math.floor(this.now() / 1000);
    const stopped = this.statusInputs.status === 'error';
    return (this.taskList ?? []).flatMap((task) => {
      const running = task.status === 'running' || !(task.status in TASK_STATE);
      if (!running && nowSeconds - (task.endedAt ?? task.startedAt) >= TASK_LINGER_S) return [];
      const stale = running && stopped;
      const end = task.endedAt ?? (running ? nowSeconds : task.startedAt);
      const row: BackgroundTaskRow = {
        id: task.id,
        title: task.title.trim() === '' ? 'Background task' : task.title,
        status: stale ? 'ended' : running ? 'running' : task.status,
        ...(stale ? STALE_STATE : running ? TASK_STATE.running : TASK_STATE[task.status]),
        // How long a stale task ran is unknown.
        elapsed: stale ? '' : elapsedText(end - task.startedAt),
        expanded: this.openTasks.has(task.id),
      };
      if (task.lastActivity !== undefined && task.lastActivity !== '') row.activity = task.lastActivity;
      return [row];
    });
  }

  private get taskList(): BackgroundTask[] | undefined {
    const view = this.view;
    return view?.session !== null && view?.session !== undefined ? view.session.backgroundTasks : this.summary?.backgroundTasks;
  }

  /** How many background tasks are running. */
  get runningTasks(): number {
    return this.backgroundTasks.filter((task) => task.status === 'running').length;
  }

  /** Opens or closes a task row's activity line. */
  toggleTask(id: string): void {
    if (!this.openTasks.delete(id)) this.openTasks.add(id);
    this.changed();
  }

  /** Re-renders the strip: elapsed times count up, ended tasks leave (the screen calls it every second while it shows). */
  tick(): void {
    if (this.backgroundTasks.length > 0) this.changed();
  }

  get turns(): TurnRow[] {
    const view = this.view;
    if (view === undefined) return [];
    const running = this.runningTasks;
    return view.turns.map((turn) => {
      const row = turnRow(turn, view.items, this.expanded);
      const queued = turn.status === 'inProgress' && turn.items.some((id) => (view.items[id] as { queued?: unknown } | undefined)?.queued === true);
      if (queued) {
        row.label = queuedText(running);
        row.tone = 'muted';
        row.queued = true;
      }
      const count = this.fileCounts.get(turn.turnId) ?? 0;
      if (count > 0) row.changes = filesChangedText(count);
      return row;
    });
  }

  /** Asks turn/diff once for every finished turn, for its "N files changed" line. Failures show no line. */
  private countChanges(): void {
    const view = this.view;
    if (view === undefined || !this.diffs) return;
    for (const turn of view.turns) {
      const final = turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed';
      if (!final || turn.optimistic !== undefined || this.counted.has(turn.turnId)) continue;
      this.counted.add(turn.turnId);
      this.replica.turnDiff(this.sessionId, turn.turnId).then(
        (result) => {
          this.fileCounts.set(turn.turnId, result.files.length + (result.omittedFiles ?? 0));
          this.changed();
        },
        () => undefined,
      );
    }
  }

  /** Steers not yet shown in their turn: sending, sent but not echoed, queued, or failed. */
  get steerRows(): SteerRow[] {
    return [...this.steers.values()].map((steer) => ({
      clientMessageId: steer.clientMessageId,
      ...inputText(steer.input),
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

  /**
   * `steer` while a turn is running (send adds to it), `queue` instead when the agent cannot steer (send
   * waits for the turn to end), else `send` (a new turn).
   */
  get mode(): 'send' | 'steer' | 'queue' {
    if (this.runningTurnId === undefined) return 'send';
    return this.steerable ? 'steer' : 'queue';
  }

  /** Said up front in the composer while a turn runs and the agent cannot steer. */
  get composerNote(): string | undefined {
    return this.mode === 'queue' ? NO_STEER_NOTE : undefined;
  }

  /**
   * What the attach button offers (spec 8.1): undefined when the host takes no uploads, the agent declares
   * no attachments, or the session is closed. Images are offered whenever files are (the host hands an agent
   * without image input its photos as files).
   */
  get attachRules(): AttachmentRules | undefined {
    const maxBytes = this.attachmentServices?.maxBytes();
    const accepts = attachmentsFor(this.agent, maxBytes);
    if (accepts === undefined || maxBytes === undefined || this.closed) return undefined;
    return { images: accepts.images || accepts.files, files: accepts.files, maxBytes };
  }

  /** The file picker's `accept`: images only when the agent takes no files, else anything. */
  get attachAccept(): string {
    return this.attachRules?.files === false ? 'image/*' : '';
  }

  /** Why Send waits: attachments still uploading, or one failed. */
  get attachmentsNote(): string | undefined {
    const attachments = this.attachments;
    if (attachments === undefined) return undefined;
    if (attachments.busy) return 'Uploading attachments…';
    if (attachments.failed) return 'An attachment did not upload: retry or remove it.';
    return undefined;
  }

  get canSend(): boolean {
    if (this.closed) return false;
    const attachments = this.attachments;
    if (attachments !== undefined && attachments.entries.length > 0) return attachments.ready;
    return this.draft.trim() !== '';
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

  /** Picks photos or files for the next message; each starts uploading at once. */
  attach(files: readonly (Blob & PickedFile)[]): void {
    const rules = this.attachRules;
    if (this.attachments === undefined || rules === undefined || files.length === 0) return;
    this.attachments.add(files, rules);
  }

  removeAttachment(id: string): void {
    this.attachments?.remove(id);
  }

  retryAttachment(id: string): void {
    const rules = this.attachRules;
    if (rules !== undefined) this.attachments?.retry(id, rules);
  }

  /** Sends the draft and the ready attachments: a new turn, or a steer into the running one. */
  send(): void {
    if (!this.canSend) return;
    const text = this.draft.trim();
    const input: InputPart[] = [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...(this.attachments?.parts() ?? [])];
    this.draft = '';
    if (this.attachments !== undefined && this.attachments.entries.length > 0) this.attachments.clear();
    this.atBottom = true;
    this.scrollRequest += 1;
    const running = this.runningTurnId;
    if (running === undefined) this.replica.sendMessage(this.sessionId, input);
    else if (this.steerable) void this.steer(input, running, this.replica.newClientMessageId());
    else this.queue(input, running);
    this.changed();
  }

  /** Holds a message for an agent that cannot steer; it goes out as a new turn once the turn ends. */
  private queue(input: InputPart[], turnId: string): void {
    const clientMessageId = this.replica.newClientMessageId();
    this.steers.set(clientMessageId, { clientMessageId, input, turnId, state: 'queued' });
  }

  /** Sends a refused message again (same clientMessageId). */
  retry(clientMessageId: string): void {
    this.replica.retrySend(this.sessionId, clientMessageId);
  }

  discard(clientMessageId: string): void {
    this.replica.discardSend(this.sessionId, clientMessageId);
  }

  /**
   * After `session_busy`: drops the refused turn and steers its text into the running turn instead (an
   * agent that cannot steer gets it queued until that turn ends).
   */
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
    const input = [...item.content];
    if (this.steerable) void this.steer(input, target, this.replica.newClientMessageId());
    else {
      this.queue(input, target);
      this.reconcileSteers();
      this.changed();
    }
  }

  /** Steers a failed steer again: into the running turn, or as a new turn when none runs any more. */
  retrySteer(clientMessageId: string): void {
    const steer = this.steers.get(clientMessageId);
    if (steer === undefined || steer.state !== 'failed') return;
    const running = this.runningTurnId;
    if (running === undefined) {
      this.steers.delete(clientMessageId);
      this.replica.sendMessage(this.sessionId, steer.input);
      this.changed();
      return;
    }
    void this.steer(steer.input, running, clientMessageId);
  }

  discardSteer(clientMessageId: string): void {
    if (this.steers.delete(clientMessageId)) this.changed();
  }

  /** The Stop button: asks first while background tasks run (stopping cancels them), else stops. */
  requestStop(): void {
    if (!this.canInterrupt) return;
    if (this.runningTasks > 0) {
      this.confirmingStop = true;
      this.changed();
      return;
    }
    void this.interrupt();
  }

  /** "Stop anyway": the turn stops, and with it the background tasks. */
  confirmStop(): void {
    if (!this.confirmingStop) return;
    this.confirmingStop = false;
    void this.interrupt();
  }

  /** The question of the Stop confirmation while it is open. */
  get stopQuestion(): string | undefined {
    if (!this.confirmingStop || !this.canInterrupt) return undefined;
    const running = this.runningTasks;
    return running > 0 ? stopConfirmText(running) : 'Stop the turn?';
  }

  /** "Keep running": nothing stops. */
  cancelStop(): void {
    if (!this.confirmingStop) return;
    this.confirmingStop = false;
    this.changed();
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
    const item = this.view?.items[itemId];
    if (item === undefined || this.detailItemId === itemId) return;
    if (item.type !== 'command' && !this.diffs) return;
    this.detailItemId = itemId;
    this.changed();
  }

  closeItem(): void {
    if (this.detailItemId === undefined) return;
    this.detailItemId = undefined;
    this.changed();
  }

  /** Opens the Changes sheet of a turn (its "N files changed" line). */
  openChanges(turnId: string): void {
    if (this.changesTurnId === turnId || !this.diffs) return;
    this.changesTurnId = turnId;
    this.changed();
  }

  closeChanges(): void {
    if (this.changesTurnId === undefined) return;
    this.changesTurnId = undefined;
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

  private async steer(input: InputPart[], turnId: string, clientMessageId: string): Promise<void> {
    const steer: Steer = { clientMessageId, input, turnId, state: 'sending' };
    this.steers.set(clientMessageId, steer);
    this.changed();
    try {
      await this.replica.steer(this.sessionId, turnId, input, clientMessageId);
      steer.state = 'sent';
    } catch (error) {
      const code = (error as Partial<RequestError>).code ?? 'internal';
      if (code === 'turn_mismatch') {
        // The turn ended before the steer landed: the message becomes a new turn.
        this.steers.delete(clientMessageId);
        this.replica.sendMessage(this.sessionId, input);
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
        this.replica.sendMessage(this.sessionId, steer.input);
      }
    }
  }
}
