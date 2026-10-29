import { describe, expect, it } from 'vitest';

import { fileHref, linkifyPaths } from './file-link';

const links = (text: string) => linkifyPaths(text).filter((segment) => segment.path !== undefined);

describe('linkifyPaths', () => {
  it('links a relative path with a line and keeps the text around it', () => {
    expect(linkifyPaths('See src/parser.ts:42 for the fix.')).toEqual([
      { text: 'See ' },
      { text: 'src/parser.ts:42', path: 'src/parser.ts', line: 42 },
      { text: ' for the fix.' },
    ]);
  });

  it('links bare names with a known extension, and paths with a slash and any extension', () => {
    expect(links('Edit package.json and README.md, then run.sh').map((s) => s.path)).toEqual(['package.json', 'README.md', 'run.sh']);
    expect(links('the component src/App.vue and ./foo.ts and ../config.json').map((s) => s.path)).toEqual(['src/App.vue', './foo.ts', '../config.json']);
  });

  it('reads a line and column, and keeps only the line', () => {
    expect(links('at web/src/app.tsx:12:5')).toEqual([{ text: 'web/src/app.tsx:12:5', path: 'web/src/app.tsx', line: 12 }]);
  });

  it('strips quotes, backticks, brackets and sentence punctuation from the link', () => {
    expect(linkifyPaths('(`src/foo.ts`), "README.md".')).toEqual([
      { text: '(`' },
      { text: 'src/foo.ts', path: 'src/foo.ts' },
      { text: '`), "' },
      { text: 'README.md', path: 'README.md' },
      { text: '".' },
    ]);
  });

  it('leaves prose alone: abbreviations, and/or, numbers, versions', () => {
    for (const text of ['e.g. this', 'i.e. that', 'vs. them', 'read and/or write', 'pi is 3.14', 'v1.2/3.4', 'node 22.1', 'see docs/']) {
      expect(links(text), text).toEqual([]);
    }
  });

  it('leaves URLs, absolute and home paths, and tokens with odd characters alone', () => {
    for (const text of ['https://example.com/a.ts', 'file:///Users/x/a.ts', '/absolute/path.ts', '~/notes.md', 'a:b.ts', 'src/<x>.ts']) {
      expect(links(text), text).toEqual([]);
    }
  });

  it('never links across spaces', () => {
    expect(links('src/foo bar.ts').map((s) => s.path)).toEqual(['bar.ts']);
  });

  it('returns the whole text as one plain piece when there are no paths', () => {
    expect(linkifyPaths('Just some text.')).toEqual([{ text: 'Just some text.' }]);
  });
});

describe('fileHref', () => {
  it('is the file route with the path and line in the query', () => {
    expect(fileHref('s1', 'src/a.ts', 3)).toBe('/s/s1/file?path=src%2Fa.ts&line=3');
    expect(fileHref('s1', 'src/a.ts')).toBe('/s/s1/file?path=src%2Fa.ts');
  });
});
