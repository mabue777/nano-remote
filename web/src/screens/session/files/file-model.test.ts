import { describe, expect, it, vi } from 'vitest';

import type { StorageLike } from '../../../replica/storage';
import { RequestError } from '../../../stream/client';
import {
  BLOCK_LINES,
  binaryKindLabel,
  blockCount,
  blockOf,
  estimateBlockHeight,
  extensionOf,
  fileName,
  fileUrl,
  FileViewerModel,
  findMatches,
  folderOf,
  formatBytes,
  lineSegments,
  matchFrom,
  MAX_AUTO_RANGES,
  parseFileTarget,
  readErrorText,
  splitLines,
  stepMatch,
  textKindOf,
  visibleBlocks,
  WRAP_KEY,
  WrapPrefs,
  wrapDefault,
  type FileReader,
} from './file-model';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

/** A reader over an in-memory file, cutting ranges after a newline like the host (protocol 4.1). */
function fileReader(content: string, options: { binary?: boolean; mediaType?: string; maxBytes?: number } = {}) {
  const calls: Record<string, unknown>[] = [];
  const maxBytes = options.maxBytes ?? 262_144;
  const reader: FileReader = {
    request: async <T,>(method: string, params?: Record<string, unknown>) => {
      expect(method).toBe('fs/readFile');
      calls.push(params ?? {});
      const offset = Number(params?.offset ?? 0);
      const common = { path: String(params?.path), size: content.length, mtimeMs: 1_760_000_000_000, mediaType: options.mediaType ?? 'text/plain' };
      if (options.binary) return { ...common, binary: true, encoding: 'none', offset: 0, length: 0, truncated: false } as T;
      let end = Math.min(content.length, offset + maxBytes);
      if (end < content.length) {
        const newline = content.lastIndexOf('\n', end - 1);
        if (newline >= offset) end = newline + 1;
      }
      return { ...common, binary: false, encoding: 'utf8', content: content.slice(offset, end), offset, length: end - offset, truncated: end < content.length } as T;
    },
  };
  return { reader, calls };
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('kinds, names and sizes', () => {
  it.each([
    ['README.md', '', 'markdown'],
    ['docs/a.markdown', '', 'markdown'],
    ['notes', 'text/markdown', 'markdown'],
    ['a.txt', '', 'text'],
    ['run.log', '', 'text'],
    ['LICENSE', 'text/plain', 'text'],
    ['Makefile', 'text/plain', 'code'],
    ['.env', '', 'code'],
    ['src/parser.ts', 'text/x-typescript', 'code'],
    ['x.json', 'application/json', 'code'],
  ] as const)('%s (%s) is %s', (path, mediaType, kind) => {
    expect(textKindOf(path, mediaType)).toBe(kind);
  });

  it('wraps prose by default, not code', () => {
    expect([wrapDefault('markdown'), wrapDefault('text'), wrapDefault('code')]).toEqual([true, true, false]);
  });

  it('names and folders', () => {
    expect(fileName('src/a/parser.ts')).toBe('parser.ts');
    expect(fileName('parser.ts')).toBe('parser.ts');
    expect(fileName('')).toBe('');
    expect(folderOf('src/a/parser.ts')).toBe('src/a');
    expect(folderOf('parser.ts')).toBe('');
    expect(extensionOf('a/.env')).toBe('');
    expect(extensionOf('a/b.TS')).toBe('ts');
  });

  it('a path may end in :line or :line:column', () => {
    expect(parseFileTarget('src/parser.ts:42')).toEqual({ path: 'src/parser.ts', line: 42 });
    expect(parseFileTarget('src/parser.ts:42:7')).toEqual({ path: 'src/parser.ts', line: 42 });
    expect(parseFileTarget('src/parser.ts:0')).toEqual({ path: 'src/parser.ts' });
    expect(parseFileTarget('src/parser.ts')).toEqual({ path: 'src/parser.ts' });
    expect(parseFileTarget(':12')).toEqual({ path: ':12' });
  });

  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [999, '999 bytes'],
    [1000, '1 KB'],
    [12_345, '12 KB'],
    [262_144, '262 KB'],
    [1_234_567, '1.2 MB'],
    [123_456_789, '123 MB'],
    [5_000_000_000_000, '5000 GB'],
  ])('%d bytes read %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it('describes binary kinds', () => {
    expect(binaryKindLabel('image/png', 'a.png')).toBe('PNG image');
    expect(binaryKindLabel('application/pdf', 'a.pdf')).toBe('PDF document');
    expect(binaryKindLabel('application/octet-stream', 'db.sqlite')).toBe('SQLITE file');
    expect(binaryKindLabel('application/octet-stream', 'blob')).toBe('Binary file');
  });

  it('splits lines without a phantom last line, dropping CRs', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('\n')).toEqual(['']);
  });

  it('builds the /v1/file URL', () => {
    expect(fileUrl('ses_1', 'src/a b.png')).toBe('/v1/file?sessionId=ses_1&path=src%2Fa+b.png');
  });

  it('words read errors', () => {
    expect(readErrorText(new RequestError('not_found', 'x'))).toEqual({ message: 'That file is not in the session folder.', missing: true });
    expect(readErrorText(new RequestError('invalid_params', 'x')).message).toBe('This is not a file that can be shown here.');
    expect(readErrorText(new RequestError('timeout', 'x')).message).toContain('connection');
    expect(readErrorText(new RequestError('internal', 'boom')).message).toBe('boom');
    expect(readErrorText('?').message).toBe('Something went wrong.');
  });
});

