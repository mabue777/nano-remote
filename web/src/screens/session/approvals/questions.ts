// Question forms (spec 5.3, input/request): the draft a user builds per question, and the input/answer
// payload, answers keyed by question id. Pure functions.
//
// Rules: options are a list; one pick unless the question has `multiSelect`. `isOther` adds a free-text
// answer (with options it is the "Other" choice; picking an option in a single-pick question clears it
// and typing clears the pick; on the card it is the "Other…" row, whose field shows once it is chosen). A
// question with no options is free text only. `isSecret` masks typed text.
// Each answer is the picked labels, in option order, plus the trimmed free text when there is any.
import type { InputRequestBody } from '../../../replica/types';

export type Question = InputRequestBody['questions'][number];

export interface QuestionDraft {
  selected: string[];
  other: string;
  /** The "Other…" row is chosen: its text field shows (a question with options and isOther only). */
  otherOn: boolean;
}

export const EMPTY_DRAFT: QuestionDraft = { selected: [], other: '', otherOn: false };

export function isMulti(question: Question): boolean {
  return (question as { multiSelect?: unknown }).multiSelect === true;
}

function options(question: Question): { label: string; description: string }[] {
  return Array.isArray(question.options) ? question.options : [];
}

/** Free text is offered when the question allows "other", or has no options to pick from. */
export function allowsText(question: Question): boolean {
  return question.isOther || options(question).length === 0;
}

/** Picks or unpicks an option: a toggle in a multi-select question, a replacement otherwise. */
export function toggleOption(question: Question, draft: QuestionDraft, label: string): QuestionDraft {
  if (!options(question).some((o) => o.label === label)) return draft;
  if (isMulti(question)) {
    const selected = draft.selected.includes(label) ? draft.selected.filter((l) => l !== label) : [...draft.selected, label];
    return { ...draft, selected };
  }
  if (draft.selected.length === 1 && draft.selected[0] === label) return { ...draft, selected: [] };
  return { selected: [label], other: '', otherOn: false };
}

/** The "Other…" row is offered: a question with options that allows its own answer. */
export function hasOtherRow(question: Question): boolean {
  return question.isOther && options(question).length > 0;
}

/**
 * Taps the "Other…" row. In a single pick it becomes the choice (the picked option goes, typed text stays);
 * in a multi-select it toggles, and closing it drops its text.
 */
export function pickOther(question: Question, draft: QuestionDraft): QuestionDraft {
  if (!hasOtherRow(question)) return draft;
  if (!isMulti(question)) return { selected: [], other: draft.other, otherOn: true };
  return draft.otherOn ? { ...draft, other: '', otherOn: false } : { ...draft, otherOn: true };
}

/** Types the free-text answer; in a single-pick question this replaces the picked option. */
export function setOther(question: Question, draft: QuestionDraft, text: string): QuestionDraft {
  if (!allowsText(question)) return draft;
  if (!isMulti(question) && text !== '') return { selected: [], other: text, otherOn: true };
  return { ...draft, other: text };
}

/** One question's answer: picked labels in option order, then the free text if any. */
export function answerOf(question: Question, draft: QuestionDraft | undefined): string[] {
  const d = draft ?? EMPTY_DRAFT;
  const picked = options(question)
    .map((o) => o.label)
    .filter((label) => d.selected.includes(label));
  const text = allowsText(question) ? d.other.trim() : '';
  return text !== '' ? [...picked, text] : picked;
}

export function isAnswered(question: Question, draft: QuestionDraft | undefined): boolean {
  return answerOf(question, draft).length > 0;
}

/** The input/answer `answers` map, keyed by question id. */
export function answersOf(request: Pick<InputRequestBody, 'questions'>, drafts: Readonly<Record<string, QuestionDraft>>): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const question of request.questions) answers[question.id] = answerOf(question, drafts[question.id]);
  return answers;
}

/** The card's bold title: the question itself, or how many there are when the form asks several. */
export function questionTitle(questions: readonly Pick<Question, 'question'>[]): string {
  if (questions.length === 1) return questions[0]!.question;
  return questions.length === 0 ? 'Question' : `${questions.length} questions`;
}

/** What a question looks like on the card: its options with their state, and the free-text field. */
export interface QuestionView {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; selected: boolean }[];
  multi: boolean;
  /** Free text offered: "Other…" next to options, or the only answer when there are none. */
  text: boolean;
  /** The free text is the "Other…" row next to options. */
  isOther: boolean;
  /** The "Other…" row is chosen, so its field shows. */
  otherOn: boolean;
  secret: boolean;
  other: string;
}

export function questionView(question: Question, draft: QuestionDraft | undefined): QuestionView {
  const d = draft ?? EMPTY_DRAFT;
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    options: options(question).map((o) => ({ label: o.label, description: o.description, selected: d.selected.includes(o.label) })),
    multi: isMulti(question),
    text: allowsText(question),
    isOther: hasOtherRow(question),
    otherOn: d.otherOn || (hasOtherRow(question) && d.other !== ''),
    secret: question.isSecret,
    other: d.other,
  };
}

/** The answers in one line, for the answered card: picks joined by commas, questions by dots; secrets hidden. */
export function answerSummary(questions: readonly Pick<Question, 'id' | 'isSecret'>[], answers: Readonly<Record<string, readonly string[]>>): string {
  return questions
    .map((q) => {
      const answer = answers[q.id] ?? [];
      if (answer.length === 0) return '';
      return q.isSecret ? '••••' : answer.join(', ');
    })
    .filter((text) => text !== '')
    .join(' · ');
}

/** Every question answered. */
export function canSubmit(request: Pick<InputRequestBody, 'questions'>, drafts: Readonly<Record<string, QuestionDraft>>): boolean {
  return request.questions.every((q) => isAnswered(q, drafts[q.id]));
}
