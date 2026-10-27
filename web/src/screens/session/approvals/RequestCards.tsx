// Approval and question cards and the one line each leaves once answered (spec 5.3; the New look's items 5
// and 13, docs/research/new-look-prototype.md). A soft grey card: an icon and a bold title, the subject in a
// white inner box, one ink pill (Accept, Send answer) and one grey pill (Decline); Accept for this session
// and Cancel the turn open in place under More. Answered, the card keeps its place, one line high.
//
// The cards (ApprovalCard, QuestionCard, AnsweredLine) only render what they are given and report taps, so
// the lab's New look (lab/NewLook.tsx) shows the same cards with its own data. InlineRequests and
// PinnedQuestions connect them to ApprovalsModel, where all state and rules live.
//
// Expand and collapse: the card's grey background is a separate layer (`.shell`) carrying the card's
// data-shell-key; when a card turns into its answered line (same key), the session view's FLIP
// (motion-hooks.tsx useFlip) scales that layer from the card's height to the line's and slides the line
// into place. Only transform and opacity animate; with Reduce Motion nothing does.
import { useEffect, useRef, useState } from 'preact/hooks';

import { Icon, type IconName } from '../../../ui/Icon';
import { hapticTick } from '../../../ui/motion/haptic';
import type { Decision } from '../../../replica/types';
import type { AnsweredRow, ApprovalCardState, ApprovalsModel, QuestionCardState } from './approvals-model';
import { groupButtons } from './decisions';
import type { QuestionView } from './questions';

/** The FLIP and shell key of a request's card and of the line it leaves. */
export function requestKey(requestId: string): string {
  return `request/${requestId}`;
}

function iconOf(requestKind: string): IconName {
  if (requestKind === 'input') return 'question';
  if (requestKind === 'fileChange') return 'file-diff';
  return 'terminal';
}

function Shell() {
  return <span class="shell" aria-hidden="true" />;
}

// ---- connected to the model -------------------------------------------------------------------------

/**
 * Pending approval cards and non-blocking questions, at the end of the conversation, after `answered`:
 * the answered lines whose turn is not on screen (the others sit in their turn, AnsweredLines).
 */
export function InlineRequests({ model, answered = [] }: { model: ApprovalsModel; answered?: AnsweredRow[] }) {
  const approvals = model.approvals;
  const questions = model.inlineQuestions;
  if (approvals.length === 0 && questions.length === 0 && answered.length === 0) return null;
  return (
    <div class="requests" aria-label="Requests">
      {answered.map((row) => (
        <AnsweredLine key={row.requestId} row={row} />
      ))}
      {approvals.map((card) => (
        <ApprovalCard key={card.requestId} card={card} onDecide={(decision) => void model.decide(card.requestId, decision)} />
      ))}
      {questions.map((card) => (
        <ModelQuestionCard key={card.requestId} card={card} model={model} />
      ))}
    </div>
  );
}

/** Blocking questions, riding on the composer bar until answered. */
export function PinnedQuestions({ model }: { model: ApprovalsModel }) {
  const pinned = model.pinnedQuestions;
  if (pinned.length === 0) return null;
  return (
    <section class="pinned-questions" aria-label="Waiting for your answer">
      {pinned.map((card) => (
        <ModelQuestionCard key={card.requestId} card={card} model={model} />
      ))}
    </section>
  );
}

/** Answered lines inside a turn. */
export function AnsweredLines({ rows }: { rows: readonly AnsweredRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <AnsweredLine key={row.requestId} row={row} />
      ))}
    </>
  );
}

function ModelQuestionCard({ card, model }: { card: QuestionCardState; model: ApprovalsModel }) {
  return (
    <QuestionCard
      card={card}
      onToggle={(questionId, label) => model.toggle(card.requestId, questionId, label)}
      onOther={(questionId) => model.chooseOther(card.requestId, questionId)}
      onText={(questionId, text) => model.setText(card.requestId, questionId, text)}
      onSubmit={() => void model.submit(card.requestId)}
    />
  );
}

// ---- the cards --------------------------------------------------------------------------------------

export interface CardMotion {
  /** FLIP and shell key; the request's own by default. */
  flipKey?: string;
  /** The grey background is a separate layer that the expand and collapse motion scales (default true). */
  shelled?: boolean;
  /** Content that appears (the More list, the answered line) fades in (default true). */
  reveal?: boolean;
}

