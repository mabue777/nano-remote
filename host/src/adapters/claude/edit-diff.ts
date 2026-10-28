// The unified diff of a Claude file tool call (Edit, MultiEdit, Write), computed before the tool runs: the
// file as it is now against the file as the call leaves it, with real line numbers and 3 lines of context.
// The adapter reads the file when the tool_use block arrives and when canUseTool asks, both before the
// tool writes. When the file cannot be read (missing, not a file, over 1 MB) or the call's old_string is not
// in it (the tool ran already, or will fail), the caller keeps the plain hunk it built from the call alone.
// Diff text is cut at a line end at 64 KiB, the per-file cap of turn/diff (spec 7). Like the hunks the
// adapter builds from the call alone, the text has no file headers and no final newline.
import { readFileSync, statSync } from 'node:fs';

/** Files larger than this are not read; the call's own text is used. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** The diff text of one file is cut here, at a line end (spec 7's per-file cap). */
export const MAX_DIFF_BYTES = 65_536;
const CONTEXT = 3;
/** Edit distance above which the changed middle is shown as one removed and one added block. */
const MAX_EDITS = 500;

type Op = '=' | '-' | '+';

/** The file's text, `missing` when there is no such path, undefined when it cannot or should not be read. */
export function readCurrent(file: string): string | 'missing' | undefined {
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat === undefined) return 'missing';
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function lines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** Myers' shortest edit script between two line lists, or undefined when it needs more than MAX_EDITS edits. */
function myers(a: readonly string[], b: readonly string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return undefined;
}

function backtrack(trace: readonly Int32Array[], offset: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push('+');
        y--;
      } else {
        ops.push('-');
        x--;
      }
    }
  }
  return ops.reverse();
}

/** The edit script: common head and tail, then Myers on the middle (one block replace past MAX_EDITS). */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(head, endA);
  const midB = b.slice(head, endB);
  const middle = myers(midA, midB) ?? [...midA.map((): Op => '-'), ...midB.map((): Op => '+')];
  return [...Array<Op>(head).fill('='), ...middle, ...Array<Op>(a.length - endA).fill('=')];
}

/** Cuts diff text at a line end so it stays within MAX_DIFF_BYTES. */
export function capDiff(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_DIFF_BYTES) return text;
  const cut = bytes.subarray(0, MAX_DIFF_BYTES).toString('utf8');
  const end = cut.lastIndexOf('\n');
  return end < 0 ? '' : cut.slice(0, end);
}

/** `@@` start: the first line of the range, or the line before an empty range (unified diff's rule). */
const start = (before: number, length: number): number => (length === 0 ? before : before + 1);

/** The unified diff hunks (no file headers) from oldText to newText with 3 lines of context; '' when equal. */
export function unifiedDiff(oldText: string, newText: string): string {
  const a = lines(oldText);
  const b = lines(newText);
  const ops = editScript(a, b);
  // Line numbers before every op: oldAt[i] old lines and newAt[i] new lines precede op i.
  const oldAt: number[] = [0];
  const newAt: number[] = [0];
  ops.forEach((op, i) => {
    oldAt.push(oldAt[i]! + (op === '+' ? 0 : 1));
    newAt.push(newAt[i]! + (op === '-' ? 0 : 1));
  });
  const changes = ops.flatMap((op, i) => (op === '=' ? [] : [i]));
  if (changes.length === 0) return '';
  // Group changes whose context would touch or overlap into one hunk.
  const groups: [number, number][] = [];
  for (const i of changes) {
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(ops.length, i + CONTEXT + 1);
    const last = groups[groups.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = to;
    else groups.push([from, to]);
  }
  const out: string[] = [];
  for (const [from, to] of groups) {
    const oldLength = oldAt[to]! - oldAt[from]!;
    const newLength = newAt[to]! - newAt[from]!;
    out.push(`@@ -${start(oldAt[from]!, oldLength)},${oldLength} +${start(newAt[from]!, newLength)},${newLength} @@`);
    for (let i = from; i < to; i++) {
      const op = ops[i]!;
      if (op === '+') out.push(`+${b[newAt[i]!]!}`);
      else out.push(`${op === '-' ? '-' : ' '}${a[oldAt[i]!]!}`);
    }
  }
  return capDiff(out.join('\n'));
}

/** A new file's diff: every line added. */
export function addedDiff(content: string): string {
  const added = lines(content);
  if (added.length === 0) return '';
  return capDiff(`@@ -0,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join('\n')}`);
}

export interface Replacement {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** The text after the replacements in order; undefined when an old string is empty or not found. */
export function applyEdits(text: string, edits: readonly Replacement[]): string | undefined {
  let current = text;
  for (const edit of edits) {
    if (edit.oldString === '') return undefined;
    const at = current.indexOf(edit.oldString);
    if (at < 0) return undefined;
    current = edit.replaceAll
      ? current.split(edit.oldString).join(edit.newString)
      : current.slice(0, at) + edit.newString + current.slice(at + edit.oldString.length);
  }
  return current;
}
