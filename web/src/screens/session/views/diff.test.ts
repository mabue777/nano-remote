import { describe, expect, it } from 'vitest';

import { FILE_KIND_LABEL, fileKind, parseAgentDiff, parseUnifiedDiff } from './diff';

const GIT_MODIFY = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 3b18e51..a1f4c2d 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@',
  ' import x from "x";',
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
  ' ',
  ' export { a };',
  '@@ -20,2 +21,2 @@ function tail() {',
  '-old();',
  '+fresh();',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('reads hunks into colored lines with old and new line numbers and counts', () => {
    const parsed = parseUnifiedDiff(GIT_MODIFY);
    expect(parsed.added).toBe(3);
    expect(parsed.removed).toBe(2);
    expect(parsed.binary).toBe(false);
    expect(parsed.renamedFrom).toBeUndefined();
    // The ---/+++ pair is not repeated; the other headers stay as meta lines.
    expect(parsed.lines.slice(0, 3)).toEqual([
      { kind: 'meta', text: 'diff --git a/src/app.ts b/src/app.ts' },
      { kind: 'meta', text: 'index 3b18e51..a1f4c2d 100644' },
      { kind: 'hunk', text: '@@ -1,4 +1,5 @@' },
    ]);
    expect(parsed.lines.slice(3, 9)).toEqual([
      { kind: 'context', text: 'import x from "x";', oldLine: 1, newLine: 1 },
      { kind: 'remove', text: 'const a = 1;', oldLine: 2 },
      { kind: 'add', text: 'const a = 2;', newLine: 2 },
      { kind: 'add', text: 'const b = 3;', newLine: 3 },
      { kind: 'context', text: '', oldLine: 3, newLine: 4 },
      { kind: 'context', text: 'export { a };', oldLine: 4, newLine: 5 },
    ]);
    expect(parsed.lines.slice(9)).toEqual([
      { kind: 'hunk', text: '@@ -20,2 +21,2 @@ function tail() {' },
      { kind: 'remove', text: 'old();', oldLine: 20 },
      { kind: 'add', text: 'fresh();', newLine: 21 },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ]);
  });

  it('takes bare hunks (no headers), CRLF line ends and single-line hunk ranges', () => {
    const parsed = parseUnifiedDiff('@@ -0,0 +1 @@\r\n+hello\r\n');
    expect(parsed.lines).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1 @@' },
      { kind: 'add', text: 'hello', newLine: 1 },
    ]);
    expect(parsed).toMatchObject({ added: 1, removed: 0 });
  });

  it('treats an empty line inside a hunk as an empty context line', () => {
    const parsed = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n-b\n+c');
    expect(parsed.lines[2]).toEqual({ kind: 'context', text: '', oldLine: 2, newLine: 2 });
  });

  it('is empty for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual({ lines: [], added: 0, removed: 0, binary: false });
  });

  it('finds renames from git rename headers', () => {
    const parsed = parseUnifiedDiff(
      ['diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts', '--- a/old.ts', '+++ b/new.ts', '@@ -1 +1 @@', '-x', '+y'].join('\n'),
    );
    expect(parsed.renamedFrom).toBe('old.ts');
    expect(parsed.lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'remove', 'add']);
  });

  it('finds renames from ---/+++ naming different paths, and not for added or deleted files', () => {
    expect(parseUnifiedDiff('--- a/lib/one.js\t2026-10-20\n+++ b/lib/two.js\n@@ -1 +1 @@\n-a\n+b').renamedFrom).toBe('lib/one.js');
    expect(parseUnifiedDiff('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+a').renamedFrom).toBeUndefined();
    expect(parseUnifiedDiff('--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a').renamedFrom).toBeUndefined();
    expect(parseUnifiedDiff('--- same.txt\n+++ same.txt\n@@ -1 +1 @@\n-a\n+b').renamedFrom).toBeUndefined();
  });

  it('marks binary patches', () => {
    expect(parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ').binary).toBe(true);
    expect(parseUnifiedDiff('diff --git a/x.png b/x.png\nGIT binary patch\nliteral 12').binary).toBe(true);
  });

  it('starts over at the next diff --git header inside one text', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\ndiff --git a/c b/c\n--- a/c\n+++ b/c\n@@ -5 +5 @@\n-c\n+d');
    expect(parsed.lines.map((l) => l.kind)).toEqual(['hunk', 'remove', 'add', 'meta', 'hunk', 'remove', 'add']);
    expect(parsed.lines.at(-1)).toEqual({ kind: 'add', text: 'd', newLine: 5 });
  });
});

describe('fileKind', () => {
  it('maps the protocol kinds and lets a rename win over modify', () => {
    expect(fileKind('add', {})).toBe('added');
    expect(fileKind('delete', {})).toBe('deleted');
    expect(fileKind('modify', {})).toBe('modified');
    expect(fileKind('modify', { renamedFrom: 'old.ts' })).toBe('renamed');
    expect(FILE_KIND_LABEL.renamed).toBe('Renamed');
  });
});

describe("tolerance for an adapter's diff", () => {
  const rows = (diff: ReturnType<typeof parseUnifiedDiff>) => diff.lines.map((l) => [l.kind, l.oldLine ?? null, l.newLine ?? null, l.text]);

  it('reads hunks without line numbers as plain removed and added lines, marked unnumbered', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@\n keep\n-old\n+new\n@@ function tail\n+more\n');
    expect(parsed.unnumbered).toBe(true);
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(1);
    expect(rows(parsed)).toEqual([
      ['context', null, null, 'keep'],
      ['remove', null, null, 'old'],
      ['add', null, null, 'new'],
      ['hunk', null, null, '@@ function tail'],
      ['add', null, null, 'more'],
    ]);
    // A numbered hunk after a bare one counts again.
    expect(rows(parseUnifiedDiff('@@\n-a\n@@ -7 +7 @@\n-b\n+c\n')).slice(-2)).toEqual([
      ['remove', 7, null, 'b'],
      ['add', null, 7, 'c'],
    ]);
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n').unnumbered).toBeUndefined();
  });

  it("reads a new or deleted file's plain content as added or removed lines numbered from 1", () => {
    const added = parseAgentDiff('# Title\n---\ntext\n', 'add');
    expect(added.unnumbered).toBeUndefined();
    expect(rows(added)).toEqual([
      ['add', null, 1, '# Title'],
      ['add', null, 2, '---'],
      ['add', null, 3, 'text'],
    ]);
    expect(rows(parseAgentDiff('bye', 'delete'))).toEqual([['remove', 1, null, 'bye']]);
    expect(parseAgentDiff('', 'add')).toMatchObject({ lines: [], added: 0, removed: 0 });
  });

  it('reads plain +/- lines of a changed file without line numbers, and patches as patches', () => {
    const plain = parseAgentDiff('-a\n+b\n c\n', 'modify');
    expect(plain.unnumbered).toBe(true);
    expect(rows(plain)).toEqual([
      ['remove', null, null, 'a'],
      ['add', null, null, 'b'],
      ['context', null, null, 'c'],
    ]);
    expect(parseAgentDiff(GIT_MODIFY, 'modify')).toEqual(parseUnifiedDiff(GIT_MODIFY));
    expect(parseAgentDiff('--- a/x\n+++ b/x\n', 'add').lines).toEqual([]);
  });
});
