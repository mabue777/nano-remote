// Unified diff parsing for the diff view (turn/diff, spec 7). Adapters hand over `diff` as text: a git
// style patch (`diff --git`, `---`/`+++` headers, `@@` hunks) or just the hunks. The view needs lines it
// can color, a +/- count per file, and the file's kind. The protocol's kinds are add, modify and delete;
// a rename shows only in the patch headers (`rename from`/`rename to`, or `---`/`+++` naming different
// paths), so it is read from there.
import type { FileChangeKind } from '../../../generated/common';

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
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
  let oldLine = 0;
  let newLine = 0;
  let from: string | undefined;
  let to: string | undefined;
  for (const raw of source.split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      result.lines.push({ kind: 'hunk', text: raw });
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
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') {
      result.lines.push({ kind: 'add', text, newLine: newLine++ });
      result.added += 1;
    } else if (sign === '-') {
      result.lines.push({ kind: 'remove', text, oldLine: oldLine++ });
      result.removed += 1;
    } else if (sign === '\\') {
      result.lines.push({ kind: 'meta', text: raw }); // "\ No newline at end of file"
    } else {
      // A space, or an empty line some tools emit for an empty context line.
      result.lines.push({ kind: 'context', text: sign === ' ' ? text : raw, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  if (from !== undefined && to !== undefined && from !== to && from !== '/dev/null' && to !== '/dev/null') result.renamedFrom = from;
  return result;
}

/** The file's kind for the header: a patch that renames wins over the protocol's `modify`. */
export function fileKind(kind: FileChangeKind, parsed: Pick<ParsedDiff, 'renamedFrom'>): FileKind {
  if (kind === 'add') return 'added';
  if (kind === 'delete') return 'deleted';
  return parsed.renamedFrom !== undefined ? 'renamed' : 'modified';
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};
