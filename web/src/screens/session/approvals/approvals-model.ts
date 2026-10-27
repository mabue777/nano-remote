// The session's pending requests as cards (spec 5.3): approval cards with their decision buttons, question
// forms, and the one-line answered state each card leaves behind.
//
// The cards come straight from the Replica's view (`approvals`, `inputs`), which session/open fills with
// `pending` on open and after every reconnect and which `request/resolved` empties, so a card shows as soon
// as the view has it and goes when the host says so. This model adds what only the screen knows: the
// decision or answer in flight, a refused send's error, the question drafts, and the answered lines.
//
// Answered lines: a card that goes away stays where it was as one line (answered.ts): "Approved",
// "Declined", the answer to a question, or who resolved it elsewhere ("Approved on iPhone 15", the device
// named by request/resolved and looked up with device/list; "Withdrawn by the agent"). The lines live as
// long as this model (the session screen); the Replica keeps resolutions in memory only and session/open
// does not list resolved requests, so a reload starts without them.
import type { Resolution, ResolveOutcome } from '../../../replica/replica';
import type { ApprovalRequestBody, Decision, InputRequestBody, SessionView } from '../../../replica/types';
import { errorText, Model } from '../../model';
import { approvalAnswered, questionAnswered, type AnsweredText, type Resolver } from './answered';
import { approvalCard, type ApprovalCardView } from './decisions';
import {
  answersOf,
  answerSummary,
  canSubmit,
  EMPTY_DRAFT,
  pickOther,
  questionTitle,
  questionView,
  setOther,
  toggleOption,
  type QuestionDraft,
  type QuestionView,
} from './questions';

export type { QuestionView } from './questions';

export interface ApprovalsReplica {
  session(sessionId: string): SessionView | undefined;
  subscribe(listener: () => void): () => void;
  resolveApproval(sessionId: string, requestId: string, decision: Decision): Promise<ResolveOutcome>;
  answerInput(sessionId: string, requestId: string, answers: Record<string, string[]>): Promise<ResolveOutcome>;
  resolution(requestId: string): Resolution | undefined;
}

export interface ApprovalsModelOptions {
  sessionId: string;
  replica: ApprovalsReplica;
  /** This device's clientId: its own resolutions leave no notice. */
  clientId?: string;
  /** Display name of a device by clientId (device/list). */
  deviceName?: (clientId: string) => Promise<string | undefined>;
}

export interface ApprovalCardState extends ApprovalCardView {
  /** The decision being sent, if any; every button is disabled meanwhile. */
  sending?: Decision;
  error?: string;
}

export interface QuestionCardState {
  requestId: string;
  /** The bold title: the question, or "N questions". */
  title: string;
  blocking: boolean;
  questions: QuestionView[];
  canSubmit: boolean;
  sending: boolean;
  error?: string;
}

/** A card that was answered, as the one line it leaves where it was. */
export interface AnsweredRow extends AnsweredText {
  requestId: string;
  kind: 'approval' | 'question';
  /** The card's kind of approval (command, fileChange, permission) or "input": picks the icon. */
  requestKind: string;
  /** Where it belongs in the conversation. */
  turnId: string;
  itemId: string;
  title: string;
}

/** What is kept of a request on screen, to describe it once it is gone. */
interface Shown {
  kind: 'approval' | 'question';
  requestKind: string;
  turnId: string;
  itemId: string;
  title: string;
  questions: InputRequestBody['questions'];
}

function shownOf(request: ApprovalRequestBody | InputRequestBody): Shown {
  const base = { requestKind: request.kind, turnId: request.turnId, itemId: request.itemId };
  if (request.kind === 'input') return { ...base, kind: 'question', title: questionTitle(request.questions), questions: request.questions };
  return { ...base, kind: 'approval', title: approvalCard(request).title, questions: [] };
}

