import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TurnDiffResult } from '../../../generated/methods';
import type { Item, SessionView } from '../../../replica/types';
import { RequestError } from '../../../stream/client';
import { ItemDetailModel, type DetailReplica } from './detail-model';

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
function setup(itemId: string, clipboard?: { writeText(text: string): Promise<void> }, diffs?: boolean) {
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
  const model = new ItemDetailModel({
    sessionId: SID,
    itemId,
    replica,
    ...(clipboard !== undefined ? { clipboard } : {}),
    ...(diffs !== undefined ? { diffs } : {}),
  });
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
    await model.changes.load();
    expect(calls).toHaveLength(0);
    expect(model.changes.state).toEqual({ state: 'idle' });
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

describe('ItemDetailModel: the Changes tab', () => {
  it("fetches the item's turn on open, and reports the Changes view's changes", async () => {
    const { model, calls } = setup('f1');
    const seen = vi.fn();
    model.subscribe(seen);
    model.start();
    expect(model.changes.turnId).toBe('t1');
    expect(model.changes.state).toEqual({ state: 'loading' });
    // f1 has no diff text of its own, so the sheet shows the turn's Changes: git's a.txt, then b.txt that
    // only the agent's edits name.
    expect(model.ownChanges).toEqual([]);
    calls[0]!.resolve({ files: [{ path: 'a.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+a\n' }] });
    await settle();
    expect(model.changes.summary).toBe('2 files changed');
    const state = model.changes.state as Extract<typeof model.changes.state, { state: 'ready' }>;
    expect(state.files.map((f) => [f.path, f.fromAgent ?? false])).toEqual([
      ['a.txt', false],
      ['b.txt', true],
    ]);
    expect(seen).toHaveBeenCalled();
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
    // git listed nothing; the turn's file change item still names its two files.
    expect(model.changes.state).toMatchObject({ state: 'ready', omittedFiles: 0, truncated: false });
    expect(model.changes.summary).toBe('2 files changed');
  });

  it('ignores answers after dispose and stops listening', async () => {
    const { model, calls, listeners } = setup('a1');
    model.start();
    model.dispose();
    expect(listeners.size).toBe(0);
    calls[0]!.resolve({ files: [] });
    await settle();
    expect(model.changes.state).toEqual({ state: 'loading' });
  });
});

describe("ItemDetailModel: a file change item's own diff", () => {
  const EDIT = { path: '/tmp/notes.md', kind: 'modify', diff: '@@ -3,2 +3,2 @@\n keep\n-old\n+new\n' };
  const WRITE = { path: '/w/new.ts', kind: 'add', diff: '@@ -0,0 +1,2 @@\n+a\n+b\n' };

  it('shows every file of the item from its own diff, one section each, and never asks turn/diff', () => {
    const { model, view, calls } = setup('f1');
    view.items.f1 = item('f1', 'fileChange', { changes: [EDIT, WRITE] });
    model.start();
    expect(model.tab).toBe('changes');
    expect(model.tabs).toEqual(['changes']);
    expect(calls).toHaveLength(0);
    expect(model.ownChanges.map((f) => [f.path, f.label, f.added, f.removed, f.fromAgent])).toEqual([
      ['/tmp/notes.md', 'Modified', 1, 1, true],
      ['/w/new.ts', 'Added', 2, 0, true],
    ]);
    expect(model.ownChanges[0]!.lines.map((l) => [l.kind, l.oldLine ?? null, l.newLine ?? null])).toEqual([
      ['hunk', null, null],
      ['context', 3, 3],
      ['remove', 4, null],
      ['add', null, 4],
    ]);
  });

  it('keeps its Changes even when the agent provides no turn diffs', () => {
    const { model, view, calls } = setup('f1', undefined, false);
    view.items.f1 = item('f1', 'fileChange', { changes: [EDIT] });
    const fresh = new ItemDetailModel({ sessionId: SID, itemId: 'f1', replica: (model as any).replica, diffs: false });
    fresh.start();
    expect(fresh.tab).toBe('changes');
    expect(fresh.tabs).toEqual(['changes']);
    expect(calls).toHaveLength(0);
    // Other items have no ownChanges.
    expect(setup('c1').model.ownChanges).toEqual([]);
  });
});

describe('ItemDetailModel: agents without diffs (spec 4 capabilities)', () => {
  it('hides the Changes tab and never asks turn/diff when the agent provides no diffs', () => {
    const { model, calls } = setup('c1', undefined, false);
    expect(model.tabs).toEqual(['output']);
    expect(model.tab).toBe('output');
    model.start();
    model.selectTab('changes');
    expect(model.tab).toBe('output');
    expect(calls).toHaveLength(0);
    const other = setup('a1', undefined, false);
    expect(other.model.tabs).toEqual([]);
    other.model.start();
    expect(other.calls).toHaveLength(0);
  });

  it('keeps the Changes tab when the agent provides diffs or the host sends no capabilities', () => {
    expect(setup('c1', undefined, true).model.tabs).toEqual(['output', 'changes']);
    expect(setup('c1').model.tabs).toEqual(['output', 'changes']);
    expect(setup('a1').model.tab).toBe('changes');
  });
});
