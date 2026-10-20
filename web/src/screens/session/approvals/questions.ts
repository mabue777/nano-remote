// Question forms (spec 5.3, input/request): the draft a user builds per question, and the input/answer
// payload, answers keyed by question id. Pure functions.
//
// Rules: options are a list; one pick unless the question has `multiSelect`. `isOther` adds a free-text
// answer (with options it is the "Other" choice; picking an option in a single-pick question clears it
// and typing clears the pick). A question with no options is free text only. `isSecret` masks typed text.
// Each answer is the picked labels, in option order, plus the trimmed free text when there is any.
import type { InputRequestBody } from '../../../replica/types';

export type Question = InputRequestBody['questions'][number];

export interface QuestionDraft {
  selected: string[];
  other: string;
}

export const EMPTY_DRAFT: QuestionDraft = { selected: [], other: '' };

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
  return { selected: [label], other: '' };
}

/** Types the free-text answer; in a single-pick question this replaces the picked option. */
export function setOther(question: Question, draft: QuestionDraft, text: string): QuestionDraft {
  if (!allowsText(question)) return draft;
  if (!isMulti(question) && text !== '') return { selected: [], other: text };
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

/** Every question answered. */
export function canSubmit(request: Pick<InputRequestBody, 'questions'>, drafts: Readonly<Record<string, QuestionDraft>>): boolean {
  return request.questions.every((q) => isAnswered(q, drafts[q.id]));
}
