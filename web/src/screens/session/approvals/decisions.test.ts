import { describe, expect, it } from 'vitest';

import { approval } from '../../../../test/replica-fixtures';
import { approvalCard, DECISION_LABELS, decisionButtons, diffPreview, resolvedNotice } from './decisions';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('decision mapping', () => {
  it('offers one button per listed decision, labeled, in the order accept, accept for session, decline, cancel', () => {
    const buttons = decisionButtons(['cancel', 'decline', 'acceptForSession', 'accept']);
    expect(buttons.map((b) => b.decision)).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    expect(buttons.map((b) => b.label)).toEqual(['Accept', 'Accept for session', 'Decline', 'Cancel']);
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

describe('resolved notices', () => {
  it('names the device that answered, the agent, or nobody when this device answered', () => {
    expect(resolvedNotice('dev_mac', 'dev_phone', 'Mabue MacBook')).toBe('Answered on Mabue MacBook');
    expect(resolvedNotice('dev_mac', 'dev_phone', undefined)).toBe('Answered on another device');
    expect(resolvedNotice('dev_mac', 'dev_phone', '  ')).toBe('Answered on another device');
    expect(resolvedNotice('agent', 'dev_phone', undefined)).toBe('Withdrawn by the agent');
    expect(resolvedNotice('dev_phone', 'dev_phone', 'iPhone')).toBeUndefined();
    expect(resolvedNotice(undefined, 'dev_phone', undefined)).toBe('Answered on another device');
  });
});
