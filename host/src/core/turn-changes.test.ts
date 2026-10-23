// turn/diff's bookkeeping (spec 7): snapshots at turn start and end, the fallbacks when one is missing, and
// a whole session through the SessionManager on a real repository.
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Journal } from '../journal/journal.js';
import type { TreeDiff } from './git-changes.js';
import { SessionManager } from './session-manager.js';
import { SessionStore } from './store.js';
import { FakeAgent } from './testing/fake-adapter.js';
import { makeRepo, type TestRepo } from './testing/git-repo.js';
import { END_NOTE, NOT_A_REPOSITORY, START_NOTE, START_SNAPSHOT_WAIT_MS, TurnChanges, type ChangesGit } from './turn-changes.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function repo(files: Record<string, string> = {}): TestRepo {
  const r = makeRepo(files);
  r.commit('initial');
  cleanups.push(() => r.remove());
  return r;
}

/** A git double: trees are names, snapshots return what `next` holds, diffs echo their trees. */
function fakeGit(overrides: Partial<ChangesGit> = {}) {
  const calls: string[] = [];
  const git: ChangesGit = {
    isWorkTree: async () => true,
    snapshotTree: async () => {
      calls.push('snapshot');
      return `tree${calls.filter((c) => c === 'snapshot').length}`;
    },
    headTree: async () => 'HEAD',
    diffTrees: async (_cwd, from, to): Promise<TreeDiff> => {
      calls.push(`diff ${from}..${to}`);
      return { files: [{ path: `${from}..${to}`, kind: 'modify', diff: '' }] };
    },
    ...overrides,
  };
  return { git, calls };
}

describe('TurnChanges', () => {
  it('start and end snapshots give the diff; a finished turn is diffed once and then served from memory', async () => {
    const store = new SessionStore();
    const { git, calls } = fakeGit();
    const changes = new TurnChanges({ store, git });
    await changes.begin('ses', 'trn', '/w').seal();
    expect(store.turnTrees('ses', 'trn')).toEqual({ start: 'tree1' });
    // While the turn runs: the start tree against the folder now, no note.
    expect(await changes.diff('ses', 'trn', '/w', true)).toEqual({ files: [{ path: 'tree1..tree2', kind: 'modify', diff: '' }] });
    changes.end('ses', 'trn', '/w');
    expect(await changes.diff('ses', 'trn', '/w', false)).toEqual({ files: [{ path: 'tree1..tree3', kind: 'modify', diff: '' }] });
    expect(await changes.diff('ses', 'trn', '/w', false)).toEqual({ files: [{ path: 'tree1..tree3', kind: 'modify', diff: '' }] });
    expect(calls).toEqual(['snapshot', 'snapshot', 'diff tree1..tree2', 'snapshot', 'diff tree1..tree3']);
    expect(store.turnTrees('ses', 'trn')).toEqual({ start: 'tree1', end: 'tree3' });
  });

  it('a start snapshot that misses the wait is discarded: the diff compares with HEAD and says so', async () => {
    const store = new SessionStore();
    let finish: (tree: string) => void = () => {};
    const log = vi.fn();
    const { git } = fakeGit({ snapshotTree: () => new Promise<string>((resolve) => (finish = resolve)) });
    const changes = new TurnChanges({ store, git, startWaitMs: 5, log });
    const started = Date.now();
    await changes.begin('ses', 'trn', '/w').seal();
    expect(Date.now() - started).toBeLessThan(1000);
    finish('late-tree');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.turnTrees('ses', 'trn')).toEqual({});
    expect(log).toHaveBeenCalledWith('session ses: the start snapshot of trn was late; discarded');

    store.setTurnTree('ses', 'trn', 'end', 'end-tree');
    expect(await changes.diff('ses', 'trn', '/w', false)).toEqual({ files: [{ path: 'HEAD..end-tree', kind: 'modify', diff: '' }], note: START_NOTE });
    expect(START_SNAPSHOT_WAIT_MS).toBe(250);
  });

  it('a finished turn without an end tree compares with the folder now; with neither tree both notes show', async () => {
    const store = new SessionStore();
    const { git } = fakeGit();
    const changes = new TurnChanges({ store, git });
    store.setTurnTree('ses', 'a', 'start', 'start-tree');
    expect(await changes.diff('ses', 'a', '/w', false)).toEqual({ files: [{ path: 'start-tree..tree1', kind: 'modify', diff: '' }], note: END_NOTE });
    expect(await changes.diff('ses', 'b', '/w', false)).toMatchObject({ note: `${START_NOTE} ${END_NOTE}` });
  });

  it('outside git: no snapshot is taken and turn/diff answers not_a_repository; snapshot failures are logged', async () => {
    const store = new SessionStore();
    const { git, calls } = fakeGit({ isWorkTree: async () => false });
    const changes = new TurnChanges({ store, git });
    await changes.begin('ses', 'trn', '/plain').seal();
    changes.end('ses', 'trn', '/plain');
    await expect(changes.diff('ses', 'trn', '/plain', false)).rejects.toMatchObject({
      code: 'not_a_repository',
      message: NOT_A_REPOSITORY,
      data: { cwd: '/plain' },
    });
    expect(calls).toEqual([]);

    const log = vi.fn();
    const broken = new TurnChanges({ store, git: fakeGit({ snapshotTree: async () => Promise.reject(new Error('disk full')) }).git, log });
    await broken.begin('ses', 'x', '/w').seal();
    broken.end('ses', 'x', '/w');
    await expect(broken.diff('ses', 'x', '/w', false)).rejects.toThrow('disk full');
    expect(log).toHaveBeenCalledWith('session ses: the start snapshot of x failed', expect.any(Error));
    expect(log).toHaveBeenCalledWith('session ses: the end snapshot of x failed', expect.any(Error));

    // A store that cannot record is logged too, and turn/diff still answers.
    const failing = new SessionStore();
    failing.setTurnTree = () => {
      throw new Error('database is locked');
    };
    const quiet = new TurnChanges({ store: failing, git: fakeGit().git, log });
    await quiet.begin('ses', 'y', '/w').seal();
    expect(log).toHaveBeenCalledWith('session ses: recording a snapshot of y failed', expect.any(Error));
    expect(await quiet.diff('ses', 'y', '/w', true)).toMatchObject({ note: START_NOTE });
  });

  it('keeps at most 64 finished diffs in memory', async () => {
    const store = new SessionStore();
    const { git, calls } = fakeGit();
    const changes = new TurnChanges({ store, git });
    for (let i = 0; i <= 64; i += 1) {
      store.setTurnTree('ses', `t${i}`, 'start', `s${i}`);
      store.setTurnTree('ses', `t${i}`, 'end', `e${i}`);
      await changes.diff('ses', `t${i}`, '/w', false);
    }
    await changes.diff('ses', 't64', '/w', false); // still cached
    await changes.diff('ses', 't0', '/w', false); // evicted: computed again
    expect(calls.filter((c) => c === 'diff s0..e0')).toHaveLength(2);
    expect(calls.filter((c) => c === 'diff s64..e64')).toHaveLength(1);
  });
});

