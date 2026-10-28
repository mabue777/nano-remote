// Unified diff parsing for the diff view (turn/diff, spec 7). Adapters hand over `diff` as text: a git
// style patch (`diff --git`, `---`/`+++` headers, `@@` hunks) or just the hunks. The view needs lines it
// can color, a +/- count per file, and the file's kind. turn/diff's kinds are add, modify, delete and
// rename; a host that sends only the first three still shows renames in the patch headers (`rename
// from`/`rename to`, or `---`/`+++` naming different paths), so they are read from there too.
import type { FileChangeKind, TurnDiffKind } from '../../../generated/common';

export type DiffLineKind = 'add' | 'remove' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading `+`, `-` or space (hunk and meta lines keep their text). */
  text: string;
  /** Line number in the old file (remove and context lines). */
  oldLine?: number;
  /** Line number in the new file (add and context lines). */
  newLine?: number;
}

export type FileKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The old path when the patch renames the file. */
  renamedFrom?: string;
  /** True when the patch says the file is binary (no lines to show). */
  binary: boolean;
  /**
   * Some lines carry no line numbers: an adapter's hunk without them (a bare `@@`) or its plain +/- lines.
   * The view shows them as the agent sent them.
   */
  unnumbered?: true;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** A hunk header without line numbers, as some adapters send it (`@@`, `@@ function name`). */
const BARE_HUNK = /^@@(?: |$)/;

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` stays as is. */
function stripPrefix(path: string): string {
  const clean = path.split('\t')[0]!.trim();
  return /^[ab]\//.test(clean) ? clean.slice(2) : clean;
}

/** Parses one file's unified diff. Unknown text before the first hunk is kept as meta lines. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const result: ParsedDiff = { lines: [], added: 0, removed: 0, binary: false };
  const source = diff.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (source === '') return result;
  let inHunk = false;
  /** False inside a hunk without line numbers. */
  let numbered = true;
  let oldLine = 0;
  let newLine = 0;
  let from: string | undefined;
  let to: string | undefined;
  for (const raw of source.split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk !== null) {
      inHunk = true;
      numbered = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      result.lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (BARE_HUNK.test(raw) && !raw.startsWith('@@ -')) {
      inHunk = true;
      numbered = false;
      result.unnumbered = true;
      if (raw.trim() !== '@@') result.lines.push({ kind: 'hunk', text: raw }); // a bare `@@` says nothing
      continue;
    }
    if (!inHunk || raw.startsWith('diff --git ')) {
      inHunk = false;
      if (raw.startsWith('rename from ')) from = raw.slice('rename from '.length);
      else if (raw.startsWith('rename to ')) to = raw.slice('rename to '.length);
      else if (raw.startsWith('--- ')) from ??= stripPrefix(raw.slice(4));
      else if (raw.startsWith('+++ ')) to ??= stripPrefix(raw.slice(4));
      else if (/^Binary files .* differ$/.test(raw) || raw === 'GIT binary patch') result.binary = true;
      // The `---`/`+++` pair is shown by the file header; other headers stay visible as meta lines.
      if (!raw.startsWith('--- ') && !raw.startsWith('+++ ')) result.lines.push({ kind: 'meta', text: raw });
      continue;
    }
    const line = hunkLine(raw, numbered ? { oldLine, newLine } : undefined);
    if (line.oldLine !== undefined) oldLine += 1;
    if (line.newLine !== undefined) newLine += 1;
    count(result, line);
  }
  if (from !== undefined && to !== undefined && from !== to && from !== '/dev/null' && to !== '/dev/null') result.renamedFrom = from;
  return result;
}

/** One line inside a hunk; `at` gives its line numbers, none in a hunk without them. */
function hunkLine(raw: string, at: { oldLine: number; newLine: number } | undefined): DiffLine {
  const sign = raw[0];
  const text = raw.slice(1);
  if (sign === '+') return at === undefined ? { kind: 'add', text } : { kind: 'add', text, newLine: at.newLine };
  if (sign === '-') return at === undefined ? { kind: 'remove', text } : { kind: 'remove', text, oldLine: at.oldLine };
  if (sign === '\\') return { kind: 'meta', text: raw }; // "\ No newline at end of file"
  // A space, or an empty line some tools emit for an empty context line.
  const context = sign === ' ' ? text : raw;
  return at === undefined ? { kind: 'context', text: context } : { kind: 'context', text: context, oldLine: at.oldLine, newLine: at.newLine };
}

function count(result: ParsedDiff, line: DiffLine): void {
  result.lines.push(line);
  if (line.kind === 'add') result.added += 1;
  else if (line.kind === 'remove') result.removed += 1;
}

/** Text that reads as a patch: a hunk header, a git header, or a `---`/`+++` pair. */
function looksLikePatch(lines: readonly string[]): boolean {
  return lines.some(
    (line, i) => line.startsWith('@@') || line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
  );
}

/**
 * The `diff` of a fileChange item (or approval) as the adapter sent it: usually a unified diff, read by
 * parseUnifiedDiff (hunks without line numbers allowed). Some engines send a new or deleted file's plain
 * content instead: every line is then added (or removed), numbered from 1. Plain lines of a changed file
 * are read by their +/- signs, without line numbers.
 */
export function parseAgentDiff(diff: string, kind: FileChangeKind): ParsedDiff {
  const source = diff.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = source === '' ? [] : source.split('\n');
  if (lines.length === 0 || looksLikePatch(lines)) return parseUnifiedDiff(diff);
  const result: ParsedDiff = { lines: [], added: 0, removed: 0, binary: false };
  lines.forEach((text, i) => {
    if (kind === 'add') count(result, { kind: 'add', text, newLine: i + 1 });
    else if (kind === 'delete') count(result, { kind: 'remove', text, oldLine: i + 1 });
    else count(result, hunkLine(text, undefined));
  });
  if (kind === 'modify') result.unnumbered = true;
  return result;
}

/** The file's kind for the header: a patch that renames wins over the protocol's `modify`. */
export function fileKind(kind: TurnDiffKind, parsed: Pick<ParsedDiff, 'renamedFrom'>): FileKind {
  if (kind === 'add') return 'added';
  if (kind === 'delete') return 'deleted';
  if (kind === 'rename') return 'renamed';
  return parsed.renamedFrom !== undefined ? 'renamed' : 'modified';
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};
