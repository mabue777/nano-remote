import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TurnDiffResult } from '../../../generated/methods';
import type { Item, SessionView } from '../../../replica/types';
import { RequestError } from '../../../stream/client';
import { ItemDetailModel, NOT_SUPPORTED_TEXT, type DetailReplica } from './detail-model';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SID = 'ses_1';
const ESC = '\u001b';

function item(itemId: string, type: string, over: Record<string, unknown> = {}): Item {
  return { itemId, type, turnId: 't1', status: 'completed', ...over } as unknown as Item;
}

const ITEMS: Item[] = [
  item('c1', 'command', { status: 'inProgress', command: '/bin/zsh -lc "npm test"', cwd: '/w', output: '' }),
  item('a1', 'agentMessage', { text: 'Done.\nMore.' }),
  item('u1', 'userMessage', { content: [{ type: 'text', text: 'Fix it' }, { type: 'mention', name: 'app.ts', path: '/w/app.ts' }, { type: 'image', url: 'x' }] }),
  item('r1', 'reasoning', { summary: 'Looking around' }),
  item('f1', 'fileChange', { changes: [{ path: 'a.txt', kind: 'add', diff: '' }, { path: 'b.txt', kind: 'modify', diff: '' }] }),
  item('k1', 'toolCall', { tool: 'search', server: 'web', arguments: {} }),
  item('k2', 'toolCall', { tool: 'view', arguments: {} }),
  item('p1', 'plan', { text: 'Step one' }),
  item('o1', 'other', { raw: {} }),
  item('n1', 'somethingNew'),
];

/** A Replica double: one session, a turn whose status the test sets, and turn/diff answered by hand. */
function setup(itemId: string, clipboard?: { writeText(text: string): Promise<void> }) {
  const view = {
    sessionId: SID,
    turns: [{ turnId: 't1', status: 'inProgress', items: ITEMS.map((i) => i.itemId) }],
    items: Object.fromEntries(ITEMS.map((i) => [i.itemId, structuredClone(i)])),
  } as unknown as SessionView;
  const listeners = new Set<() => void>();
  const calls: { turnId: string; resolve: (r: TurnDiffResult) => void; reject: (e: unknown) => void }[] = [];
  const replica: DetailReplica = {
    session: (sessionId) => (sessionId === SID ? view : undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    turnDiff: (_sessionId, turnId) => new Promise((resolve, reject) => calls.push({ turnId, resolve, reject })),
  };
  const changed = () => listeners.forEach((fn) => fn());
  const model = new ItemDetailModel({ sessionId: SID, itemId, replica, ...(clipboard !== undefined ? { clipboard } : {}) });
  return { model, view, calls, changed, listeners };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('ItemDetailModel: titles and tabs', () => {
  it('names every item kind and opens command items on Output, the rest on Changes', () => {
    const expectations: [string, string, string, string][] = [
      ['c1', 'Command', 'npm test', 'output'],
      ['a1', 'Agent message', 'Done. …', 'changes'],
      ['u1', 'Your message', 'Fix it @app.ts', 'changes'],
      ['r1', 'Thinking', 'Looking around', 'changes'],
      ['f1', 'File change', 'a.txt, b.txt', 'changes'],
      ['k1', 'Tool call', 'web/search', 'changes'],
      ['k2', 'Tool call', 'view', 'changes'],
      ['p1', 'Plan', 'Step one', 'changes'],
      ['o1', 'Other activity', '', 'changes'],
      ['n1', 'Other activity', '', 'changes'],
      ['missing', 'Item', '', 'changes'],
    ];
    for (const [itemId, title, subtitle, tab] of expectations) {
      const { model } = setup(itemId);
      expect([model.title, model.subtitle, model.tab], itemId).toEqual([title, subtitle, tab]);
    }
    expect(setup('c1').model.tabs).toEqual(['output', 'changes']);
    expect(setup('a1').model.tabs).toEqual(['changes']);
    expect(setup('a1').model.command).toBeUndefined();
    expect(setup('a1').model.output).toBe('');
  });

  it('a missing item has no turn to diff', async () => {
    const { model, calls } = setup('missing');
    model.start();
    await model.loadDiff();
    expect(calls).toHaveLength(0);
    expect(model.diff).toEqual({ state: 'idle' });
  });

  it('selectTab ignores the current tab and tabs the item does not have', () => {
    const { model, calls } = setup('a1');
    model.selectTab('output');
    model.selectTab('changes');
    expect(model.tab).toBe('changes');
    expect(calls).toHaveLength(0);
  });
});

describe('ItemDetailModel: output view', () => {
  it('shows the output as plain text, follows it while it grows, and stops being running at the end', () => {
    const { model, view, changed, calls } = setup('c1');
    const changes = vi.fn();
    model.subscribe(changes);
    model.start();
    expect(calls).toHaveLength(0); // Output first: no diff fetched yet
    expect(model.command).toEqual({ text: 'npm test', cwd: '/w' });
    expect(model.running).toBe(true);
    expect(model.output).toBe('');

    const command = view.items.c1 as any;
    command.output += `${ESC}[32m✓${ESC}[0m one\r\n`;
    changed();
    command.output += `progress 10%\rprogress 100%\n`;
    changed();
    expect(model.output).toBe('✓ one\nprogress 100%\n');
    expect(changes).toHaveBeenCalledTimes(2);

    model.setFollowing(false);
    model.setFollowing(false);
    expect(model.following).toBe(false);
    model.setFollowing(true);
    expect(changes).toHaveBeenCalledTimes(4);

    command.status = 'completed';
    command.exitCode = 0;
    changed();
    expect(model.running).toBe(false);
    expect(model.subtitle).toBe('npm test · exit 0');
  });

  it('copies the plain output and says so for a while', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => undefined);
    const { model, view } = setup('c1', { writeText });
    (view.items.c1 as any).output = `${ESC}[1mbold${ESC}[0m\n`;
    await model.copy();
    expect(writeText).toHaveBeenCalledWith('bold\n');
    expect(model.copied).toBe(true);
    await model.copy(); // a second copy restarts the timer
    vi.advanceTimersByTime(2000);
    expect(model.copied).toBe(false);
    expect(model.copyError).toBeUndefined();
    model.dispose();
  });

  it('reports a copy that fails, or no clipboard at all', async () => {
    const { model } = setup('c1', { writeText: () => Promise.reject(new Error('denied')) });
    await model.copy();
    expect(model.copied).toBe(false);
    expect(model.copyError).toBe('Could not copy: denied');
    const bare = setup('c1').model;
    await bare.copy();
    expect(bare.copyError).toBe('Could not copy: The clipboard is not available here.');
  });
});

