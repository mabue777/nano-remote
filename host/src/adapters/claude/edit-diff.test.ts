import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_DIFF_BYTES, MAX_FILE_BYTES, addedDiff, applyEdits, capDiff, readCurrent, unifiedDiff } from './edit-diff.js';
import { fileChangesFor } from './mapping.js';

/** Twenty numbered lines, "line 1" to "line 20", each ending in a newline. */
const TWENTY = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join('');

function folder(files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'nano-claude-diff-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(cwd, name), text);
  return cwd;
}

describe('unifiedDiff', () => {
  it('numbers the hunk from the file and keeps 3 lines of context', () => {
    expect(unifiedDiff(TWENTY, TWENTY.replace('line 10\n', 'line ten\n'))).toBe(
      ['@@ -7,7 +7,7 @@', ' line 7', ' line 8', ' line 9', '-line 10', '+line ten', ' line 11', ' line 12', ' line 13'].join('\n'),
    );
  });

  it('splits far apart changes into hunks and joins close ones', () => {
    const far = unifiedDiff(TWENTY, TWENTY.replace('line 2\n', 'two\n').replace('line 19\n', 'nineteen\n'));
    expect(far.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,5 +1,5 @@', '@@ -16,5 +16,5 @@']);
    const close = unifiedDiff(TWENTY, TWENTY.replace('line 5\n', 'five\n').replace('line 11\n', 'eleven\n'));
    expect(close.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -2,13 +2,13 @@']);
  });

  it('numbers inserts and deletes at the edges, and says nothing for equal texts', () => {
    expect(unifiedDiff('a\nb\n', 'top\na\nb\n')).toBe('@@ -1,2 +1,3 @@\n+top\n a\n b');
    expect(unifiedDiff('a\n', '')).toBe('@@ -1,1 +0,0 @@\n-a');
    expect(unifiedDiff('', 'a\n')).toBe('@@ -0,0 +1,1 @@\n+a');
    expect(unifiedDiff('same\n', 'same\n')).toBe('');
  });

  it('finds the shortest edit inside a changed middle', () => {
    expect(unifiedDiff('a\nb\nc\nd\n', 'a\nx\nc\ny\n')).toBe('@@ -1,4 +1,4 @@\n a\n-b\n+x\n c\n-d\n+y');
  });

  it('shows a middle past the edit limit as one removed and one added block', () => {
    const before = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n');
    const diff = unifiedDiff(`head\n${before}\ntail\n`, `head\n${after}\ntail\n`).split('\n');
    expect(diff[0]).toBe('@@ -1,602 +1,602 @@');
    expect(diff[2]).toBe('-old 0');
    expect(diff[602]).toBe('+new 0');
  });

  it('cuts at a line end within 64 KiB', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `a line of text number ${i}`).join('\n');
    const diff = addedDiff(big);
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(diff.endsWith('\n')).toBe(false);
    expect(diff.split('\n').at(-1)).toMatch(/^\+a line of text number \d+$/);
    expect(capDiff('short')).toBe('short');
    expect(capDiff('x'.repeat(MAX_DIFF_BYTES + 1))).toBe('');
    expect(addedDiff('')).toBe('');
  });
});

describe('applyEdits and readCurrent', () => {
  it('replaces the first occurrence, or every one with replaceAll, and gives up on a missing or empty string', () => {
    expect(applyEdits('a b a', [{ oldString: 'a', newString: 'c', replaceAll: false }])).toBe('c b a');
    expect(applyEdits('a b a', [{ oldString: 'a', newString: 'c', replaceAll: true }])).toBe('c b c');
    expect(applyEdits('a', [{ oldString: 'z', newString: 'c', replaceAll: false }])).toBeUndefined();
    expect(applyEdits('a', [{ oldString: '', newString: 'c', replaceAll: false }])).toBeUndefined();
  });

  it('reads files, says missing for no such path, and skips folders and files over 1 MB', () => {
    const cwd = folder({ 'a.txt': 'hi', 'big.txt': 'x'.repeat(MAX_FILE_BYTES + 1) });
    mkdirSync(path.join(cwd, 'sub'));
    expect(readCurrent(path.join(cwd, 'a.txt'))).toBe('hi');
    expect(readCurrent(path.join(cwd, 'nope.txt'))).toBe('missing');
    expect(readCurrent(path.join(cwd, 'sub'))).toBeUndefined();
    expect(readCurrent(path.join(cwd, 'big.txt'))).toBeUndefined();
    expect(readCurrent('\0bad')).toBeUndefined();
  });
});

