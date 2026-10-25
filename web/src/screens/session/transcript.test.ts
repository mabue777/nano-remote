import { describe, expect, it } from 'vitest';

import type { ItemRow } from './session-model';
import { layoutTurn, previousMessages, rowLine, workedFor } from './transcript';

const command = (over: Partial<Extract<ItemRow, { kind: 'command' }>> = {}): Extract<ItemRow, { kind: 'command' }> => ({
  kind: 'command',
  itemId: 'c',
  summary: 'npm test · exit 0',
  command: 'npm test',
  meta: 'exit 0',
  state: 'Done',
  tone: 'ok',
  output: '',
  expanded: false,
  ...over,
});

describe('transcript wording', () => {
  it('"Worked for" in seconds, minutes and hours; a stopped turn has its own lead', () => {
    expect(workedFor(12_400)).toBe('Worked for 12s');
    expect(workedFor(192_000)).toBe('Worked for 3m 12s');
    expect(workedFor(3 * 3_600_000 + 42 * 60_000)).toBe('Worked for 3h 42m');
    expect(workedFor(-5)).toBe('Worked for 0s');
    expect(workedFor(4_000, 'Stopped after')).toBe('Stopped after 4s');
  });

  it('"N previous messages"', () => {
    expect(previousMessages(1)).toBe('1 previous message');
    expect(previousMessages(3)).toBe('3 previous messages');
  });
});

describe('rowLine', () => {
  it('commands: Running, Ran, a failed or declined tag', () => {
    expect(rowLine(command({ state: 'Running', tone: 'busy' }))).toEqual({ icon: 'spinner', verb: 'Running', target: 'npm test', busy: true });
    expect(rowLine(command())).toEqual({ icon: 'terminal', verb: 'Ran', target: 'npm test', busy: false });
    expect(rowLine(command({ state: 'Failed', tone: 'error' }))).toMatchObject({ verb: 'Ran', tag: { text: 'Failed', tone: 'error' } });
    expect(rowLine(command({ state: 'Declined', tone: 'muted' }))).toMatchObject({ verb: 'Declined', tag: { text: 'Declined', tone: 'muted' } });
  });

  it('file changes: Created, Deleted, Edited, Editing; one path or a count', () => {
    const files = (kinds: string[], over: Partial<Extract<ItemRow, { kind: 'fileChange' }>> = {}): Extract<ItemRow, { kind: 'fileChange' }> => ({
      kind: 'fileChange',
      itemId: 'f',
      files: kinds.map((kind, i) => ({ path: `src/${i}.ts`, kind })),
      state: 'Done',
      tone: 'ok',
      expanded: false,
      ...over,
    });
    expect(rowLine(files(['update']))).toEqual({ icon: 'file-diff', verb: 'Edited', target: 'src/0.ts', busy: false });
    expect(rowLine(files(['add', 'add']))).toMatchObject({ verb: 'Created', target: '2 files' });
    expect(rowLine(files(['delete']))).toMatchObject({ verb: 'Deleted' });
    expect(rowLine(files(['add', 'delete']))).toMatchObject({ verb: 'Edited' });
    expect(rowLine(files([]))).toMatchObject({ verb: 'Edited', target: '0 files' });
    expect(rowLine(files(['update'], { state: 'Running', tone: 'busy' }))).toMatchObject({ icon: 'spinner', verb: 'Editing', busy: true });
    expect(rowLine(files(['update'], { state: 'Failed', tone: 'error' }))).toMatchObject({ tag: { text: 'Failed', tone: 'error' } });
  });

  it('tool calls, thinking, plans and other activity', () => {
    const tool: Extract<ItemRow, { kind: 'tool' }> = { kind: 'tool', itemId: 't', summary: 'fs/read', state: 'Done', tone: 'ok', expanded: false };
    expect(rowLine(tool)).toEqual({ icon: 'wrench', verb: 'Called', target: 'fs/read', busy: false });
    expect(rowLine({ ...tool, state: 'Running', tone: 'busy' })).toMatchObject({ icon: 'spinner', verb: 'Calling' });
    expect(rowLine({ ...tool, state: 'Failed', tone: 'error' })).toMatchObject({ tag: { text: 'Failed', tone: 'error' } });
    const reasoning: Extract<ItemRow, { kind: 'reasoning' }> = { kind: 'reasoning', itemId: 'r', summary: ' Read the parser\nthen more', text: '', expanded: false, streaming: true };
    expect(rowLine(reasoning)).toEqual({ icon: 'lightbulb', verb: 'Thinking', target: 'Read the parser', busy: false });
    expect(rowLine({ ...reasoning, streaming: false, summary: '' })).toMatchObject({ verb: 'Thought', target: '' });
    expect(rowLine({ kind: 'plan', itemId: 'p', text: '1. a', expanded: false })).toMatchObject({ icon: 'list', verb: 'Updated the plan' });
    expect(rowLine({ kind: 'other', itemId: 'o', label: 'Other activity' })).toMatchObject({ icon: 'gear', verb: 'Other activity' });
  });
});

describe('layoutTurn', () => {
  const user: ItemRow = { kind: 'user', itemId: 'u', text: 'Go', images: [], files: [] };
  const first: ItemRow = { kind: 'agent', itemId: 'a1', text: 'Looking.', streaming: false };
  const answer: ItemRow = { kind: 'agent', itemId: 'a2', text: 'Done.', streaming: false };
  const steer: ItemRow = { kind: 'user', itemId: 'u2', text: 'Also this', images: [], files: [] };

  it('a running turn shows its items in order', () => {
    expect(layoutTurn([user, first, command(), answer], false)).toEqual({ lead: [user, first, command(), answer], work: [] });
  });

  it('a finished turn keeps the user messages and the last answer, and folds the rest', () => {
    const files: ItemRow = { kind: 'fileChange', itemId: 'f', files: [], state: 'Done', tone: 'ok', expanded: false };
    expect(layoutTurn([user, first, command(), steer, answer, files], true)).toEqual({ lead: [user, steer], work: [first, command(), files], answer });
  });

  it('a finished turn without an answer folds all its work', () => {
    expect(layoutTurn([user, command()], true)).toEqual({ lead: [user], work: [command()] });
  });
});