/** An approval: icon and title, the command or the changed files in the inner box, Accept, Decline, More. */
export function ApprovalCard({
  card,
  onDecide,
  haptic = hapticTick,
  flipKey,
  shelled = true,
  reveal = true,
}: { card: ApprovalCardState; onDecide: (decision: Decision) => void; haptic?: () => void } & CardMotion) {
  const [moreOpen, setMoreOpen] = useState(false);
  const key = flipKey ?? requestKey(card.requestId);
  const { main, more } = groupButtons(card.buttons);
  const busy = card.sending !== undefined;
  const body = card.body;
  const decide = (decision: Decision) => {
    if (decision === 'accept' || decision === 'acceptForSession') haptic();
    onDecide(decision);
  };
  const label = (decision: Decision, text: string) => (card.sending === decision ? 'Sending…' : text);
  return (
    <section
      class={`request-card approval ${card.kind}${shelled ? ' shelled' : ''}`}
      role="group"
      aria-label={`Approval: ${card.title}`}
      aria-busy={busy}
      data-request-id={card.requestId}
      data-kind={card.kind}
      data-flip-key={key}
      data-shell-key={key}
    >
      {shelled && <Shell />}
      <div class="request-head">
        <Icon name={iconOf(card.kind)} size={18} />
        <h2 class="request-title">{card.title}</h2>
      </div>
      {body.kind === 'command' && (
        <div class="request-inner">
          <pre class="request-command" title={body.fullCommand}>
            {body.command}
          </pre>
          <p class="request-meta">
            in <span class="request-cwd">{body.cwd}</span>
            {card.reason !== '' && ` · ${card.reason}`}
          </p>
        </div>
      )}
      {body.kind === 'fileChange' && (
        <div class="request-inner">
          <ul class="request-files" aria-label="Changed files">
            {body.files.map((file) => (
              <li key={file.path}>
                <div class="request-file">
                  <span class={`kind ${file.kind}`}>{file.kind === 'add' ? 'new' : file.kind === 'delete' ? 'delete' : 'edit'}</span> <code>{file.path}</code>
                </div>
                {file.preview.lines.length > 0 && (
                  <pre class="diff" aria-label={`Diff of ${file.path}`}>
                    {file.preview.lines.map((line, i) => (
                      <span key={i} class={`diff-line ${line.tone}`}>
                        {line.text}
                        {'\n'}
                      </span>
                    ))}
                    {file.preview.more > 0 && <span class="diff-line more">… {file.preview.more} more lines</span>}
                  </pre>
                )}
              </li>
            ))}
          </ul>
          {body.grantRoot !== undefined && (
            <p class="request-meta">
              Also allows writing under <code>{body.grantRoot}</code>
            </p>
          )}
          {card.reason !== '' && <p class="request-meta">{card.reason}</p>}
        </div>
      )}
      {body.kind === 'permission' && (body.scope !== undefined || card.reason !== '') && (
        <div class="request-inner">
          {body.scope !== undefined && <p class="request-meta">{body.scope === 'session' ? 'For the rest of the session' : 'For this turn'}</p>}
          {card.reason !== '' && <p class="request-meta">{card.reason}</p>}
        </div>
      )}
      {card.error !== undefined && (
        <p class="error small request-error" role="alert">
          {card.error}
        </p>
      )}
      <div class="request-actions">
        {main.map((button) => (
          <button
            key={button.decision}
            type="button"
            class={`request-pill${button.tone === 'primary' ? ' primary' : ''}`}
            title={button.hint}
            disabled={busy}
            data-decision={button.decision}
            onClick={() => decide(button.decision)}
          >
            {label(button.decision, button.label)}
          </button>
        ))}
        {more.length > 0 && (
          <button type="button" class="request-more-button" aria-expanded={moreOpen} disabled={busy} onClick={() => setMoreOpen(!moreOpen)}>
            More
          </button>
        )}
      </div>
      {moreOpen && more.length > 0 && (
        <div class={`request-more${reveal ? ' request-reveal' : ''}`} role="group" aria-label="More choices">
          {more.map((button) => (
            <button
              key={button.decision}
              type="button"
              class="request-menu-row"
              title={button.hint}
              disabled={busy}
              data-decision={button.decision}
              onClick={() => decide(button.decision)}
            >
              {label(button.decision, button.label)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export interface QuestionHandlers {
  onToggle: (questionId: string, label: string) => void;
  onOther: (questionId: string) => void;
  onText: (questionId: string, text: string) => void;
  onSubmit: () => void;
}

/** A question form: icon and the bold question, the options as rows in one inner box, one Send answer pill. */
export function QuestionCard({ card, flipKey, shelled = true, onToggle, onOther, onText, onSubmit }: { card: QuestionCardState } & QuestionHandlers & CardMotion) {
  const key = flipKey ?? requestKey(card.requestId);
  const single = card.questions.length === 1;
  const first = card.questions[0];
  const sub = single && first !== undefined ? [first.header, first.multi ? 'Pick any' : ''].filter((part) => part !== '').join(' · ') : '';
  return (
    <form
      class={`request-card question${card.blocking ? ' blocking' : ''}${shelled ? ' shelled' : ''}`}
      role="group"
      aria-label={`Question: ${card.title}`}
      aria-busy={card.sending}
      data-request-id={card.requestId}
      data-blocking={card.blocking ? 'true' : 'false'}
      data-flip-key={key}
      data-shell-key={key}
      onSubmit={(event) => {
        event.preventDefault();
        if (card.canSubmit) onSubmit();
      }}
    >
      {shelled && <Shell />}
      <div class="request-head">
        <Icon name="question" size={18} />
        <h2 class="request-title">{card.title}</h2>
      </div>
      {sub !== '' && <p class="request-sub">{sub}</p>}
      {card.questions.map((question) => (
        <QuestionField
          key={question.id}
          requestId={card.requestId}
          question={question}
          legendHidden={single}
          disabled={card.sending}
          onToggle={(label) => onToggle(question.id, label)}
          onOther={() => onOther(question.id)}
          onText={(text) => onText(question.id, text)}
        />
      ))}
      {card.error !== undefined && (
        <p class="error small request-error" role="alert">
          {card.error}
        </p>
      )}
      <div class="request-actions">
        <button type="submit" class="request-pill primary" disabled={!card.canSubmit}>
          {card.sending ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </form>
  );
}

interface FieldProps {
  requestId: string;
  question: QuestionView;
  /** One question: the card's title already says it, so the legend is for screen readers only. */
  legendHidden: boolean;
  disabled: boolean;
  onToggle: (label: string) => void;
  onOther: () => void;
  onText: (text: string) => void;
}

function QuestionField({ requestId, question, legendHidden, disabled, onToggle, onOther, onText }: FieldProps) {
  const name = `${requestId}-${question.id}`;
  const label = question.header !== '' ? question.header : question.question;
  const type = question.multi ? 'checkbox' : 'radio';
  const field = useRef<HTMLInputElement>(null);
  // Choosing "Other…" puts the caret in its field.
  const otherOn = question.isOther && question.otherOn;
  const wasOn = useRef(otherOn);
  useEffect(() => {
    if (otherOn && !wasOn.current) field.current?.focus();
    wasOn.current = otherOn;
  }, [otherOn]);
  const textInput = (
    <input
      ref={field}
      class="question-text-input"
      type={question.secret ? 'password' : 'text'}
      autoComplete={question.secret ? 'off' : undefined}
      aria-label={question.isOther ? `Other answer to ${label}` : `Answer to ${label}`}
      placeholder={question.isOther ? 'Your answer' : question.secret ? 'Hidden answer' : 'Your answer'}
      value={question.other}
      onInput={(event) => onText((event.currentTarget as HTMLInputElement).value)}
    />
  );
  return (
    <fieldset class="question-field" data-question-id={question.id} disabled={disabled}>
      <legend class={legendHidden ? 'visually-hidden' : 'question-legend'}>
        {question.header !== '' && <span class="question-header">{question.header}</span>}
        <span class="question-text">{question.question}</span>
        {question.multi && <span class="question-hint"> (pick any)</span>}
      </legend>
      {question.options.length > 0 ? (
        <div class="request-inner question-options">
          {question.options.map((option) => (
            <label key={option.label} class={`option${option.selected ? ' selected' : ''}`}>
              <input type={type} name={name} value={option.label} checked={option.selected} onClick={() => onToggle(option.label)} onChange={() => undefined} />
              <span class={`option-mark ${type}`} aria-hidden="true">
                {option.selected && <Icon name="check" size={14} />}
              </span>
              <span class="option-text">
                <span class="option-label">{option.label}</span>
                {option.description !== '' && <span class="option-description">{option.description}</span>}
              </span>
            </label>
          ))}
          {question.isOther && (
            <label class={`option other${otherOn ? ' selected' : ''}`}>
              <input type={type} name={name} value="" checked={otherOn} aria-label="Other…" onClick={onOther} onChange={() => undefined} />
              <span class={`option-mark ${type}`} aria-hidden="true">
                {otherOn && <Icon name="check" size={14} />}
              </span>
              <span class="option-text">
                <span class="option-label">Other…</span>
              </span>
            </label>
          )}
          {otherOn && <div class="option-field">{textInput}</div>}
        </div>
      ) : (
        question.text && <div class="request-inner question-free">{textInput}</div>
      )}
    </fieldset>
  );
}

/** The one line an answered card leaves: a check or a cross, the title, and the outcome or the answer. */
export function AnsweredLine({ row, flipKey, shelled = true, reveal = true }: { row: AnsweredRow } & CardMotion) {
  const key = flipKey ?? requestKey(row.requestId);
  return (
    <section
      class={`request-answered ${row.kind}${shelled ? ' shelled' : ''}`}
      aria-label={row.kind === 'approval' ? 'Approval answered' : 'Question answered'}
      data-request-id={row.requestId}
      data-tone={row.tone}
      data-flip-key={key}
      data-shell-key={key}
    >
      {shelled && <Shell />}
      <div class={`request-answered-line${reveal ? ' request-reveal' : ''}`}>
        <Icon name={row.mark} size={18} class="request-answered-mark" />
        <span class="request-answered-title">{row.title}</span>
        <span class={`request-answered-text ${row.tone}`}>
          <span class="request-answered-words">{row.text}</span>
          {row.tone === 'ok' && <Icon name="check-circle" size={18} />}
        </span>
      </div>
    </section>
  );
}
