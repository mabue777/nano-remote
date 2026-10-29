// Path linkification for agent messages (docs/plan/file-viewer.md item P4): turn tokens that look like relative
// file paths into links to the file viewer. A token is linkified only when it has no spaces, is relative, and
// either contains a '/' and ends in an extension, or ends in a known extension; a trailing ':42' (or ':42:3') is
// the line. Quotes, backticks, brackets and sentence punctuation around the token stay plain text.
import { routePath } from '../../../routes/router';

/** Common code and text extensions; an unknown extension like 'g' in 'e.g.' does not count. */
const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'md', 'markdown', 'mdx', 'mdown', 'txt', 'text', 'log', 'csv', 'tsv', 'rst', 'adoc',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'fish', 'yaml', 'yml', 'toml', 'ini', 'sql',
  'dockerfile', 'gitignore', 'env', 'conf', 'config', 'properties', 'gradle', 'lock', 'patch', 'diff',
]);

/** A plain-text piece or a tappable path. */
export interface LinkSegment {
  text: string;
  path?: string;
  line?: number;
}

/** The file-viewer route for a session path, with an optional line number. */
export function fileHref(sessionId: string, path: string, line?: number): string {
  return routePath({ name: 'file', sessionId, path, ...(line !== undefined ? { line } : {}) });
}

/** Split plain text into plain spans and path links. */
export function linkifyPaths(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  const regex = /(\s+|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const piece = match[1]!;
    if (/^\s+$/.test(piece)) {
      appendText(out, piece);
      continue;
    }
    const link = pathLinkOf(piece);
    if (link === undefined) {
      appendText(out, piece);
      continue;
    }
    if (link.before !== '') appendText(out, link.before);
    out.push({ text: link.core, path: link.path, line: link.line });
    if (link.after !== '') appendText(out, link.after);
  }
  return out;
}

function appendText(segments: LinkSegment[], text: string): void {
  const last = segments[segments.length - 1];
  if (last?.path === undefined) {
    if (last !== undefined) last.text += text;
    else segments.push({ text });
  } else {
    segments.push({ text });
  }
}

interface ParsedLink {
  before: string;
  core: string;
  after: string;
  path: string;
  line?: number;
}

function pathLinkOf(token: string): ParsedLink | undefined {
  const leading = /^['"`({\[<]+/.exec(token)?.[0] ?? '';
  const rest = token.slice(leading.length);
  const trailing = /['"`)}>\].,;:!?]+$/.exec(rest)?.[0] ?? '';
  const core = rest.slice(0, rest.length - trailing.length);
  if (core === '') return undefined;

  // Only relative paths: no URLs, no absolute or home paths.
  if (core.includes('://') || core.startsWith('/') || core.startsWith('~')) return undefined;

  // A trailing ':digits' (and optional ':digits' column) is a line/column reference.
  let path = core;
  let line: number | undefined;
  const lineMatch = /:(\d+)(?::\d+)?$/.exec(core);
  if (lineMatch !== null) {
    line = Number(lineMatch[1]);
    path = core.slice(0, lineMatch.index);
  }

  // Path characters only: a colon that is not a line number, quotes or brackets make the token prose.
  if (!/^[\w.@+\-/]+$/.test(path) || path.endsWith('/')) return undefined;

  // It must end in an extension: any short one after a '/', a known one for a bare name ('e.g.' has neither).
  const extension = extensionOf(path.slice(path.lastIndexOf('/') + 1));
  if (path.includes('/')) {
    if (!/^[a-z0-9]{1,10}$/i.test(extension) || /^\d+$/.test(extension)) return undefined;
  } else if (!KNOWN_EXTENSIONS.has(extension)) {
    return undefined;
  }

  return { before: leading, core, after: trailing, path, ...(line !== undefined && line > 0 ? { line } : {}) };
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot > 0 ? path.slice(dot + 1).toLowerCase() : '';
}
