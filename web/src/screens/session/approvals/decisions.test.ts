import { describe, expect, it } from 'vitest';

import { approval } from '../../../../test/replica-fixtures';
import { approvalCard, DECISION_LABELS, decisionButtons, diffPreview, groupButtons } from './decisions';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('decision mapping', () => {
  it('offers one button per listed decision, labeled, in the order accept, accept for session, decline, cancel', () => {
    const buttons = decisionButtons(['cancel', 'decline', 'acceptForSession', 'accept']);
    expect(buttons.map((b) => b.decision)).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    expect(buttons.map((b) => b.label)).toEqual(['Accept', 'Accept for this session', 'Decline', 'Cancel the turn']);
    expect(buttons.map((b) => b.tone)).toEqual(['primary', 'plain', 'plain', 'plain']);
    for (const b of buttons) expect(b.hint).not.toBe('');
  });

  it('renders only what the adapter listed (the captured Codex approval offered accept and cancel)', () => {
    expect(decisionButtons(['accept', 'cancel']).map((b) => b.decision)).toEqual(['accept', 'cancel']);
    expect(decisionButtons(['decline']).map((b) => b.label)).toEqual(['Decline']);
    expect(decisionButtons([])).toEqual([]);
    expect(decisionButtons(undefined)).toEqual([]);
  });

  it('drops unknown and object-valued decisions, and duplicates', () => {
    const odd = ['accept', { acceptWithExecpolicyAmendment: { command: ['ls'] } }, 'approveForever', 'accept', 7, null];
    expect(decisionButtons(odd).map((b) => b.decision)).toEqual(['accept']);
  });

  it('has a label for every decision in the schema', () => {
    expect(Object.keys(DECISION_LABELS).sort()).toEqual(['accept', 'acceptForSession', 'cancel', 'decline']);
  });
});

describe('approval cards', () => {
  it('command: the command without its shell wrapper, the full command, cwd and reason', () => {
    const request = { ...approval('r1'), command: '/bin/zsh -lc "echo hello > hello.txt"', cwd: '/Users/me/Desktop/phone-test', reason: 'May I create hello.txt?' };
    const card = approvalCard(request);
    expect(card).toMatchObject({
      requestId: 'r1',
      kind: 'command',
      title: 'Run this command?',
      reason: 'May I create hello.txt?',
      body: { kind: 'command', command: 'echo hello > hello.txt', fullCommand: '/bin/zsh -lc "echo hello > hello.txt"', cwd: '/Users/me/Desktop/phone-test' },
    });
    expect(card.buttons.map((b) => b.decision)).toEqual(['accept', 'decline']);
  });

  it('fileChange: every changed path with a diff preview, and grantRoot when asked', () => {
    const request: any = {
      ...approval('r2'),
      kind: 'fileChange',
      reason: 'Write two files',
      grantRoot: '/Users/me/project',
      changes: [
        { path: 'hello.txt', kind: 'add', diff: '--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hello\n' },
        { path: 'README.md', kind: 'modify', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n same\n' },
      ],
    };
    delete request.command;
    delete request.cwd;
    const card = approvalCard(request);
    expect(card.title).toBe('Change 2 files?');
    expect(card.body).toEqual({
      kind: 'fileChange',
      grantRoot: '/Users/me/project',
      files: [
        { path: 'hello.txt', kind: 'add', preview: { lines: [{ text: '@@ -0,0 +1 @@', tone: 'hunk' }, { text: '+hello', tone: 'add' }], more: 0 } },
        {
          path: 'README.md',
          kind: 'modify',
          preview: {
            lines: [
              { text: '@@ -1,2 +1,2 @@', tone: 'hunk' },
              { text: '-old', tone: 'del' },
              { text: '+new', tone: 'add' },
              { text: ' same', tone: 'ctx' },
            ],
            more: 0,
          },
        },
      ],
    });
    expect(approvalCard({ ...request, changes: [request.changes[0]], grantRoot: undefined }).title).toBe('Change this file?');
  });

  it('permission: rendered generically with the reason and scope', () => {
    const request: any = { ...approval('r3'), kind: 'permission', permissions: { network: true }, scope: 'session', reason: 'Needs network access' };
    expect(approvalCard(request)).toMatchObject({ title: 'Approval required', reason: 'Needs network access', body: { kind: 'permission', scope: 'session' } });
  });

  it('an approval kind newer than this client renders like permission', () => {
    const request: any = { ...approval('r4'), kind: 'mcpElicitation', reason: 'Something new' };
    expect(approvalCard(request)).toMatchObject({ title: 'Approval required', body: { kind: 'permission' }, reason: 'Something new' });
  });

  it('diffPreview cuts long diffs and counts the rest', () => {
    const diff = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join('\n');
    const preview = diffPreview(diff, 12);
    expect(preview.lines).toHaveLength(12);
    expect(preview.more).toBe(18);
    expect(diffPreview('')).toEqual({ lines: [], more: 0 });
  });
});

describe('More grouping', () => {
  const ids = (buttons: { decision: string }[]) => buttons.map((b) => b.decision);

  it('Accept and Decline in the row; Accept for this session and Cancel the turn behind More', () => {
    const groups = groupButtons(decisionButtons(['accept', 'acceptForSession', 'decline', 'cancel']));
    expect(ids(groups.main)).toEqual(['accept', 'decline']);
    expect(ids(groups.more)).toEqual(['acceptForSession', 'cancel']);
    expect(groups.more.map((b) => b.label)).toEqual(['Accept for this session', 'Cancel the turn']);
  });

  it('only what the adapter offered: pi (accept, decline, cancel), the captured Codex approval (accept, cancel)', () => {
    let groups = groupButtons(decisionButtons(['accept', 'decline', 'cancel']));
    expect([ids(groups.main), ids(groups.more)]).toEqual([['accept', 'decline'], ['cancel']]);
    groups = groupButtons(decisionButtons(['accept', 'cancel']));
    expect([ids(groups.main), ids(groups.more)]).toEqual([['accept'], ['cancel']]);
    groups = groupButtons(decisionButtons(['accept', 'decline']));
    expect([ids(groups.main), ids(groups.more)]).toEqual([['accept', 'decline'], []]);
  });

  it('never hides every choice: without Accept and Decline the rest stays in the row', () => {
    const groups = groupButtons(decisionButtons(['acceptForSession', 'cancel']));
    expect([ids(groups.main), ids(groups.more)]).toEqual([['acceptForSession', 'cancel'], []]);
    expect(groupButtons([])).toEqual({ main: [], more: [] });
  });
});