describe('WrapPrefs', () => {
  it('remembers the choice per kind', () => {
    const storage = memoryStorage();
    const prefs = new WrapPrefs(storage);
    expect(prefs.get('code')).toBe(false);
    prefs.set('code', true);
    prefs.set('markdown', false);
    expect(JSON.parse(storage.data[WRAP_KEY]!)).toEqual({ code: true, markdown: false });
    const again = new WrapPrefs(storage);
    expect([again.get('code'), again.get('markdown'), again.get('text')]).toEqual([true, false, true]);
  });

  it('survives no storage, junk and a storage that throws', () => {
    const none = new WrapPrefs(null);
    none.set('code', true);
    expect(none.get('code')).toBe(false);
    expect(new WrapPrefs(memoryStorage({ [WRAP_KEY]: '{bad' })).get('text')).toBe(true);
    expect(new WrapPrefs(memoryStorage({ [WRAP_KEY]: '7' })).get('code')).toBe(false);
    const full = memoryStorage();
    full.setItem = () => {
      throw new Error('quota');
    };
    expect(() => new WrapPrefs(full).set('code', true)).not.toThrow();
  });
});

describe('find', () => {
  const lines = ['const a = 1;', 'A and a', 'nothing', 'aaa'];

  it('finds plain text, case-insensitive by default', () => {
    const { matches, capped } = findMatches(lines, 'a', false);
    expect(capped).toBe(false);
    expect(matches.filter((m) => m.line === 1)).toEqual([
      { line: 1, start: 0, end: 1 },
      { line: 1, start: 2, end: 3 },
      { line: 1, start: 6, end: 7 },
    ]);
    expect(findMatches(lines, 'A', true).matches).toEqual([{ line: 1, start: 0, end: 1 }]);
    expect(findMatches(lines, 'aa', false).matches).toEqual([{ line: 3, start: 0, end: 2 }]);
  });

  it('treats the query as text, not a pattern, and caps the count', () => {
    expect(findMatches(['a.b', 'axb'], 'a.b', false).matches).toEqual([{ line: 0, start: 0, end: 3 }]);
    expect(findMatches(['(x)'], '(', false).matches).toHaveLength(1);
    expect(findMatches(lines, '', false)).toEqual({ matches: [], capped: false });
    expect(findMatches(['aaaa'], 'a', false, 2)).toEqual({ matches: [expect.anything(), expect.anything()], capped: true });
  });

  it('steps with wrap-around and starts from the reader', () => {
    expect(stepMatch(-1, 0, 1)).toBe(-1);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    const { matches } = findMatches(lines, 'a', false);
    expect(matchFrom(matches, 2)).toBe(matches.findIndex((m) => m.line === 3));
    expect(matchFrom(matches, 9)).toBe(0);
    expect(matchFrom([], 0)).toBe(-1);
  });

  it('cuts a line at its matches', () => {
    expect(lineSegments('abc', [])).toEqual([{ text: 'abc' }]);
    expect(
      lineSegments('xaybz', [
        { start: 1, end: 2, current: false },
        { start: 3, end: 4, current: true },
      ]),
    ).toEqual([{ text: 'x' }, { text: 'a', mark: 'match' }, { text: 'y' }, { text: 'b', mark: 'current' }, { text: 'z' }]);
    expect(lineSegments('ab', [{ start: 0, end: 2, current: true }])).toEqual([{ text: 'ab', mark: 'current' }]);
  });
});

