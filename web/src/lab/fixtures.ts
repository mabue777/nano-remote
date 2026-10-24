// Fake, local data for the lab: a session list, one session's transcript, a changes list, and the scripted
// list activity that "Simulate activity" steps through. Nothing here talks to a host.

export type Tone = 'ok' | 'busy' | 'attention' | 'error' | 'muted';

export interface LabSession {
  id: string;
  title: string;
  status: string;
  tone: Tone;
  pending: number;
  agent: string;
  folder: string;
  updated: string;
  preview: string;
}

export const SESSIONS: readonly LabSession[] = [
  { id: 'fix-tests', title: 'Fix the failing parser test', status: 'Working', tone: 'busy', pending: 0, agent: 'Codex', folder: 'nano-remote', updated: 'now', preview: 'Running npm test…' },
  { id: 'readme', title: 'Sketch the README', status: 'Needs approval', tone: 'attention', pending: 1, agent: 'Claude Code', folder: 'docs', updated: '2 min', preview: 'Wants to run git push origin readme' },
  { id: 'hello', title: 'Create hello.txt and list files', status: 'Finished', tone: 'ok', pending: 0, agent: 'Claude Code', folder: 'scratch', updated: '14 min', preview: 'Created hello.txt. The folder now has 3 files.' },
  { id: 'deps', title: 'Update the dependencies', status: 'Finished', tone: 'ok', pending: 0, agent: 'Codex', folder: 'host', updated: '1 h', preview: 'Bumped vite to 7.1 and vitest to 4.1; all tests pass.' },
  { id: 'icons', title: 'Draw the app icons', status: 'Idle', tone: 'muted', pending: 0, agent: 'Claude Code', folder: 'web', updated: 'yesterday', preview: 'Waiting for a message.' },
];

/** One step of fake list activity: the next list of sessions. */
export type Activity = (sessions: readonly LabSession[]) => LabSession[];

const NEW_SESSION: LabSession = {
  id: 'lint',
  title: 'Fix the lint warnings',
  status: 'Working',
  tone: 'busy',
  pending: 0,
  agent: 'Codex',
  folder: 'web',
  updated: 'now',
  preview: 'Reading eslint output…',
};

function update(sessions: readonly LabSession[], id: string, change: Partial<LabSession>, toTop = false): LabSession[] {
  const row = sessions.find((s) => s.id === id);
  if (row === undefined) return [...sessions];
  const next = { ...row, ...change };
  const rest = sessions.filter((s) => s.id !== id);
  if (toTop) return [next, ...rest];
  return sessions.map((s) => (s.id === id ? next : s));
}

/** The script "Simulate activity" walks through, then starts over: add, status change and reorder, remove, restore. */
export const ACTIVITY: readonly Activity[] = [
  (s) => [NEW_SESSION, ...s.filter((x) => x.id !== NEW_SESSION.id)],
  (s) => update(s, 'hello', { status: 'Working', tone: 'busy', updated: 'now', preview: 'Listing files again…' }, true),
  (s) => update(s, 'fix-tests', { status: 'Needs approval', tone: 'attention', pending: 1, preview: 'Wants to run git push origin lab-fix' }),
  (s) => s.filter((x) => x.id !== 'deps'),
  (s) => update(s, 'hello', { status: 'Finished', tone: 'ok', updated: 'now', preview: 'Created hello.txt. The folder now has 3 files.' }),
  () => [...SESSIONS],
];

export interface ToolRow {
  id: string;
  state: string;
  tone: Tone;
  summary: string;
  output: string;
}

export const USER_MESSAGE = 'The parser test fails since yesterday. Find out why and fix it.';

export const TOOL_ROWS: readonly ToolRow[] = [
  {
    id: 'tool-test',
    state: 'Failed',
    tone: 'error',
    summary: 'npm test -- parser',
    output: [
      '> vitest run parser',
      '',
      ' FAIL  src/parser.test.ts > parses an empty list',
      '   AssertionError: expected [ undefined ] to deeply equal []',
      '    at src/parser.test.ts:14:22',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed | 11 passed (12)',
    ].join('\n'),
  },
  {
    id: 'tool-read',
    state: 'Done',
    tone: 'ok',
    summary: 'sed -n 1,40p src/parser.ts',
    output: ['export function parseList(text: string): string[] {', "  return text.split(',').map((s) => s.trim());", '}'].join('\n'),
  },
  {
    id: 'tool-edit',
    state: 'Changed',
    tone: 'ok',
    summary: 'src/parser.ts',
    output: ['-  return text.split(\',\').map((s) => s.trim());', "+  if (text.trim() === '') return [];", "+  return text.split(',').map((s) => s.trim());"].join('\n'),
  },
];

export const ANSWER = [
  'The test fails because `parseList("")` returns `[""]` instead of an empty list: splitting an empty string ',
  'still gives one empty piece, and nothing filtered it out. That changed yesterday when the guard at the top of ',
  'the function was removed during the tokenizer refactor.\n\n',
  'I put the guard back: an empty or blank input now returns `[]` before the split. I also checked the two other ',
  'callers of `parseList`; both already handle an empty array, so nothing else needs to change.\n\n',
  'All 12 parser tests pass again. One more thing worth a look: `parseMap` has the same pattern and would return ',
  '`{ "": "" }` for an empty input. I did not change it, because no test covers it yet and it is outside what you ',
  'asked for. Say the word and I will add a test and the same guard there.\n\n',
  'Next I would like to push the fix to a branch so CI runs on it.',
].join('');

export const REPLY = [
  'Got it. I will keep the change small: only the guard in `parseList`, no refactor. ',
  'Running the whole suite once more before I push, to make sure nothing else depends on the old behaviour.',
].join('');

export const APPROVAL = { title: 'Run a command?', command: 'git push origin lab-fix', cwd: '~/code/nano-remote', reason: 'Push the fix so CI runs on it.' };

export interface ChangedFile {
  path: string;
  kind: 'Modified' | 'Added';
  added: number;
  removed: number;
}

export const CHANGES: readonly ChangedFile[] = [
  { path: 'src/parser.ts', kind: 'Modified', added: 1, removed: 0 },
  { path: 'src/parser.test.ts', kind: 'Modified', added: 6, removed: 1 },
  { path: 'docs/parser.md', kind: 'Added', added: 12, removed: 0 },
];

/** A diff long enough to scroll inside the sheet. */
export const DIFF_LINES: readonly { tone: 'add' | 'del' | 'ctx'; text: string }[] = Array.from({ length: 48 }, (_, i) => {
  if (i % 9 === 3) return { tone: 'del' as const, text: `-  const item${i} = parts[${i}];` };
  if (i % 9 === 4 || i % 9 === 5) return { tone: 'add' as const, text: `+  const item${i} = parts[${i}]?.trim() ?? '';` };
  return { tone: 'ctx' as const, text: `   // line ${i + 1} of the parser` };
});
