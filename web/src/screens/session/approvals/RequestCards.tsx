// Approval cards, question forms and "answered elsewhere" notices (spec 5.3). All state and rules live in
// ApprovalsModel; these components render it. Inline cards sit at the end of the conversation; blocking
// questions are pinned above the composer.
import { hapticTick } from '../../../ui/motion/haptic';
import type { ApprovalsModel, ApprovalCardState, Notice, QuestionCardState, QuestionView } from './approvals-model';

/** Approval cards, non-blocking questions and notices, at the end of the conversation. */
export function InlineRequests({ model }: { model: ApprovalsModel }) {
  const approvals = model.approvals;
  const questions = model.inlineQuestions;
  const notices = model.notices;
  if (approvals.length === 0 && questions.length === 0 && notices.length === 0) return null;
  return (
    <div class="requests" aria-label="Pending requests">
      {approvals.map((card) => (
        <ApprovalCard key={card.requestId} card={card} model={model} />
      ))}
      {questions.map((card) => (
        <QuestionCard key={card.requestId} card={card} model={model} />
      ))}
      {notices.map((notice) => (
        <NoticeRow key={notice.requestId} notice={notice} model={model} />
      ))}
    </div>
  );
}

/** Blocking questions, pinned to the bottom of the screen. */
export function PinnedQuestions({ model }: { model: ApprovalsModel }) {
  const pinned = model.pinnedQuestions;
  if (pinned.length === 0) return null;
  return (
    <section class="pinned-questions" aria-label="Waiting for your answer">
      {pinned.map((card) => (
        <QuestionCard key={card.requestId} card={card} model={model} />
      ))}
    </section>
  );
}

function ApprovalCard({ card, model }: { card: ApprovalCardState; model: ApprovalsModel }) {
  const body = card.body;
  return (
    <section
      class={`request-card approval ${card.kind}`}
      role="group"
      aria-label={`Approval: ${card.title}`}
      aria-busy={card.sending !== undefined}
      data-request-id={card.requestId}
      data-kind={card.kind}
    >
      <h2 class="request-title">{card.title}</h2>
      {body.kind === 'command' && (
        <>
          <pre class="request-command" title={body.fullCommand}>
            {body.command}
          </pre>
          <p class="muted small request-cwd">
            in <code>{body.cwd}</code>
          </p>
        </>
      )}
      {body.kind === 'fileChange' && (
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
          {body.grantRoot !== undefined && (
            <li class="muted small">
              Also allows writing under <code>{body.grantRoot}</code>
            </li>
          )}
        </ul>
      )}
      {body.kind === 'permission' && body.scope !== undefined && (
        <p class="muted small">{body.scope === 'session' ? 'For the rest of the session' : 'For this turn'}</p>
      )}
      {card.reason !== '' && <p class="request-reason">{card.reason}</p>}
      {card.error !== undefined && (
        <p class="error small" role="alert">
          {card.error}
        </p>
      )}
      <div class="request-actions">
        {card.buttons.map((button) => (
          <button
            key={button.decision}
            type="button"
            class={button.tone === 'primary' ? 'primary' : ''}
            title={button.hint}
            disabled={card.sending !== undefined}
            data-decision={button.decision}
            onClick={() => {
              if (button.decision === 'accept' || button.decision === 'acceptForSession') hapticTick();
              void model.decide(card.requestId, button.decision);
            }}
          >
            {card.sending === button.decision ? 'Sending…' : button.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function QuestionCard({ card, model }: { card: QuestionCardState; model: ApprovalsModel }) {
  return (
    <form
      class={`request-card question${card.blocking ? ' blocking' : ''}`}
      aria-label={card.blocking ? 'Question (the agent is waiting)' : 'Question'}
      aria-busy={card.sending}
      data-request-id={card.requestId}
      data-blocking={card.blocking ? 'true' : 'false'}
      onSubmit={(event) => {
        event.preventDefault();
        void model.submit(card.requestId);
      }}
    >
      {card.questions.map((question) => (
        <QuestionField key={question.id} requestId={card.requestId} question={question} disabled={card.sending} model={model} />
      ))}
      {card.error !== undefined && (
        <p class="error small" role="alert">
          {card.error}
        </p>
      )}
      <div class="request-actions">
        <button type="submit" class="primary" disabled={!card.canSubmit}>
          {card.sending ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </form>
  );
}

function QuestionField({ requestId, question, disabled, model }: { requestId: string; question: QuestionView; disabled: boolean; model: ApprovalsModel }) {
  const name = `${requestId}-${question.id}`;
  const label = question.header !== '' ? question.header : question.question;
  return (
    <fieldset class="question-field" data-question-id={question.id} disabled={disabled}>
      <legend>
        {question.header !== '' && <span class="question-header small muted">{question.header}</span>}
        <span class="question-text">{question.question}</span>
        {question.multi && <span class="small muted"> (pick any)</span>}
      </legend>
      {question.options.length > 0 && (
        <ul class="question-options">
          {question.options.map((option) => (
            <li key={option.label}>
              <label class={`option${option.selected ? ' selected' : ''}`}>
                <input
                  type={question.multi ? 'checkbox' : 'radio'}
                  name={name}
                  value={option.label}
                  checked={option.selected}
                  onClick={() => model.toggle(requestId, question.id, option.label)}
                  onChange={() => undefined}
                />
                <span>
                  <span class="option-label">{option.label}</span>
                  {option.description !== '' && <span class="option-description small muted">{option.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {question.text && (
        <input
          class="question-text-input"
          type={question.secret ? 'password' : 'text'}
          autoComplete={question.secret ? 'off' : undefined}
          aria-label={question.isOther ? `Other answer to ${label}` : `Answer to ${label}`}
          placeholder={question.isOther ? 'Other…' : question.secret ? 'Hidden answer' : 'Your answer'}
          value={question.other}
          onInput={(event) => model.setText(requestId, question.id, (event.currentTarget as HTMLInputElement).value)}
        />
      )}
    </fieldset>
  );
}

function NoticeRow({ notice, model }: { notice: Notice; model: ApprovalsModel }) {
  return (
    <div class="request-notice" role="status" data-request-id={notice.requestId}>
      <span class="small">
        <strong>{notice.title}</strong> · {notice.text}
      </span>
      <button type="button" class="ghost small" aria-label="Dismiss" onClick={() => model.dismissNotice(notice.requestId)}>
        ✕
      </button>
    </div>
  );
}
