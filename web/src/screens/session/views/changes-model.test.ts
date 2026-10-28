import { describe, expect, it } from 'vitest';

import type { TurnDiffResult } from '../../../generated/methods';
import type { SessionView } from '../../../replica/types';
import { RequestError } from '../../../stream/client';
import {
  ChangesModel,
  FROM_AGENT_TEXT,
  NOT_A_REPOSITORY_TEXT,
  NOT_SUPPORTED_TEXT,
  agentFile,
  agentFiles,
  changedFile,
  filesChangedText,
  folderPath,
  mergeChanges,
  mergedState,
  type ChangesReplica,
} from './changes-model';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SID = 'ses_1';

/** A Replica double: one session with turn t1 whose status the test sets, turn/diff answered by hand. */
function setup(turnId: string | null = 't1') {
  const view = { sessionId: SID, turns: [{ turnId: 't1', status: 'inProgress', items: [] }], items: {} } as unknown as SessionView;
  const listeners = new Set<() => void>();
  const calls: { turnId: string; resolve: (r: TurnDiffResult) => void; reject: (e: unknown) => void }[] = [];
  const replica: ChangesReplica = {
    session: (sessionId) => (sessionId === SID ? view : undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    turnDiff: (_sessionId, id) => new Promise((resolve, reject) => calls.push({ turnId: id, resolve, reject })),
  };
  const changed = () => listeners.forEach((fn) => fn());
  return { model: new ChangesModel({ sessionId: SID, turnId: turnId ?? undefined, replica }), view, calls, changed, listeners };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The host's text for a modified file (git diff), with git's header lines.
const MODIFY =
  'diff --git a/src/app.ts b/src/app.ts\nindex 4a1d6b0..d1d6ce1 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n import x from "x";\n-const a = 1;\n+const a = 2;\n export { a };\n';

describe('changedFile', () => {
  it("keeps the host's kind, rename with its old path, and drops git's header lines", () => {
    const file = changedFile({ path: 'src/app.ts', kind: 'modify', diff: MODIFY });
    expect(file).toMatchObject({ path: 'src/app.ts', kind: 'modified', label: 'Modified', added: 1, removed: 1, binary: false, truncated: false });
    expect(file.lines.map((l) => [l.kind, l.oldLine ?? null, l.newLine ?? null, l.text])).toEqual([
      ['hunk', null, null, '@@ -1,3 +1,3 @@'],
      ['context', 1, 1, 'import x from "x";'],
      ['remove', 2, null, 'const a = 1;'],
      ['add', null, 2, 'const a = 2;'],
      ['context', 3, 3, 'export { a };'],
    ]);
    const renamed = changedFile({
      path: 'docs/guide.md',
      kind: 'rename',
      oldPath: 'guide.md',
      diff: 'diff --git a/guide.md b/docs/guide.md\nsimilarity index 100%\nrename from guide.md\nrename to docs/guide.md\n',
    });
    expect(renamed).toMatchObject({ kind: 'renamed', label: 'Renamed', renamedFrom: 'guide.md' });
    expect(renamed.lines.map((l) => l.text)).toEqual(['similarity index 100%', 'rename from guide.md', 'rename to docs/guide.md']);
    expect(changedFile({ path: 'logo.png', kind: 'modify', binary: true, diff: '' })).toMatchObject({ kind: 'modified', binary: true, lines: [] });
    expect(changedFile({ path: 'big.csv', kind: 'add', truncated: true, diff: '' })).toMatchObject({ kind: 'added', truncated: true });
    // A host that sends only add/modify/delete: the rename is read from the patch headers.
    expect(changedFile({ path: 'to.ts', kind: 'modify', diff: 'rename from from.ts\nrename to to.ts\n' })).toMatchObject({ kind: 'renamed', renamedFrom: 'from.ts' });
    expect(changedFile({ path: 'gone.txt', kind: 'delete', diff: '' })).toMatchObject({ kind: 'deleted', label: 'Deleted' });
    expect(filesChangedText(1)).toBe('1 file changed');
    expect(filesChangedText(3)).toBe('3 files changed');
  });
});

describe('ChangesModel', () => {
  it('loads the list, opens one file and goes back; one changed file opens right away', async () => {
    const { model, calls } = setup();
    expect(model.state).toEqual({ state: 'idle' });
    model.start();
    model.start(); // loading already
    expect(calls).toHaveLength(1);
    expect(model.state).toEqual({ state: 'loading' });
    calls[0]!.resolve({
      files: [
        { path: 'src/app.ts', kind: 'modify', diff: MODIFY },
        { path: 'new.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+hi\n' },
      ],
      truncated: true,
      omittedFiles: 2,
      note: 'The snapshot at the start of this turn was not ready in time, so these are the changes since the last commit.',
    });
    await settle();
    const state = model.state as Extract<typeof model.state, { state: 'ready' }>;
    expect(state.files.map((f) => f.path)).toEqual(['src/app.ts', 'new.txt']);
    expect([state.truncated, state.omittedFiles, state.note]).toEqual([true, 2, expect.stringContaining('not ready in time')]);
    expect(model.summary).toBe('4 files changed');
    expect(model.file).toBeUndefined();
    model.open('new.txt');
    model.open('new.txt');
    expect(model.file?.path).toBe('new.txt');
    model.back();
    model.back();
    expect(model.selected).toBeUndefined();
    model.open('gone.txt');
    expect(model.file).toBeUndefined();

    const single = setup();
    single.model.start();
    single.calls[0]!.resolve({ files: [{ path: 'a.txt', kind: 'add', diff: '@@ -0,0 +1 @@\n+a\n' }], note: '' });
    await settle();
    expect(single.model.file?.path).toBe('a.txt');
    expect(single.model.state).not.toHaveProperty('note');
  });

  it('names not_supported, not_a_repository and other failures', async () => {
    const cases: [unknown, unknown][] = [
      [new RequestError('not_supported', 'no diffs'), { state: 'unsupported' }],
      [new RequestError('not_a_repository', 'Changes need a git repository in the session folder.'), { state: 'notRepository' }],
      [new RequestError('timeout', 'The host did not answer.'), { state: 'error', message: 'Could not load the changes: The host did not answer.' }],
    ];
    for (const [error, state] of cases) {
      const { model, calls } = setup();
      model.start();
      calls[0]!.reject(error);
      await settle();
      expect(model.state).toEqual(state);
      expect(model.summary).toBe('');
    }
    expect(NOT_SUPPORTED_TEXT).toBe('This agent does not provide diffs.');
    expect(NOT_A_REPOSITORY_TEXT).toBe("This folder is not a git repository, so only the agent's own edits can be shown.");
  });

  it('fetches again when the turn status changes, keeps the old diff meanwhile, and the newest answer wins', async () => {
    const { model, view, calls, changed } = setup();
    model.start();
    calls[0]!.resolve({ files: [{ path: 'a.txt', kind: 'add', diff: '' }, { path: 'c.txt', kind: 'add', diff: '' }] });
    await settle();
    changed(); // same status: nothing new to fetch
    expect(calls).toHaveLength(1);
    (view.turns[0] as any).status = 'completed';
    changed();
    expect(calls).toHaveLength(2);
    expect(model.state.state).toBe('ready'); // the old diff stays while the new one loads
    void model.load(); // a third fetch overtakes the second
    calls[2]!.resolve({ files: [{ path: 'b.txt', kind: 'add', diff: '' }] });
    await settle();
    calls[1]!.resolve({ files: [{ path: 'stale.txt', kind: 'add', diff: '' }] });
    await settle();
    expect((model.state as any).files.map((f: any) => f.path)).toEqual(['b.txt']);
    expect(model.selected).toBeUndefined(); // not forced open: the list was shown before
  });

  it('without a turn there is nothing to fetch; answers after dispose are ignored', async () => {
    const none = setup(null);
    await none.model.load();
    expect(none.calls).toHaveLength(0);
    const { model, calls, listeners } = setup();
    model.start();
    model.dispose();
    expect(listeners.size).toBe(0);
    calls[0]!.resolve({ files: [] });
    await settle();
    expect(model.state).toEqual({ state: 'loading' });
  });
});

describe("the merge rule: git's files, then the agent's edits git did not list", () => {
  const edit = (path: string, diff = '@@ -1 +1 @@\n-a\n+b\n', kind: 'add' | 'modify' | 'delete' = 'modify') => ({ path, kind, diff });
  /** A session in /w whose turn t1 holds the given fileChange items. */
  function viewWith(...changes: ReturnType<typeof edit>[][]): SessionView {
    const items = Object.fromEntries(changes.map((c, i) => [`f${i}`, { itemId: `f${i}`, type: 'fileChange', turnId: 't1', status: 'completed', changes: c }]));
    return { sessionId: SID, session: { cwd: '/w' }, turns: [{ turnId: 't1', status: 'completed', items: [...Object.keys(items), 'gone'] }], items } as unknown as SessionView;
  }

  it('names files inside the session folder as git does, and leaves the others as they are', () => {
    expect(folderPath('/w/src/a.ts', '/w')).toBe('src/a.ts');
    expect(folderPath('/w/src/a.ts', '/w/')).toBe('src/a.ts');
    expect(folderPath('/wx/a.ts', '/w')).toBe('/wx/a.ts');
    expect(folderPath('/tmp/a.md', '/w')).toBe('/tmp/a.md');
    expect(folderPath('rel/a.ts', '/w')).toBe('rel/a.ts');
    expect(folderPath('/w/a.ts', undefined)).toBe('/w/a.ts');
  });

  it("collects the turn's edits by file, several edits of one file in order", () => {
    const view = viewWith([edit('/w/a.ts'), edit('/tmp/x.md', '+new\n', 'add')], [edit('/w/a.ts', '@@ -9 +9 @@\n-c\n+d\n')], [edit('')]);
    const files = agentFiles(view, 't1');
    expect(files.map((f) => [f.path, f.kind, f.added, f.removed, f.fromAgent])).toEqual([
      ['a.ts', 'modified', 2, 2, true],
      ['/tmp/x.md', 'added', 1, 0, true],
    ]);
    expect(files[0]!.lines.filter((l) => l.kind === 'hunk').map((l) => l.text)).toEqual(['@@ -1 +1 @@', '@@ -9 +9 @@']);
    expect(agentFiles(view, 'nope')).toEqual([]);
    expect(agentFiles(undefined, 't1')).toEqual([]);
    expect(agentFile('gone.txt', [edit('gone.txt', '-bye\n', 'delete')])).toMatchObject({ kind: 'deleted', removed: 1 });
    expect(agentFile('n.md', [edit('n.md', '-a\n+b\n')])).toMatchObject({ unnumbered: true });
  });

  it("keeps git's diff for files git listed, and adds the rest from the agent's edits", () => {
    const git = [changedFile({ path: 'a.ts', kind: 'modify', diff: MODIFY })];
    const agent = agentFiles(viewWith([edit('/w/a.ts'), edit('/tmp/x.md')]), 't1');
    const merged = mergeChanges(git, agent);
    expect(merged.map((f) => [f.path, f.fromAgent ?? false])).toEqual([
      ['a.ts', false],
      ['/tmp/x.md', true],
    ]);
    expect(merged[0]).toBe(git[0]);
    expect(FROM_AGENT_TEXT).toBe("From the agent's edits, not git");
    // Not a repository: only the agent's edits, with the note saying why; nothing at all stays notRepository.
    expect(mergedState('notRepository', agent)).toMatchObject({ state: 'ready', note: NOT_A_REPOSITORY_TEXT, files: agent });
    expect(mergedState('notRepository', [])).toBeUndefined();
    expect(mergedState({ files: git, omittedFiles: 2, truncated: true }, [])).toEqual({ state: 'ready', files: git, omittedFiles: 2, truncated: true });
  });

  it("ChangesModel shows a folder outside git from the agent's edits, and follows new edits", async () => {
    const view = viewWith([edit('/w/a.ts')]);
    const listeners = new Set<() => void>();
    let reject: (e: unknown) => void = () => undefined;
    const replica: ChangesReplica = {
      session: () => view,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      turnDiff: () => new Promise((_resolve, no) => (reject = no)),
    };
    const model = new ChangesModel({ sessionId: SID, turnId: 't1', replica });
    model.start();
    reject(new RequestError('not_a_repository', 'no git'));
    await settle();
    expect(model.state).toMatchObject({ state: 'ready', note: NOT_A_REPOSITORY_TEXT });
    expect(model.summary).toBe('1 file changed');
    expect(model.file?.path).toBe('a.ts'); // one file opens right away
    // Another edit arrives in the same turn (same status): merged in without asking git again.
    view.items.f9 = { itemId: 'f9', type: 'fileChange', turnId: 't1', status: 'completed', changes: [edit('/tmp/y.md')] } as never;
    view.turns[0]!.items.push('f9');
    listeners.forEach((fn) => fn());
    expect(model.summary).toBe('2 files changed');
    model.dispose();
  });
});
