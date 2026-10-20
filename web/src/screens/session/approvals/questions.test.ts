import { describe, expect, it } from 'vitest';

import { allowsText, answerOf, answersOf, canSubmit, EMPTY_DRAFT, setOther, toggleOption, type Question } from './questions';

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
    expect(d).toEqual({ selected: [], other: '  /tmp/x  ' });
    expect(answerOf(q, d)).toEqual(['/tmp/x']);
    d = toggleOption(q, d, 'Home');
    expect(d).toEqual({ selected: ['Home'], other: '' });
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
    const drafts: Record<string, { selected: string[]; other: string }> = { folder: { selected: ['Desktop'], other: '' } };
    expect(canSubmit(request, drafts)).toBe(false);
    drafts.token = { selected: [], other: 'abc' };
    expect(canSubmit(request, drafts)).toBe(true);
    expect(answersOf(request, drafts)).toEqual({ folder: ['Desktop'], token: ['abc'] });
  });
});
