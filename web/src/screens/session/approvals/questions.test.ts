import { describe, expect, it } from 'vitest';

import {
  allowsText,
  answerOf,
  answersOf,
  answerSummary,
  canSubmit,
  EMPTY_DRAFT,
  hasOtherRow,
  pickOther,
  questionTitle,
  questionView,
  setOther,
  toggleOption,
  type Question,
  type QuestionDraft,
} from './questions';

const options = [
  { label: 'Current folder', description: 'Where the session starts.' },
  { label: 'Desktop', description: 'On the Desktop.' },
  { label: 'Home', description: '' },
];

function question(over: Partial<Question> & Record<string, unknown> = {}): Question {
  return { id: 'folder', header: 'Folder', question: 'Which folder?', options, isOther: false, isSecret: false, ...over } as Question;
}

describe('question drafts', () => {
  it('single pick: an option replaces the previous one, and picking it again clears it', () => {
    const q = question();
    let d = toggleOption(q, EMPTY_DRAFT, 'Desktop');
    expect(d.selected).toEqual(['Desktop']);
    d = toggleOption(q, d, 'Home');
    expect(d.selected).toEqual(['Home']);
    d = toggleOption(q, d, 'Home');
    expect(d.selected).toEqual([]);
  });

  it('multi-select when flagged: options toggle independently, the answer keeps option order', () => {
    const q = question({ multiSelect: true });
    let d = toggleOption(q, EMPTY_DRAFT, 'Home');
    d = toggleOption(q, d, 'Current folder');
    d = toggleOption(q, d, 'Desktop');
    d = toggleOption(q, d, 'Desktop');
    expect(answerOf(q, d)).toEqual(['Current folder', 'Home']);
  });

  it('ignores labels that are not options', () => {
    expect(toggleOption(question(), EMPTY_DRAFT, 'Nowhere')).toBe(EMPTY_DRAFT);
  });

  it('isOther: free text next to options; in a single pick it replaces the option and vice versa', () => {
    const q = question({ isOther: true });
    expect(allowsText(q)).toBe(true);
    let d = toggleOption(q, EMPTY_DRAFT, 'Desktop');
    d = setOther(q, d, '  /tmp/x  ');
    expect(d).toEqual({ selected: [], other: '  /tmp/x  ', otherOn: true });
    expect(answerOf(q, d)).toEqual(['/tmp/x']);
    d = toggleOption(q, d, 'Home');
    expect(d).toEqual({ selected: ['Home'], other: '', otherOn: false });
  });

  it('isOther with multi-select: picks and free text together', () => {
    const q = question({ isOther: true, multiSelect: true });
    let d = toggleOption(q, EMPTY_DRAFT, 'Desktop');
    d = setOther(q, d, 'Downloads');
    expect(answerOf(q, d)).toEqual(['Desktop', 'Downloads']);
  });

  it('free text is refused when the question neither has isOther nor lacks options', () => {
    const q = question();
    expect(allowsText(q)).toBe(false);
    expect(setOther(q, EMPTY_DRAFT, 'x')).toBe(EMPTY_DRAFT);
  });

  it('a question without options is free text only', () => {
    const q = question({ options: undefined, isSecret: true, id: 'token' });
    expect(allowsText(q)).toBe(true);
    expect(answerOf(q, setOther(q, EMPTY_DRAFT, 's3cret'))).toEqual(['s3cret']);
    expect(answerOf(q, setOther(q, EMPTY_DRAFT, '   '))).toEqual([]);
  });
});

describe('input/answer payload', () => {
  it('answers keyed by question id, submit only when every question is answered', () => {
    const request = { questions: [question(), question({ id: 'token', options: [], isSecret: true })] };
    const drafts: Record<string, QuestionDraft> = { folder: { selected: ['Desktop'], other: '', otherOn: false } };
    expect(canSubmit(request, drafts)).toBe(false);
    drafts.token = { selected: [], other: 'abc', otherOn: false };
    expect(canSubmit(request, drafts)).toBe(true);
    expect(answersOf(request, drafts)).toEqual({ folder: ['Desktop'], token: ['abc'] });
  });
});

describe('the "Other…" row', () => {
  it('is offered for a question with options and isOther only', () => {
    expect(hasOtherRow(question({ isOther: true }))).toBe(true);
    expect(hasOtherRow(question())).toBe(false);
    expect(hasOtherRow(question({ isOther: true, options: [] }))).toBe(false);
    expect(pickOther(question(), EMPTY_DRAFT)).toBe(EMPTY_DRAFT);
  });

  it('single pick: choosing Other drops the picked option and keeps typed text; picking an option closes it', () => {
    const q = question({ isOther: true });
    let d = toggleOption(q, EMPTY_DRAFT, 'Desktop');
    d = pickOther(q, d);
    expect(d).toEqual({ selected: [], other: '', otherOn: true });
    expect(answerOf(q, d)).toEqual([]); // chosen but empty: nothing to send yet
    d = setOther(q, d, 'Downloads');
    expect(pickOther(q, d)).toEqual({ selected: [], other: 'Downloads', otherOn: true }); // a second tap keeps it
    d = toggleOption(q, d, 'Home');
    expect(d).toEqual({ selected: ['Home'], other: '', otherOn: false });
  });

  it('multi-select: Other toggles next to the picks, and closing it drops its text', () => {
    const q = question({ isOther: true, multiSelect: true });
    let d = toggleOption(q, EMPTY_DRAFT, 'Home');
    d = pickOther(q, d);
    d = setOther(q, d, 'Downloads');
    expect(answerOf(q, d)).toEqual(['Home', 'Downloads']);
    d = pickOther(q, d);
    expect(d).toEqual({ selected: ['Home'], other: '', otherOn: false });
    expect(answerOf(q, d)).toEqual(['Home']);
  });

  it('questionView: options with their state, and whether the Other field shows', () => {
    const q = question({ isOther: true, multiSelect: true, isSecret: false });
    expect(questionView(q, undefined)).toEqual({
      id: 'folder',
      header: 'Folder',
      question: 'Which folder?',
      options: options.map((o) => ({ ...o, selected: false })),
      multi: true,
      text: true,
      isOther: true,
      otherOn: false,
      secret: false,
      other: '',
    });
    const view = questionView(q, pickOther(q, toggleOption(q, EMPTY_DRAFT, 'Desktop')));
    expect(view.options.map((o) => o.selected)).toEqual([false, true, false]);
    expect(view.otherOn).toBe(true);
    // Free text only: no Other row, the field is the answer.
    const free = questionView(question({ options: undefined, isSecret: true }), { selected: [], other: 'x', otherOn: false });
    expect([free.text, free.isOther, free.otherOn, free.secret, free.options]).toEqual([true, false, false, true, []]);
  });
});

describe('card wording', () => {
  it('questionTitle: the question, or how many there are', () => {
    expect(questionTitle([question()])).toBe('Which folder?');
    expect(questionTitle([question(), question({ id: 'b' })])).toBe('2 questions');
    expect(questionTitle([])).toBe('Question');
  });

  it('answerSummary: picks by commas, questions by dots, secrets hidden, unanswered skipped', () => {
    const qs = [question(), question({ id: 'token', isSecret: true }), question({ id: 'skip' })];
    expect(answerSummary(qs, { folder: ['Desktop', 'Home'], token: ['s3cret'], skip: [] })).toBe('Desktop, Home · ••••');
    expect(answerSummary(qs, {})).toBe('');
  });
});
