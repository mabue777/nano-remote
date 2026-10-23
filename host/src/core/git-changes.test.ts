// The git plumbing of turn/diff (spec 7) on a real temporary repository: what a snapshot records, what the
// diff between two snapshots lists, the caps, and that the user's index and stash are never touched.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMITS,
  diffTrees,
  headTree,
  isWorkTree,
  MAX_DIFF_FILES,
  MAX_FILE_DIFF_BYTES,
  MAX_TOTAL_DIFF_BYTES,
  parseNameStatus,
  snapshotTree,
} from './git-changes.js';
import { makeRepo, type TestRepo } from './testing/git-repo.js';

const repos: TestRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove();
});

function repo(files: Record<string, string | Buffer> = {}): TestRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}

/** Everything a snapshot must leave alone: status, stash, the index file itself, refs. */
function userState(r: TestRepo): { status: string; stash: string; cached: string; index: string; refs: string } {
  return {
    status: r.git(['status', '--porcelain=v1', '--untracked-files=all']),
    stash: r.git(['stash', 'list']),
    cached: r.git(['diff', '--cached']),
    index: createHash('sha256').update(readFileSync(path.join(r.root, '.git', 'index'))).digest('hex'),
    refs: r.git(['for-each-ref']),
  };
}

describe('snapshots and the diff between them', () => {
  it('lists added, modified, deleted, renamed and untracked files; leaves ignored files out; binary files have no text', async () => {
    const r = repo({
      '.gitignore': 'build/\n*.log\n',
      'keep.txt': 'one\ntwo\nthree\n',
      'gone.txt': 'bye\n',
      'move-me.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n',
      'logo.bin': Buffer.from([0, 1, 2, 3, 0, 255]),
    });
    r.commit('initial');
    const before = await snapshotTree(r.root);

    r.write('keep.txt', 'one\nTWO\nthree\n');
    unlinkSync(path.join(r.root, 'gone.txt'));
    r.git(['mv', 'move-me.txt', 'moved.txt']); // staged by the user: the snapshot sees the work tree either way
    r.write('new.txt', 'fresh\n'); // untracked, not ignored
    r.write('build/out.js', 'ignored\n');
    r.write('debug.log', 'ignored\n');
    r.write('logo.bin', Buffer.from([0, 1, 2, 3, 4, 0, 255]));
    const after = await snapshotTree(r.root);

    const { files, ...rest } = await diffTrees(r.root, before, after);
    expect(rest).toEqual({});
    expect(files.map((f) => [f.path, f.kind, f.oldPath ?? null, f.binary ?? false])).toEqual([
      ['gone.txt', 'delete', null, false],
      ['keep.txt', 'modify', null, false],
      ['logo.bin', 'modify', null, true],
      ['moved.txt', 'rename', 'move-me.txt', false],
      ['new.txt', 'add', null, false],
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    const blob = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex').slice(0, 7);
    expect(byPath['keep.txt']!.diff).toBe(
      `diff --git a/keep.txt b/keep.txt\nindex ${blob('one\ntwo\nthree\n')}..${blob('one\nTWO\nthree\n')} 100644\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n`,
    );
    expect(byPath['new.txt']!.diff).toBe(
      `diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..${blob('fresh\n')}\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n`,
    );
    expect(byPath['gone.txt']!.diff).toBe(
      `diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex ${blob('bye\n')}..0000000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n`,
    );
    expect(byPath['moved.txt']!.diff).toBe('diff --git a/move-me.txt b/moved.txt\nsimilarity index 100%\nrename from move-me.txt\nrename to moved.txt\n');
    expect(byPath['logo.bin']).toEqual({ path: 'logo.bin', kind: 'modify', diff: '', binary: true });
  });

  it("never touches the user's index, stash or refs", async () => {
    const r = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    r.commit('initial');
    r.write('a.txt', 'stashed\n');
    r.git(['stash', 'push', '-q', '-m', 'user stash']);
    r.write('a.txt', 'staged\n');
    r.git(['add', 'a.txt']); // staged ...
    r.write('a.txt', 'staged, then edited again\n'); // ... and changed again after staging
    r.write('b.txt', 'unstaged\n');
    r.write('untracked.txt', 'u\n');
    const before = userState(r);

    const start = await snapshotTree(r.root);
    r.write('c.txt', 'the agent wrote this\n');
    const end = await snapshotTree(r.root);
    await diffTrees(r.root, start, end);

    // c.txt shows as untracked: the agent's write, not the snapshot's doing.
    const after = userState(r);
    expect(after.stash).toBe(before.stash);
    expect(after.cached).toBe(before.cached);
    expect(after.index).toBe(before.index);
    expect(after.refs).toBe(before.refs);
    expect(after.status.split('\n').sort()).toEqual([...before.status.split('\n'), '?? c.txt'].sort());
    expect(before.stash).toMatch(/user stash/);
    // The snapshot recorded the work tree, not the staged version.
    expect(r.git(['show', `${end}:a.txt`])).toBe('staged, then edited again\n');
  });

  it('sees a same-size edit made in the same second the index was written ("racy git")', async () => {
    // git trusts an index entry's cached stat data unless the entry is "racily clean": its mtime is not
    // older than the index file's own mtime. Here the index and the file share one whole-second mtime, the
    // file is then rewritten to the same size with that mtime kept, so its stat data still matches the
    // entry and only the racy rule makes git look at the content. Fixed timestamps and trustctime=false
    // (ctime cannot be set from user space) make this independent of the clock.
    const r = repo({ 'src/app.ts': 'export const a = 1;\n' });
    r.git(['config', 'core.trustctime', 'false']);
    r.commit('initial');
    const file = path.join(r.root, 'src', 'app.ts');
    const index = path.join(r.root, '.git', 'index');
    const second = Math.floor(Date.now() / 1000) - 60;
    utimesSync(file, second, second);
    r.git(['update-index', '--refresh']); // the entry now caches mtime `second`
    utimesSync(index, second, second); // as if the index was written in that same second
    const before = await snapshotTree(r.root);

    r.write('src/app.ts', 'export const b = 2;\n'); // same size
    utimesSync(file, second, second);
    // git itself sees it (read-only: a status that rewrote the index would smudge the entry and hide the race)
    expect(r.git(['--no-optional-locks', 'status', '--porcelain=v1'])).toBe(' M src/app.ts\n');
    const after = await snapshotTree(r.root);

    const { files } = await diffTrees(r.root, before, after);
    expect(files.map((f) => [f.path, f.kind])).toEqual([['src/app.ts', 'modify']]);
    expect(r.git(['show', `${after}:src/app.ts`])).toBe('export const b = 2;\n');
  });

  it('a session folder below the root sees only its own files, with paths relative to it', async () => {
    const r = repo({ 'app/src/x.ts': 'x\n', 'other/y.ts': 'y\n' });
    r.commit('initial');
    const cwd = path.join(r.root, 'app');
    const before = await snapshotTree(cwd);
    r.write('app/src/x.ts', 'x2\n');
    r.write('app/new.ts', 'n\n');
    r.write('other/y.ts', 'y2\n'); // outside the session folder
    const after = await snapshotTree(cwd);
    const { files } = await diffTrees(cwd, before, after);
    expect(files.map((f) => [f.path, f.kind])).toEqual([
      ['new.ts', 'add'],
      ['src/x.ts', 'modify'],
    ]);
    expect(files[1]!.diff).toContain('--- a/src/x.ts\n+++ b/src/x.ts\n');
  });

  it('a file that became a symlink is a modify whose text holds both halves', async () => {
    const r = repo({ 'target.txt': 't\n', 'link': 'plain file\n' });
    r.commit('initial');
    const before = await snapshotTree(r.root);
    unlinkSync(path.join(r.root, 'link'));
    symlinkSync('target.txt', path.join(r.root, 'link'));
    const after = await snapshotTree(r.root);
    const { files } = await diffTrees(r.root, before, after);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'link', kind: 'modify' });
    expect(files[0]!.diff).toContain('deleted file mode 100644');
    expect(files[0]!.diff).toContain('new file mode 120000');
  });

  it('cuts diff text at the per-file and total caps, at a line end, and counts files past the file cap', async () => {
    const r = repo();
    r.commit('empty');
    const before = await snapshotTree(r.root);
    const line = `${'x'.repeat(99)}\n`; // 100 bytes per line
    r.write('big.txt', line.repeat(1000)); // ~100 KB: over the 64 KiB per-file cap
    r.write('small.txt', 'small\n');
    const after = await snapshotTree(r.root);

    const real = await diffTrees(r.root, before, after);
    expect(real.truncated).toBe(true);
    const big = real.files.find((f) => f.path === 'big.txt')!;
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.diff)).toBeLessThanOrEqual(MAX_FILE_DIFF_BYTES);
    expect(Buffer.byteLength(big.diff)).toBeGreaterThan(MAX_FILE_DIFF_BYTES - 200);
    expect(big.diff.endsWith('\n')).toBe(true);
    expect(big.diff.split('\n').slice(6, -1).every((l) => l === `+${'x'.repeat(99)}`)).toBe(true);
    expect(real.files.find((f) => f.path === 'small.txt')).not.toHaveProperty('truncated');

    // The total cap: the first file spends it, the second keeps its row with no text.
    const total = await diffTrees(r.root, before, after, { fileBytes: 1_000_000, totalBytes: 5_000, files: 10 });
    expect(total.files.map((f) => [f.path, f.truncated ?? false])).toEqual([
      ['big.txt', true],
      ['small.txt', true],
    ]);
    expect(Buffer.byteLength(total.files[0]!.diff)).toBeLessThanOrEqual(5_000);
    expect(total.files[1]!.diff).toBe('');

    const capped = await diffTrees(r.root, before, after, { ...DEFAULT_LIMITS, files: 1 });
    expect(capped).toMatchObject({ truncated: true, omittedFiles: 1 });
    expect(capped.files.map((f) => f.path)).toEqual(['big.txt']);
    expect([MAX_FILE_DIFF_BYTES, MAX_TOTAL_DIFF_BYTES, MAX_DIFF_FILES]).toEqual([65_536, 524_288, 500]);
  });

  it('HEAD is the empty tree before the first commit; a repository without an index snapshots too', async () => {
    const r = repo();
    const empty = await headTree(r.root);
    expect(empty).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    r.write('first.txt', '1\n');
    const tree = await snapshotTree(r.root);
    expect((await diffTrees(r.root, empty, tree)).files.map((f) => [f.path, f.kind])).toEqual([['first.txt', 'add']]);
    r.commit('first');
    expect(await headTree(r.root)).toBe(tree);
  });

  it('a folder outside git is no work tree; git errors reject', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'nano-plain-'));
    try {
      expect(await isWorkTree(plain)).toBe(false);
      expect(await isWorkTree(path.join(plain, 'missing'))).toBe(false);
      await expect(snapshotTree(plain)).rejects.toThrow(/git rev-parse failed/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const r = repo();
    expect(await isWorkTree(r.root)).toBe(true);
    await expect(diffTrees(r.root, 'nope', 'nope')).rejects.toThrow(/git diff failed/);
  });

  it('parses name-status records, copies as adds', () => {
    expect(parseNameStatus('M\0a\0R087\0old\0new\0C100\0src\0copy\0T\0link\0D\0d\0A\0n\0')).toEqual([
      { path: 'a', kind: 'modify' },
      { path: 'new', oldPath: 'old', kind: 'rename' },
      { path: 'copy', kind: 'add' },
      { path: 'link', kind: 'modify' },
      { path: 'd', kind: 'delete' },
      { path: 'n', kind: 'add' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });
});