describe('turn/diff through the SessionManager on a real repository', () => {
  it('the files a turn wrote, exactly; later writes do not change a finished turn; the user state stays', async () => {
    const r = repo({ 'readme.md': '# Demo\n', 'old.txt': 'old\n' });
    r.write('notes.txt', 'the user is typing this\n'); // untracked before the turn: not the turn's change
    const status = r.git(['status', '--porcelain']);
    const journal = new Journal({ path: ':memory:' });
    const agent = new FakeAgent({ script: [[{ hold: true }, { reply: 'done' }]] });
    // A long wait: on a loaded machine the real snapshot may take longer than 250 ms, and this test needs it.
    const manager = new SessionManager({ journal, agents: [agent], startSnapshotWaitMs: 30_000 });
    cleanups.push(() => journal.close(), () => manager.close());

    const { session, turn } = await manager.start({ agentId: 'fake', cwd: r.root, input: text('write files') });
    const sessionId = session.sessionId;
    const turnId = turn!.turnId;
    expect(manager.store.turnTrees(sessionId, turnId).start).toMatch(/^[0-9a-f]{40}$/);

    r.write('hello.txt', 'hello\n');
    r.write('readme.md', '# Demo\n\nMore.\n');
    unlinkSync(path.join(r.root, 'old.txt'));
    const running = await manager.diff(sessionId, turnId);
    expect(running.files.map((f) => [f.path, f.kind])).toEqual([
      ['hello.txt', 'add'],
      ['old.txt', 'delete'],
      ['readme.md', 'modify'],
    ]);
    expect(running).not.toHaveProperty('note');

    agent.last.release();
    expect(journal.turn(sessionId, turnId)?.status).toBe('completed');
    const finished = await manager.diff(sessionId, turnId);
    r.write('after.txt', 'written after the turn\n');
    expect(await manager.diff(sessionId, turnId)).toEqual(finished);
    expect(finished.files.map((f) => f.path)).toEqual(['hello.txt', 'old.txt', 'readme.md']);
    expect(finished.files[2]!.diff).toMatch(/@@ -1 \+1,3 @@\n # Demo\n\+\n\+More\.\n$/);
    expect(manager.store.turnTrees(sessionId, turnId)).toEqual({ start: expect.any(String), end: expect.any(String) });

    // The user's view of the repository: only the files themselves changed, nothing got staged.
    const now = r.git(['status', '--porcelain']).split('\n').filter(Boolean).sort();
    expect(now).toEqual([...status.split('\n').filter(Boolean), ' D old.txt', ' M readme.md', '?? after.txt', '?? hello.txt'].sort());
    expect(r.git(['stash', 'list'])).toBe('');
  });

  it('a session folder outside git answers not_a_repository', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'nano-plain-'));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
    const journal = new Journal({ path: ':memory:' });
    const manager = new SessionManager({ journal, agents: [new FakeAgent()] });
    cleanups.push(() => journal.close(), () => manager.close());
    const { session, turn } = await manager.start({ agentId: 'fake', cwd: plain, input: text('hi') });
    await expect(manager.diff(session.sessionId, turn!.turnId)).rejects.toMatchObject({ code: 'not_a_repository', data: { cwd: plain } });
    expect(manager.store.turnTrees(session.sessionId, turn!.turnId)).toEqual({});
  });
});