describe('windowing', () => {
  it('blocks and estimates', () => {
    expect(blockCount(0)).toBe(0);
    expect(blockCount(BLOCK_LINES + 1)).toBe(2);
    expect(blockOf(BLOCK_LINES - 1)).toBe(0);
    expect(blockOf(BLOCK_LINES)).toBe(1);
    const lines = ['x'.repeat(25), '', 'y'.repeat(10)];
    expect(estimateBlockHeight(lines, 0, { wrap: false, columns: 10, lineHeight: 18 })).toBe(54);
    expect(estimateBlockHeight(lines, 0, { wrap: true, columns: 10, lineHeight: 18 })).toBe((3 + 1 + 1) * 18);
    expect(estimateBlockHeight(lines, 0, { wrap: true, columns: 0, lineHeight: 18 })).toBe((25 + 1 + 10) * 18);
  });

  it('picks the blocks that meet the viewport plus overscan, with spacer heights', () => {
    const heights = [100, 100, 100, 100, 100];
    expect(visibleBlocks([], 0, 100, 0)).toEqual({ first: 0, last: -1, before: 0, after: 0 });
    expect(visibleBlocks(heights, 0, 150, 0)).toEqual({ first: 0, last: 1, before: 0, after: 300 });
    expect(visibleBlocks(heights, 250, 260, 60)).toEqual({ first: 1, last: 3, before: 100, after: 100 });
    expect(visibleBlocks(heights, 900, 1000, 0)).toEqual({ first: 4, last: 4, before: 400, after: 0 });
    expect(visibleBlocks(heights, -500, -400, 0)).toEqual({ first: 0, last: 0, before: 0, after: 400 });
  });
});