export class ApprovalsModel extends Model {
  readonly sessionId: string;
  private readonly replica: ApprovalsReplica;
  private readonly clientId: string | undefined;
  private readonly deviceName: ((clientId: string) => Promise<string | undefined>) | undefined;
  /** requestId -> what is being sent for it. */
  private readonly sending = new Map<string, Decision | 'answer'>();
  /** requestId -> the answers being sent, for the answered line. */
  private readonly sentAnswers = new Map<string, Record<string, string[]>>();
  private readonly errors = new Map<string, string>();
  private readonly drafts = new Map<string, Record<string, QuestionDraft>>();
  /** Requests on screen at the last change, to describe the ones that go. */
  private shown = new Map<string, Shown>();
  /** Answered lines, in the order the cards were answered. */
  private answeredRows = new Map<string, AnsweredRow>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(options: ApprovalsModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.replica = options.replica;
    this.clientId = options.clientId;
    this.deviceName = options.deviceName;
    this.shown = this.current();
    this.unsubscribe = this.replica.subscribe(() => {
      this.reconcile();
      this.changed();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  // ---- reading ----------------------------------------------------------------------------------

  private get view(): SessionView | undefined {
    return this.replica.session(this.sessionId);
  }

  /** Approval cards, oldest first. */
  get approvals(): ApprovalCardState[] {
    const requests = Object.values(this.view?.approvals ?? {}).sort((a, b) => a.createdAt - b.createdAt);
    return requests.map((request) => {
      const sending = this.sending.get(request.requestId);
      const error = this.errors.get(request.requestId);
      return {
        ...approvalCard(request),
        ...(sending !== undefined && sending !== 'answer' ? { sending } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    });
  }

  /** Every question card, in arrival order. */
  get questions(): QuestionCardState[] {
    return Object.values(this.view?.inputs ?? {}).map((request) => this.questionCard(request));
  }

  /** Questions that do not block the turn: shown inline with the conversation. */
  get inlineQuestions(): QuestionCardState[] {
    return this.questions.filter((q) => !q.blocking);
  }

  /** Blocking questions: pinned to the bottom of the screen until answered. */
  get pinnedQuestions(): QuestionCardState[] {
    return this.questions.filter((q) => q.blocking);
  }

  /** Every answered line, in the order the cards were answered. */
  get answered(): AnsweredRow[] {
    return [...this.answeredRows.values()];
  }

  get count(): number {
    const view = this.view;
    return view === undefined ? 0 : Object.keys(view.approvals).length + Object.keys(view.inputs).length;
  }

  private questionCard(request: InputRequestBody): QuestionCardState {
    const drafts = this.drafts.get(request.requestId) ?? {};
    const error = this.errors.get(request.requestId);
    return {
      requestId: request.requestId,
      title: questionTitle(request.questions),
      blocking: request.isBlocking,
      questions: request.questions.map((q) => questionView(q, drafts[q.id])),
      canSubmit: canSubmit(request, drafts) && !this.sending.has(request.requestId),
      sending: this.sending.has(request.requestId),
      ...(error !== undefined ? { error } : {}),
    };
  }

  // ---- actions ----------------------------------------------------------------------------------

  /** approval/resolve with `decision`; the card goes when the host confirms (or someone else won). */
  async decide(requestId: string, decision: Decision): Promise<void> {
    const request = this.view?.approvals[requestId];
    if (request === undefined || this.sending.has(requestId)) return;
    if (!request.availableDecisions.includes(decision)) return;
    await this.send(requestId, decision, () => this.replica.resolveApproval(this.sessionId, requestId, decision));
  }

  /** Picks or unpicks an option of a question. */
  toggle(requestId: string, questionId: string, label: string): void {
    this.edit(requestId, questionId, (q, d) => toggleOption(q, d, label));
  }

  /** Taps the "Other…" row of a question. */
  chooseOther(requestId: string, questionId: string): void {
    this.edit(requestId, questionId, (q, d) => pickOther(q, d));
  }

  /** Types the free-text answer of a question. */
  setText(requestId: string, questionId: string, text: string): void {
    this.edit(requestId, questionId, (q, d) => setOther(q, d, text));
  }

  /** input/answer with every question's answer keyed by its id. */
  async submit(requestId: string): Promise<void> {
    const request = this.view?.inputs[requestId];
    if (request === undefined || this.sending.has(requestId)) return;
    const drafts = this.drafts.get(requestId) ?? {};
    if (!canSubmit(request, drafts)) return;
    const answers = answersOf(request, drafts);
    this.sentAnswers.set(requestId, answers);
    await this.send(requestId, 'answer', () => this.replica.answerInput(this.sessionId, requestId, answers));
  }

  // ---- internals --------------------------------------------------------------------------------

  private edit(requestId: string, questionId: string, change: (q: InputRequestBody['questions'][number], d: QuestionDraft) => QuestionDraft): void {
    const request = this.view?.inputs[requestId];
    const question = request?.questions.find((q) => q.id === questionId);
    if (question === undefined || this.sending.has(requestId)) return;
    const drafts = { ...(this.drafts.get(requestId) ?? {}) };
    drafts[questionId] = change(question, drafts[questionId] ?? EMPTY_DRAFT);
    this.drafts.set(requestId, drafts);
    this.errors.delete(requestId);
    this.changed();
  }

  private async send(requestId: string, what: Decision | 'answer', call: () => Promise<ResolveOutcome>): Promise<void> {
    const shown = this.shown.get(requestId);
    this.sending.set(requestId, what);
    this.errors.delete(requestId);
    this.changed();
    try {
      const outcome = await call();
      if (shown !== undefined) {
        if (outcome.status === 'ok') this.answer(requestId, shown, { by: 'me' }, what);
        else if (outcome.status === 'not_found') this.answer(requestId, shown, { by: 'gone' });
        else this.answerElsewhere(requestId, shown, outcome.resolvedBy, this.replica.resolution(requestId));
      }
    } catch (error) {
      this.errors.set(requestId, `Not sent: ${errorText(error)}`);
    } finally {
      this.sending.delete(requestId);
      this.sentAnswers.delete(requestId);
      this.changed();
    }
  }

  private current(): Map<string, Shown> {
    const view = this.view;
    const now = new Map<string, Shown>();
    if (view === undefined) return now;
    for (const request of Object.values(view.approvals)) now.set(request.requestId, shownOf(request));
    for (const request of Object.values(view.inputs)) now.set(request.requestId, shownOf(request));
    return now;
  }

  /** Cards that went away leave their answered line; their local state is dropped. */
  private reconcile(): void {
    const now = this.current();
    for (const [requestId, shown] of this.shown) {
      if (now.has(requestId)) continue;
      this.drafts.delete(requestId);
      this.errors.delete(requestId);
      const what = this.sending.get(requestId);
      // Our own answer in flight: the card turns into our line at once (the outcome corrects it if
      // someone else was first), so it never vanishes before its line shows.
      if (what !== undefined) this.answer(requestId, shown, { by: 'me' }, what);
      else {
        const resolution = this.replica.resolution(requestId);
        this.answerElsewhere(requestId, shown, resolution?.resolvedBy, resolution);
      }
    }
    this.shown = now;
  }

  /** The line for a request resolved by `resolvedBy` (a clientId, "agent", or unknown). */
  private answerElsewhere(requestId: string, shown: Shown, resolvedBy: string | undefined, resolution: Resolution | undefined): void {
    if (resolvedBy === undefined) {
      this.answer(requestId, shown, { by: 'unknown' });
      return;
    }
    const decision = resolution?.decision;
    const answers = resolution?.answers;
    if (resolvedBy === 'agent') {
      this.answer(requestId, shown, { by: 'agent' });
      return;
    }
    if (this.clientId !== undefined && resolvedBy === this.clientId) {
      this.answer(requestId, shown, { by: 'me' }, decision ?? 'answer', answers);
      return;
    }
    this.answer(requestId, shown, { by: 'device' }, decision ?? 'answer', answers);
    if (this.deviceName === undefined) return;
    this.deviceName(resolvedBy).then(
      (name) => {
        if (this.disposed || name === undefined || !this.answeredRows.has(requestId)) return;
        this.answer(requestId, shown, { by: 'device', name }, decision ?? 'answer', answers);
        this.changed();
      },
      () => undefined,
    );
  }

  private answer(requestId: string, shown: Shown, resolver: Resolver, what?: Decision | 'answer', answers?: Record<string, string[]>): void {
    const text =
      shown.kind === 'approval'
        ? approvalAnswered(resolver, what === 'answer' ? undefined : what)
        : questionAnswered(resolver, answerSummary(shown.questions, answers ?? this.sentAnswers.get(requestId) ?? {}));
    // Keeps its place among the answered lines when a later outcome or a device name rewrites it.
    this.answeredRows.set(requestId, {
      requestId,
      kind: shown.kind,
      requestKind: shown.requestKind,
      turnId: shown.turnId,
      itemId: shown.itemId,
      title: shown.title,
      ...text,
    });
  }
}