describe('ItemDetailModel: diff view', () => {
  const MODIFY = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n';

  it('fetches turn/diff on open and parses one section per file; one file opens expanded', async () => {
    const { model, calls } = setup('f1');
    model.start();
    expect(model.diff).toEqual({ state: 'loading' });
    expect(calls[0]!.turnId).toBe('t1');
    calls[0]!.resolve({ files: [{ path: 'src/app.ts', kind: 'modify', diff: MODIFY }] });
    await settle();
    const diff = model.diff;
    expect(diff.state).toBe('ready');
    if (diff.state !== 'ready') return;
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ path: 'src/app.ts', kind: 'modified', label: 'Modified', added: 1, removed: 1, binary: false, expanded: true });
    expect(diff.files[0]!.lines.map((l) => l.kind)).toEqual(['hunk', 'remove', 'add']);
    model.toggleFile('src/app.ts');
    expect((model.diff as any).files[0].expanded).toBe(false);
    model.toggleFile('src/app.ts');
    expect((model.diff as any).files[0].expanded).toBe(true);
  });

  it('shows each kind, renames included, collapsed when there are several files', async () => {
    const { model, calls } = setup('a1');
    model.start();
    calls[0]!.resolve({
      files: [
        { path: 'new.txt', kind: 'add', diff: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n' },
        { path: 'gone.txt', kind: 'delete', diff: '--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n' },
        { path: 'to.ts', kind: 'modify', diff: 'rename from from.ts\nrename to to.ts\n' },
        { path: 'img.png', kind: 'modify', diff: 'Binary files a/img.png and b/img.png differ\n' },
      ],
    });
    await settle();
    const files = (model.diff as any).files;
    expect(files.map((f: any) => [f.path, f.kind, f.expanded])).toEqual([
      ['new.txt', 'added', false],
      ['gone.txt', 'deleted', false],
      ['to.ts', 'renamed', false],
      ['img.png', 'modified', false],
    ]);
    expect(files[2].renamedFrom).toBe('from.ts');
    expect(files[3].binary).toBe(true);
  });

  it('says the agent does not provide diffs on not_supported', async () => {
    const { model, calls } = setup('a1');
    model.start();
    calls[0]!.reject(new RequestError('not_supported', 'no diffs'));
    await settle();
    expect(model.diff).toEqual({ state: 'unsupported' });
    expect(NOT_SUPPORTED_TEXT).toBe('This agent does not provide diffs.');
  });

  it('shows other failures as an error', async () => {
    const { model, calls } = setup('a1');
    model.start();
    calls[0]!.reject(new RequestError('timeout', 'The host did not answer.'));
    await settle();
    expect(model.diff).toEqual({ state: 'error', message: 'Could not load the changes: The host did not answer.' });
  });

  it('switching a command item to Changes fetches the diff once', async () => {
    const { model, calls } = setup('c1');
    model.start();
    model.selectTab('changes');
    expect(model.tab).toBe('changes');
    expect(calls).toHaveLength(1);
    calls[0]!.resolve({ files: [] });
    await settle();
    model.selectTab('output');
    model.selectTab('changes');
    expect(calls).toHaveLength(1);
    expect(model.diff).toEqual({ state: 'ready', files: [] });
  });

  it('fetches again when the turn status changes, keeps the old diff meanwhile, and the newest answer wins', async () => {
    const { model, view, calls, changed } = setup('f1');
    model.start();
    calls[0]!.resolve({ files: [{ path: 'a.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+a\n' }] });
    await settle();
    changed(); // same status: nothing new to fetch
    expect(calls).toHaveLength(1);

    (view.turns[0] as any).status = 'completed';
    changed();
    expect(calls).toHaveLength(2);
    expect(model.diff.state).toBe('ready'); // the old diff stays while the new one loads
    void model.loadDiff(); // a third fetch overtakes the second
    calls[2]!.resolve({ files: [{ path: 'b.txt', kind: 'add', diff: '' }] });
    await settle();
    calls[1]!.resolve({ files: [{ path: 'stale.txt', kind: 'add', diff: '' }] });
    await settle();
    expect((model.diff as any).files.map((f: any) => f.path)).toEqual(['b.txt']);
    // The single file of the first answer stays open; the new file is not forced open.
    expect((model.diff as any).files[0].expanded).toBe(false);
  });

  it('ignores answers after dispose and stops listening', async () => {
    const { model, calls, listeners } = setup('a1');
    model.start();
    model.dispose();
    expect(listeners.size).toBe(0);
    calls[0]!.resolve({ files: [] });
    await settle();
    expect(model.diff).toEqual({ state: 'loading' });
  });
});
