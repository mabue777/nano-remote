// Syntax colouring for the file viewer (docs/plan/file-viewer.md item P5): Prism core + TS/JS/JSON/CSS/HTML/
// Markdown/Bash/Python/YAML/diff as a lazy chunk, rendered into Preact nodes, never innerHTML.
//
// The module is imported dynamically by FileViewer.tsx only for small code/markdown files, so the main
// bundle and the first file-viewer chunk carry none of Prism. Exported token roles are limited to the six
// colour tokens in tokens.css; everything else (punctuation, operators, etc.) keeps the text colour.
import Prism from 'prismjs/components/prism-core.js';

Prism.manual = true;

import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-diff.js';

export type CodeRole = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'variable';

export interface CodeToken {
  text: string;
  role?: CodeRole;
  /** Position of this token's text within its line, in characters. */
  start: number;
  end: number;
}

export interface CodeLine {
  tokens: CodeToken[];
}

/** Maps Prism token types (and aliases) to the six colour roles in tokens.css. */
const ROLE_MAP: Readonly<Record<string, CodeRole>> = {
  keyword: 'keyword',
  'template-string': 'string',
  string: 'string',
  regex: 'string',
  comment: 'comment',
  number: 'number',
  constant: 'number',
  boolean: 'number',
  char: 'number',
  builtin: 'variable',
  function: 'function',
  'class-name': 'function',
  tag: 'function',
  'attr-name': 'variable',
  variable: 'variable',
  property: 'variable',
  selector: 'variable',
};

function roleOf(type: string): CodeRole | undefined {
  return ROLE_MAP[type];
}

function tokenRole(token: Prism.Token): CodeRole | undefined {
  const fromType = roleOf(token.type);
  if (fromType !== undefined) return fromType;
  if (Array.isArray(token.alias)) {
    for (const a of token.alias) {
      const r = roleOf(a);
      if (r !== undefined) return r;
    }
  } else if (typeof token.alias === 'string') {
    return roleOf(token.alias);
  }
  return undefined;
}

interface Piece {
  text: string;
  role?: CodeRole;
}

function flatten(stream: Prism.TokenStream, inheritedRole?: CodeRole): Piece[] {
  const out: Piece[] = [];
  if (typeof stream === 'string') {
    out.push({ text: stream, role: inheritedRole });
  } else if (stream instanceof Prism.Token) {
    const role = tokenRole(stream) ?? inheritedRole;
    out.push(...flatten(stream.content, role));
  } else {
    for (const item of stream) out.push(...flatten(item, inheritedRole));
  }
  return out;
}

/**
 * Tokenize `text` with Prism into lines of role-tagged tokens. Returns `undefined` when the language is
 * not loaded. Empty input yields an empty array. The returned lines match `splitLines(text)`: a trailing
 * newline does not create an empty line.
 */
export function highlight(text: string, language: string): CodeLine[] | undefined {
  if (text === '') return [];
  const grammar = Prism.languages[language];
  if (grammar === undefined) return undefined;
  const stream = Prism.tokenize(text, grammar);
  const pieces = flatten(stream);

  const lines: CodeLine[] = [{ tokens: [] }];
  let linePos = 0;
  for (const piece of pieces) {
    const parts = piece.text.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        lines.push({ tokens: [] });
        linePos = 0;
      }
      const part = parts[i];
      if (part === undefined || part === '') continue;
      const end = linePos + part.length;
      lines[lines.length - 1]!.tokens.push({ text: part, role: piece.role, start: linePos, end });
      linePos = end;
    }
  }
  // Match splitLines: a final newline does not start an empty line.
  if (text.endsWith('\n') && lines.length > 0 && lines[lines.length - 1]!.tokens.length === 0) {
    lines.pop();
  }
  return lines;
}