describe('fileChangesFor with the file at hand', () => {
  it('Edit: a real hunk around the first occurrence', () => {
    const cwd = folder({ 'f.txt': TWENTY });
    expect(fileChangesFor('Edit', { file_path: path.join(cwd, 'f.txt'), old_string: 'line 1', new_string: 'first' }, cwd)).toEqual([
      { path: path.join(cwd, 'f.txt'), kind: 'modify', diff: '@@ -1,4 +1,4 @@\n-line 1\n+first\n line 2\n line 3\n line 4' },
    ]);
  });

  it('Edit with replace_all: every occurrence, in one hunk or several', () => {
    const cwd = folder({ 'f.txt': TWENTY });
    const [change] = fileChangesFor('Edit', { file_path: 'f.txt', old_string: 'line 2', new_string: 'L2', replace_all: true }, cwd);
    // "line 2" and "line 20" both match: lines 2 and 20.
    expect(change!.diff.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,5 +1,5 @@', '@@ -17,4 +17,4 @@']);
    expect(change!.diff).toContain('-line 20\n+L20');
  });

  it('Edit whose old_string is not in the file keeps the call text as its hunk', () => {
    const cwd = folder({ 'f.txt': TWENTY });
    expect(fileChangesFor('Edit', { file_path: 'f.txt', old_string: 'absent\nhere', new_string: 'x' }, cwd)).toEqual([
      { path: 'f.txt', kind: 'modify', diff: '@@ -1,2 +1,1 @@\n-absent\n-here\n+x' },
    ]);
  });

  it('Edit of a file over 1 MB keeps the call text as its hunk', () => {
    const cwd = folder({ 'big.txt': `needle\n${'x'.repeat(MAX_FILE_BYTES)}` });
    expect(fileChangesFor('Edit', { file_path: 'big.txt', old_string: 'needle', new_string: 'pin' }, cwd)[0]!.diff).toBe('@@ -1,1 +1,1 @@\n-needle\n+pin');
  });

  it('Edit with an empty old_string on a missing file creates it', () => {
    const cwd = folder();
    expect(fileChangesFor('Edit', { file_path: 'n.txt', old_string: '', new_string: 'a\nb' }, cwd)).toEqual([
      { path: 'n.txt', kind: 'add', diff: '@@ -0,0 +1,2 @@\n+a\n+b' },
    ]);
  });

  it('Write of an existing file: a real diff against its content; unchanged content keeps the call text', () => {
    const cwd = folder({ 'f.txt': TWENTY });
    const next = TWENTY.replace('line 15\n', 'line 15\nadded\n');
    expect(fileChangesFor('Write', { file_path: 'f.txt', content: next }, cwd)).toEqual([
      { path: 'f.txt', kind: 'modify', diff: '@@ -13,6 +13,7 @@\n line 13\n line 14\n line 15\n+added\n line 16\n line 17\n line 18' },
    ]);
    expect(fileChangesFor('Write', { file_path: 'f.txt', content: TWENTY }, cwd)[0]!.diff).toBe(
      `@@ -0,0 +1,20 @@\n${TWENTY.trimEnd()
        .split('\n')
        .map((l) => `+${l}`)
        .join('\n')}`,
    );
  });

  it('Write of a new file: an add with every line, capped', () => {
    const cwd = folder();
    expect(fileChangesFor('Write', { file_path: 'new.txt', content: 'a\nb\n' }, cwd)).toEqual([{ path: 'new.txt', kind: 'add', diff: '@@ -0,0 +1,2 @@\n+a\n+b' }]);
    const big = fileChangesFor('Write', { file_path: 'big.txt', content: 'y\n'.repeat(MAX_DIFF_BYTES) }, cwd)[0]!;
    expect(big.kind).toBe('add');
    expect(Buffer.byteLength(big.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
  });

  it('MultiEdit: the edits applied in order to the text in memory', () => {
    const cwd = folder({ 'f.txt': TWENTY });
    const edits = [
      { old_string: 'line 3', new_string: 'third' },
      { old_string: 'third', new_string: 'THIRD' }, // sees the first edit's result
      { old_string: 'line 18', new_string: 'eighteen' },
    ];
    const diff = fileChangesFor('MultiEdit', { file_path: 'f.txt', edits }, cwd)[0]!.diff;
    expect(diff.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,6 +1,6 @@', '@@ -15,6 +15,6 @@']);
    expect(diff).toContain('-line 3\n+THIRD');
    expect(diff).toContain('-line 18\n+eighteen');
    // One edit that does not apply: the call text of every edit, as before.
    const broken = fileChangesFor('MultiEdit', { file_path: 'f.txt', edits: [{ old_string: 'line 3', new_string: 'x' }, { old_string: 'nope', new_string: 'y' }] }, cwd);
    expect(broken[0]!.diff).toBe('@@ -1,1 +1,1 @@\n-line 3\n+x\n@@ -1,1 +1,1 @@\n-nope\n+y');
  });

  it('NotebookEdit is unchanged: its new source as one hunk', () => {
    const cwd = folder({ 'n.ipynb': '{}' });
    expect(fileChangesFor('NotebookEdit', { notebook_path: path.join(cwd, 'n.ipynb'), new_source: 'print(1)' }, cwd)[0]!.diff).toBe('@@ -0,0 +1,1 @@\n+print(1)');
  });
});
