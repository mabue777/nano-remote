import { describe, expect, it } from 'vitest';

import { highlight } from './syntax';

describe('syntax highlight', () => {
  it('tokenizes TypeScript into the six roles', () => {
    const result = highlight("import { readFileSync } from 'node:fs';\nconst x = 42; // answer\nfunction parse(input: string) {\n  return input.length;\n}", 'typescript');
    expect(result).toBeDefined();
    const lines = result!;
    expect(lines.length).toBe(5);

    // Line 0: import { readFileSync } from 'node:fs';
    const line0 = lines[0]!.tokens;
    expect(line0[0]).toMatchObject({ text: 'import', role: 'keyword' });
    expect(line0.find((t) => t.text === "'node:fs'" && t.role === 'string')).toBeDefined();

    // Line 1: const x = 42; // answer
    const line1 = lines[1]!.tokens;
    expect(line1.find((t) => t.text === 'const')?.role).toBe('keyword');
    expect(line1.find((t) => t.text === '42')?.role).toBe('number');
    expect(line1.find((t) => t.text === '// answer')?.role).toBe('comment');

    // Line 2: function parse(input: string) {
    const line2 = lines[2]!.tokens;
    expect(line2.find((t) => t.text === 'function')?.role).toBe('keyword');
    expect(line2.find((t) => t.text === 'parse')?.role).toBe('function');
    expect(line2.find((t) => t.text === 'string')?.role).toBe('variable');

    // Line 3: return input.length;
    const line3 = lines[3]!.tokens;
    expect(line3.find((t) => t.text === 'return')?.role).toBe('keyword');
  });

  it('splits multi-line tokens across lines', () => {
    const result = highlight('/* first\nsecond */\nconst y = 1;', 'typescript');
    expect(result).toBeDefined();
    const lines = result!;
    expect(lines.length).toBe(3);
    expect(lines[0]!.tokens.some((t) => t.text === '/* first' && t.role === 'comment')).toBe(true);
    expect(lines[1]!.tokens.some((t) => t.text === 'second */' && t.role === 'comment')).toBe(true);
  });

  it('returns an empty array for empty input', () => {
    expect(highlight('', 'typescript')).toEqual([]);
  });

  it('returns undefined for an unknown language', () => {
    expect(highlight('a', 'not-a-language')).toBeUndefined();
  });

  it('keeps punctuation in the text colour (no role)', () => {
    const result = highlight('const a = 1;', 'typescript');
    expect(result).toBeDefined();
    const all = result![0]!.tokens;
    expect(all.some((t) => t.text === '=' && t.role === undefined)).toBe(true);
    expect(all.some((t) => t.text === ';' && t.role === undefined)).toBe(true);
  });

  it('handles JSON, CSS, markup, markdown, bash, python, yaml and diff', () => {
    expect(highlight('{"a": 1}', 'json')).toBeDefined();
    expect(highlight('.x { color: red; }', 'css')).toBeDefined();
    expect(highlight('<div class="a">', 'markup')).toBeDefined();
    expect(highlight('# Heading\n\ntext', 'markdown')).toBeDefined();
    expect(highlight('echo hello', 'bash')).toBeDefined();
    expect(highlight('def f():\n    pass', 'python')).toBeDefined();
    expect(highlight('key: value', 'yaml')).toBeDefined();
    expect(highlight('+ added\n- removed', 'diff')).toBeDefined();
  });
});