describe('FileViewerModel', () => {
  it('loads a text file and shows its lines; a code file does not wrap', async () => {
    const { reader, calls } = fileReader('const a = 1;\nconst b = 2;\n');
    const model = new FileViewerModel({ sessionId: 'ses_1', path: 'src/a.ts', reader, storage: memoryStorage() });
    const seen = vi.fn();
    model.subscribe(seen);
    expect(model.state).toEqual({ state: 'loading' });
    await model.load();
    expect(calls).toEqual([{ sessionId: 'ses_1', path: 'src/a.ts' }]);
    expect(model.state).toMatchObject({ state: 'text', info: { path: 'src/a.ts', size: 26 } });
    expect(model.lines).toEqual(['const a = 1;', 'const b = 2;']);
    expect(model.loadedText).toBe('const a = 1;\nconst b = 2;\n');
    expect(model.hasMore).toBe(false);
    expect(model.loadedBytes).toBe(26);
    expect(model.wrap).toBe(false);
    expect(model.canRender).toBe(false);
    expect(model.rendered).toBe(false);
    expect(model.scrollTarget).toBeUndefined();
    expect(seen).toHaveBeenCalled();
  });

  it('shows a binary file as a card', async () => {
    const { reader } = fileReader('', { binary: true, mediaType: 'image/png' });
    const model = new FileViewerModel({ sessionId: 's', path: 'shot.png', reader, storage: null });
    await model.load();
    expect(model.state).toMatchObject({ state: 'binary', kindLabel: 'PNG image', info: { mediaType: 'image/png' } });
  });

  it('says when the file is not there, and loads again on retry', async () => {
    let fail = true;
    const { reader: inner } = fileReader('ok\n');
    const reader: FileReader = {
      request: async <T,>(method: string, params?: Record<string, unknown>) => {
        if (fail) throw new RequestError('not_found', 'no such file');
        return inner.request<T>(method, params);
      },
    };
    const model = new FileViewerModel({ sessionId: 's', path: 'gone.ts', reader, storage: null });
    await model.load();
    expect(model.state).toEqual({ state: 'error', message: 'That file is not in the session folder.', missing: true });
    fail = false;
    await model.load();
    expect(model.lines).toEqual(['ok']);
  });

  it('reads the next range on "Show more", joining a line cut by the range', async () => {
    const content = 'x'.repeat(30) + '\n' + 'y'.repeat(40) + '\nlast\n';
    const { reader, calls } = fileReader(content, { maxBytes: 20 });
    const model = new FileViewerModel({ sessionId: 's', path: 'a.txt', reader, storage: null });
    await model.load();
    expect(model.hasMore).toBe(true);
    expect(model.lines).toEqual(['x'.repeat(20)]);
    while (model.hasMore) await model.more();
    expect(model.lines).toEqual(['x'.repeat(30), 'y'.repeat(40), 'last']);
    expect(calls.map((c) => c.offset)).toEqual([undefined, 20, 31, 51, 71]);
    expect(model.loadingMore).toBe(false);
    await model.more(); // nothing more: no request
    expect(calls).toHaveLength(5);
  });

  it('keeps the text when "Show more" fails, and says so', async () => {
    const { reader: inner } = fileReader(numbered(10), { maxBytes: 20 });
    let fail = false;
    const reader: FileReader = {
      request: async <T,>(method: string, params?: Record<string, unknown>) => {
        if (fail) throw new RequestError('connection_lost', 'gone');
        return inner.request<T>(method, params);
      },
    };
    const model = new FileViewerModel({ sessionId: 's', path: 'a.txt', reader, storage: null });
    await model.load();
    const before = model.lines.length;
    fail = true;
    await model.more();
    expect(model.moreError).toContain('connection');
    expect(model.lines).toHaveLength(before);
    expect(model.loadingMore).toBe(false);
  });

  it('jumps to path:line, reading on to reach it, and tints it', async () => {
    const { reader, calls } = fileReader(numbered(100), { maxBytes: 300 });
    const model = new FileViewerModel({ sessionId: 's', path: 'big.txt:80', reader, storage: null });
    expect(model.path).toBe('big.txt');
    expect(model.line).toBe(80);
    await model.load();
    expect(model.lines.length).toBeGreaterThanOrEqual(80);
    expect(calls.length).toBeGreaterThan(1);
    expect(model.scrollTarget).toEqual({ line: 79, flash: true, token: expect.any(Number) });
  });

  it('a jump past what it may read lands on the last line read', async () => {
    const { reader, calls } = fileReader(numbered(1000), { maxBytes: 100 });
    const model = new FileViewerModel({ sessionId: 's', path: 'big.txt', line: 900, reader, storage: null });
    await model.load();
    expect(calls).toHaveLength(MAX_AUTO_RANGES);
    expect(model.scrollTarget?.line).toBe(model.lines.length - 1);
    expect(model.hasMore).toBe(true);
  });

  it('a jump in an empty file goes to the first line', async () => {
    const { reader } = fileReader('');
    const model = new FileViewerModel({ sessionId: 's', path: 'empty.ts', line: 5, reader, storage: null });
    await model.load();
    expect(model.lines).toEqual([]);
    expect(model.scrollTarget?.line).toBe(0);
  });

  it('markdown renders by default, raw for a line jump; wrap is remembered per kind', async () => {
    const storage = memoryStorage();
    const { reader } = fileReader('# Title\n\nText.\n');
    const md = new FileViewerModel({ sessionId: 's', path: 'README.md', reader, storage });
    await md.load();
    expect([md.canRender, md.rendered, md.wrap]).toEqual([true, true, true]);
    md.setRendered(false);
    expect(md.rendered).toBe(false);
    md.setRendered(false); // unchanged
    md.setWrap(false);
    md.setWrap(false);
    expect(new FileViewerModel({ sessionId: 's', path: 'other.md', reader, storage }).wrap).toBe(false);
    expect(new FileViewerModel({ sessionId: 's', path: 'a.md:3', reader, storage }).rendered).toBe(false);
    const code = new FileViewerModel({ sessionId: 's', path: 'a.ts', reader, storage });
    code.setRendered(true); // code cannot render
    expect(code.rendered).toBe(false);
  });

  it('find counts, steps, toggles case and survives more text', async () => {
    const { reader } = fileReader('Alpha\nbeta\nALPHA alpha\n' + 'z\n'.repeat(20), { maxBytes: 30 });
    const model = new FileViewerModel({ sessionId: 's', path: 'README.md', reader, storage: null });
    await model.load();
    expect(model.findCount).toBe('');
    model.openFind();
    expect([model.findOpen, model.rendered]).toEqual([true, false]);
    model.setQuery('alpha');
    expect(model.findCount).toBe('1 of 3');
    expect(model.scrollTarget).toMatchObject({ line: 0, flash: false });
    model.next();
    model.next();
    expect(model.findCount).toBe('3 of 3');
    model.next();
    expect(model.findCount).toBe('1 of 3');
    model.previous();
    expect(model.findCount).toBe('3 of 3');
    model.setMatchCase(true);
    expect(model.findCount).toBe('1 of 1');
    expect(model.matches[model.current]).toEqual({ line: 2, start: 6, end: 11 });
    model.setMatchCase(true); // unchanged
    await model.more();
    expect(model.findCount).toBe('1 of 1');
    model.setQuery('nope');
    expect(model.findCount).toBe('No results');
    const target = model.scrollTarget;
    model.next(); // nothing to step to
    expect(model.scrollTarget).toBe(target);
    model.setQuery('z', 4);
    expect(model.matches[model.current]!.line).toBe(4);
    model.setRendered(true);
    expect(model.findOpen).toBe(false);
    model.closeFind();
    model.openFind();
    model.closeFind();
    expect(model.findOpen).toBe(false);
  });

  it('a match that disappears after more text falls back to the first', async () => {
    const { reader } = fileReader('a\nb\n', { maxBytes: 4096 });
    const model = new FileViewerModel({ sessionId: 's', path: 'x.txt', reader, storage: null });
    await model.load();
    model.setQuery('a');
    model.matches = [{ line: 9, start: 0, end: 1 }]; // as if the text had changed under it
    model.current = 0;
    // @ts-expect-error reaching the private refind for the fallback branch
    model.refind(false);
    expect(model.current).toBe(0);
  });

  it('ignores answers after dispose or a newer load', async () => {
    let release: (() => void) | undefined;
    const { reader: inner } = fileReader('a\n');
    const reader: FileReader = {
      request: <T,>(method: string, params?: Record<string, unknown>) =>
        new Promise<T>((resolve, reject) => {
          release = () => void inner.request<T>(method, params).then(resolve, reject);
        }),
    };
    const model = new FileViewerModel({ sessionId: 's', path: 'a.txt', reader, storage: null });
    const first = model.load();
    model.dispose();
    release!();
    await first;
    expect(model.state).toEqual({ state: 'loading' });

    const failing: FileReader = { request: () => Promise.reject(new RequestError('timeout', 'slow')) };
    const other = new FileViewerModel({ sessionId: 's', path: 'a.txt', reader: failing, storage: null });
    const pending = other.load();
    other.dispose();
    await pending;
    expect(other.state).toEqual({ state: 'loading' });
  });

  it('a "Show more" answer after dispose is dropped', async () => {
    const { reader: inner } = fileReader(numbered(20), { maxBytes: 20 });
    let hold = false;
    let release: (() => void) | undefined;
    const reader: FileReader = {
      request: <T,>(method: string, params?: Record<string, unknown>) =>
        hold
          ? new Promise<T>((resolve, reject) => {
              release = () => void inner.request<T>(method, params).then(resolve, reject);
            })
          : inner.request<T>(method, params),
    };
    const model = new FileViewerModel({ sessionId: 's', path: 'a.txt', reader, storage: null });
    await model.load();
    const before = model.lines.length;
    hold = true;
    const more = model.more();
    await model.more(); // already reading: ignored
    model.dispose();
    release!();
    await more;
    expect(model.lines).toHaveLength(before);

    const failing = new FileViewerModel({ sessionId: 's', path: 'a.txt', reader, storage: null });
    hold = false;
    await failing.load();
    hold = true;
    const failed = failing.more();
    failing.dispose();
    inner.request = () => Promise.reject(new RequestError('timeout', 'slow'));
    release!();
    await failed;
    expect(failing.moreError).toBeUndefined();
  });
});
