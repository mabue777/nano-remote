import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('splits paragraphs at blank lines and keeps line breaks inside one', () => {
    expect(parseMarkdown('Hello\nworld\n\nSecond')).toEqual([
      { kind: 'p', inlines: [{ kind: 'text', text: 'Hello\nworld' }] },
      { kind: 'p', inlines: [{ kind: 'text', text: 'Second' }] },
    ]);
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2);
  });

  it('reads headings, capping the level at 3', () => {
    expect(parseMarkdown('# One\n### Three\n###### Six')).toEqual([
      { kind: 'h', level: 1, inlines: [{ kind: 'text', text: 'One' }] },
      { kind: 'h', level: 3, inlines: [{ kind: 'text', text: 'Three' }] },
      { kind: 'h', level: 3, inlines: [{ kind: 'text', text: 'Six' }] },
    ]);
  });

  it('reads fenced code verbatim, and an unclosed fence as a growing block', () => {
    expect(parseMarkdown('Before\n```ts\nconst a = **1**;\n\nx\n```\nAfter')).toEqual([
      { kind: 'p', inlines: [{ kind: 'text', text: 'Before' }] },
      { kind: 'code', lang: 'ts', text: 'const a = **1**;\n\nx' },
      { kind: 'p', inlines: [{ kind: 'text', text: 'After' }] },
    ]);
    expect(parseMarkdown('~~~\nopen')).toEqual([{ kind: 'code', lang: '', text: 'open' }]);
  });

  it('groups bullet and numbered items into lists', () => {
    expect(parseMarkdown('- a\n* b\n\n3. c\n4) d\n- e')).toEqual([
      { kind: 'ul', items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]] },
      { kind: 'ol', start: 3, items: [[{ kind: 'text', text: 'c' }], [{ kind: 'text', text: 'd' }]] },
      { kind: 'ul', items: [[{ kind: 'text', text: 'e' }]] },
    ]);
  });

  it('joins quote lines and ends a paragraph before a block', () => {
    expect(parseMarkdown('para\n> one **x**\n> two')).toEqual([
      { kind: 'p', inlines: [{ kind: 'text', text: 'para' }] },
      {
        kind: 'quote',
        inlines: [
          { kind: 'text', text: 'one ' },
          { kind: 'strong', text: 'x' },
          { kind: 'text', text: '\ntwo' },
        ],
      },
    ]);
    const joined = parseMarkdown('> `c` *e* [l](https://x.test)\n> more');
    expect(joined).toEqual([
      {
        kind: 'quote',
        inlines: [
          { kind: 'code', text: 'c' },
          { kind: 'text', text: ' ' },
          { kind: 'em', text: 'e' },
          { kind: 'text', text: ' ' },
          { kind: 'link', text: 'l', href: 'https://x.test' },
          { kind: 'text', text: '\nmore' },
        ],
      },
    ]);
  });
});

describe('parseInline', () => {
  it('reads code, bold, italic and http(s) links', () => {
    expect(parseInline('Use `ls`, **bold**, __also__, *it* and [docs](https://example.com/a).')).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'code', text: 'ls' },
      { kind: 'text', text: ', ' },
      { kind: 'strong', text: 'bold' },
      { kind: 'text', text: ', ' },
      { kind: 'strong', text: 'also' },
      { kind: 'text', text: ', ' },
      { kind: 'em', text: 'it' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'docs', href: 'https://example.com/a' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('leaves unclosed markers, other link schemes and lone stars as text', () => {
    expect(parseInline('half **open')).toEqual([{ kind: 'text', text: 'half **open' }]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[x](javascript:alert(1))' }]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
  });
});
