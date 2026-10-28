import { describe, expect, it } from 'vitest';

import { FakeFiles, FileError } from './fake-files';

// The fake session folders must follow protocol-v1.md section 4.1 the way the real host does, or the viewer's
// e2e proves nothing: scope, the binary sniff and line-aligned ranges.

const CWD = '/Users/me/Desktop/phone-test';

function files(): FakeFiles {
  const f = new FakeFiles();
  f.put('s', 'src/a.ts', 'one\ntwo\nthree\n', 1000);
  f.put('s', 'bin.dat', Buffer.from([1, 0, 2]));
  f.put('s', 'big.txt', Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  return f;
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? [error.code, error.data] : error;
  }
  return 'no error';
};

describe('FakeFiles', () => {
  it('reads inside the folder, by relative or absolute path', () => {
    const f = files();
    expect(f.read('s', CWD, { path: 'src/a.ts' })).toEqual({
      path: 'src/a.ts', size: 14, mtimeMs: 1000, mediaType: 'text/x-typescript', binary: false, encoding: 'utf8', content: 'one\ntwo\nthree\n', offset: 0, length: 14, truncated: false,
    });
    expect(f.read('s', CWD, { path: `${CWD}/src/./a.ts` }).path).toBe('src/a.ts');
  });

  it('answers not_found for .., absolute paths elsewhere and missing files; invalid_params for a folder', () => {
    const f = files();
    expect(code(() => f.read('s', CWD, { path: '../x' }))).toEqual(['not_found', { path: '../x' }]);
    expect(code(() => f.read('s', CWD, { path: 'src/../../phone-test-2/a' }))).toEqual(['not_found', { path: 'src/../../phone-test-2/a' }]);
    expect(code(() => f.read('s', CWD, { path: '/etc/passwd' }))).toEqual(['not_found', { path: '/etc/passwd' }]);
    expect(code(() => f.read('s', CWD, { path: 'nope' }))).toEqual(['not_found', { path: 'nope' }]);
    expect(code(() => f.read('s', CWD, { path: 'src' }))).toEqual(['invalid_params', { path: 'params.path' }]);
    expect(code(() => f.read('s', CWD, { path: '' }))).toEqual(['invalid_params', { path: 'params.path' }]);
    expect(code(() => f.read('s', CWD, { path: 'src/a.ts', offset: 99 }))).toEqual(['invalid_params', { path: 'params.offset' }]);
  });

  it('calls a file with a NUL binary, without content', () => {
    expect(files().read('s', CWD, { path: 'bin.dat' })).toMatchObject({ binary: true, encoding: 'none', offset: 0, length: 0, truncated: false, mediaType: 'application/octet-stream' });
  });

  it('cuts ranges after a newline and moves an offset back to its line start', () => {
    const f = files();
    const first = f.read('s', CWD, { path: 'big.txt', maxBytes: 4096 });
    expect(first.truncated).toBe(true);
    expect(first.content.endsWith('\n')).toBe(true);
    const next = f.read('s', CWD, { path: 'big.txt', offset: first.offset + first.length, maxBytes: 4096 });
    expect(next.offset).toBe(first.length);
    const mid = f.read('s', CWD, { path: 'big.txt', offset: first.length + 3 });
    expect(mid.offset).toBe(first.length);
    expect(f.read('s', CWD, { path: 'big.txt', maxBytes: 1 }).length).toBeGreaterThan(4000); // at least 4096 read
  });
});
