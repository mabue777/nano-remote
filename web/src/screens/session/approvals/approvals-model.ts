// The session's pending requests as cards (spec 5.3): approval cards with their decision buttons, question
// forms, and the short notices left when a card goes away because someone else answered.
//
// The cards come straight from the Replica's view (`approvals`, `inputs`), which session/open fills with
// `pending` on open and after every reconnect and which `request/resolved` empties, so a card shows as soon
// as the view has it and goes when the host says so. This model adds what only the screen knows: the
// decision or answer in flight, a refused send's error, the question drafts, and the notices.
//
// Notices: a card that disappears while this device was not answering it, or whose answer came back
// `already_resolved`, leaves "Answered on <device>" (the device named by request/resolved, looked up with
// device/list), or "Withdrawn by the agent". Notices fade after `noticeMs`.
import type { Resolution, ResolveOutcome } from '../../../replica/replica';
import type { ApprovalRequestBody, Decision, InputRequestBody, SessionView } from '../../../replica/types';
import { errorText, Model } from '../../model';
import { approvalCard, resolvedNotice, type ApprovalCardView } from './decisions';
import {
  allowsText,
  answersOf,
  canSubmit,
  EMPTY_DRAFT,
  isMulti,
  setOther,
  toggleOption,
  type QuestionDraft,
} from './questions';

/** What the cards need from the Replica; Replica fits. */
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
  /** How long a notice stays; 0 keeps it until dismissed. */
  noticeMs?: number;
}

export interface ApprovalCardState extends ApprovalCardView {
  /** The decision being sent, if any; every button is disabled meanwhile. */
  sending?: Decision;
  error?: string;
}

export interface QuestionView {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; selected: boolean }[];
  multi: boolean;
  /** Free text offered: "Other" next to options, or the only answer when there are none. */
  text: boolean;
  /** True when the free text is the "Other" choice next to options. */
  isOther: boolean;
  secret: boolean;
  other: string;
}

export interface QuestionCardState {
  requestId: string;
  blocking: boolean;
  questions: QuestionView[];
  canSubmit: boolean;
  sending: boolean;
  error?: string;
}

export interface Notice {
  requestId: string;
  title: string;
  text: string;
}

const NOTICE_MS = 5000;

function titleOf(request: ApprovalRequestBody | InputRequestBody): string {
  if (request.kind === 'input') {
    const first = request.questions[0];
    return first === undefined ? 'Question' : first.header !== '' ? first.header : first.question;
  }
  return approvalCard(request).title;
}

export class ApprovalsModel extends Model {
  readonly sessionId: string;
  private readonly replica: ApprovalsReplica;
  private readonly clientId: string | undefined;
  private readonly deviceName: ((clientId: string) => Promise<string | undefined>) | undefined;
  private readonly noticeMs: number;
  /** requestId -> what is being sent for it. */
  private readonly sending = new Map<string, Decision | 'answer'>();
  private readonly errors = new Map<string, string>();
  private readonly drafts = new Map<string, Record<string, QuestionDraft>>();
  /** Requests on screen at the last change, with their title, to notice the ones that go. */
  private shown = new Map<string, string>();
  private noticeList: Notice[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(options: ApprovalsModelOptions) {
    super();
    this.sessionId = options.sessionId;
    this.replica = options.replica;
    this.clientId = options.clientId;
    this.deviceName = options.deviceName;
    this.noticeMs = options.noticeMs ?? NOTICE_MS;
    this.shown = this.current();
    this.unsubscribe = this.replica.subscribe(() => {
      this.reconcile();
      this.changed();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
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

  get notices(): readonly Notice[] {
    return this.noticeList;
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
      blocking: request.isBlocking,
      questions: request.questions.map((q) => {
        const draft = drafts[q.id] ?? EMPTY_DRAFT;
        return {
          id: q.id,
          header: q.header,
          question: q.question,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description, selected: draft.selected.includes(o.label) })),
          multi: isMulti(q),
          text: allowsText(q),
          isOther: q.isOther && (q.options ?? []).length > 0,
          secret: q.isSecret,
          other: draft.other,
        };
      }),
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
    await this.send(requestId, 'answer', () => this.replica.answerInput(this.sessionId, requestId, answers));
  }

  dismissNotice(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(requestId);
    const before = this.noticeList.length;
    this.noticeList = this.noticeList.filter((n) => n.requestId !== requestId);
    if (this.noticeList.length !== before) this.changed();
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
    const title = this.shown.get(requestId) ?? 'Request';
    this.sending.set(requestId, what);
    this.errors.delete(requestId);
    this.changed();
    try {
      const outcome = await call();
      if (outcome.status === 'already_resolved') this.notice(requestId, title, outcome.resolvedBy);
      else if (outcome.status === 'not_found') this.addNotice({ requestId, title, text: 'No longer waiting for an answer' });
    } catch (error) {
      this.errors.set(requestId, `Not sent: ${errorText(error)}`);
    } finally {
      this.sending.delete(requestId);
      this.changed();
    }
  }

  private current(): Map<string, string> {
    const view = this.view;
    const now = new Map<string, string>();
    if (view === undefined) return now;
    for (const request of Object.values(view.approvals)) now.set(request.requestId, titleOf(request));
    for (const request of Object.values(view.inputs)) now.set(request.requestId, titleOf(request));
    return now;
  }

  /** Cards that went away: a notice unless this device answered them; their local state is dropped. */
  private reconcile(): void {
    const now = this.current();
    for (const [requestId, title] of this.shown) {
      if (now.has(requestId)) continue;
      this.drafts.delete(requestId);
      this.errors.delete(requestId);
      // Our own answer in flight: its outcome decides (already_resolved names the winner).
      if (this.sending.has(requestId)) continue;
      this.notice(requestId, title, this.replica.resolution(requestId)?.resolvedBy);
    }
    this.shown = now;
  }

  private notice(requestId: string, title: string, resolvedBy: string | undefined): void {
    const text = resolvedNotice(resolvedBy, this.clientId, undefined);
    if (text === undefined) return;
    this.addNotice({ requestId, title, text });
    if (resolvedBy === undefined || resolvedBy === 'agent' || this.deviceName === undefined) return;
    this.deviceName(resolvedBy).then(
      (name) => {
        const named = resolvedNotice(resolvedBy, this.clientId, name);
        const notice = this.noticeList.find((n) => n.requestId === requestId);
        if (this.disposed || notice === undefined || named === undefined || named === notice.text) return;
        this.noticeList = this.noticeList.map((n) => (n.requestId === requestId ? { ...n, text: named } : n));
        this.changed();
      },
      () => undefined,
    );
  }

  private addNotice(notice: Notice): void {
    if (this.noticeList.some((n) => n.requestId === notice.requestId)) return;
    this.noticeList = [...this.noticeList, notice];
    if (this.noticeMs > 0) {
      this.timers.set(
        notice.requestId,
        setTimeout(() => this.dismissNotice(notice.requestId), this.noticeMs),
      );
    }
  }
}
