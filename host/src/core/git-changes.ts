// Git plumbing for the Changes view (protocol-v1.md section 7, `turn/diff`). The host records the session
// folder's working tree as a git tree object when a turn starts and when it ends, and diffs the two trees.
//
// A snapshot must never touch the user's index, stash, refs or files: it copies the index to a temporary
// file, stages everything with `GIT_INDEX_FILE` pointing at the copy (`git add -A -- .`, so .gitignore
// holds and ignored files stay out), writes the tree, and deletes the copy. Starting from a copy of the
// real index (instead of an empty one) keeps git's stat cache, so unchanged files are not hashed again.
// Only the object store gains objects; nothing references them.
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TurnDiffFile, TurnDiffKind } from '../generated/common.js';

/** Most diff text per file, in bytes (spec 7). */
export const MAX_FILE_DIFF_BYTES = 65_536;
/** Most diff text of one turn/diff result, in bytes (spec 7). */
export const MAX_TOTAL_DIFF_BYTES = 524_288;
/** Most files one turn/diff result lists (spec 7); `omittedFiles` counts the rest. */
export const MAX_DIFF_FILES = 500;
/** Per-file diffs computed at once. */
const PARALLEL = 8;
/** Ceiling for git output read whole (the file list); far above any real listing. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

export interface TreeDiff {
  files: TurnDiffFile[];
  truncated?: true;
  omittedFiles?: number;
}

export interface DiffLimits {
  fileBytes: number;
  totalBytes: number;
  files: number;
}

export const DEFAULT_LIMITS: DiffLimits = {
  fileBytes: MAX_FILE_DIFF_BYTES,
  totalBytes: MAX_TOTAL_DIFF_BYTES,
  files: MAX_DIFF_FILES,
};

/**
 * The environment git runs with: the host's, without any GIT_* variable that could point git at another
 * repository, index or work tree, and with optional locks off so a snapshot never blocks the user's git.
 */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...extra };
}

/** Options that make git's output independent of the user's configuration. */
const CONFIG = ['-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'color.ui=false'];
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--relative'];

/** Runs git in `cwd` and returns its stdout; rejects on a non-zero exit. */
function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...CONFIG, ...args], { cwd, env: gitEnv(env), maxBuffer: MAX_LISTING_BYTES }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} failed in ${cwd}: ${String(stderr).trim() || error.message}`));
      else resolve(String(stdout));
    });
  });
}

/** True when `cwd` is inside a git work tree (false too when git is not installed or `cwd` is gone). */
export async function isWorkTree(cwd: string): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true';
  } catch {
    return false;
  }
}

/** Records the working tree under `cwd` as a tree object and returns its id. The user's index is only read. */
export async function snapshotTree(cwd: string): Promise<string> {
  const index = path.resolve(cwd, (await git(['rev-parse', '--git-path', 'index'], cwd)).trim());
  const dir = await mkdtemp(path.join(tmpdir(), 'nano-snapshot-'));
  const scratch = path.join(dir, 'index');
  try {
    try {
      await copyFile(index, scratch);
    } catch (error) {
      // A repository without a single `git add` has no index yet: start from an empty one.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const env = { GIT_INDEX_FILE: scratch };
    await git(['add', '-A', '--', '.'], cwd, env);
    return (await git(['write-tree'], cwd, env)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The tree of HEAD, or the empty tree before the first commit. */
export async function headTree(cwd: string): Promise<string> {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], cwd)).trim();
  } catch {
    return (await git(['hash-object', '-t', 'tree', '/dev/null'], cwd)).trim();
  }
}

interface Entry {
  path: string;
  oldPath?: string;
  kind: TurnDiffKind;
}

/** Parses `git diff --name-status -z`: a status, then one path (two for renames and copies). */
export function parseNameStatus(raw: string): Entry[] {
  const tokens = raw.split('\0');
  const entries: Entry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++]!;
    if (status === '') continue;
    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i++]!;
      const newPath = tokens[i++]!;
      entries.push(letter === 'R' ? { path: newPath, oldPath, kind: 'rename' } : { path: newPath, kind: 'add' });
    } else {
      const file = tokens[i++]!;
      entries.push({ path: file, kind: letter === 'A' ? 'add' : letter === 'D' ? 'delete' : 'modify' });
    }
  }
  return entries;
}

/** Up to `cap` bytes of a command's stdout; the command is stopped once it wrote more. */
function capturedGit(args: string[], cwd: string, cap: number): Promise<{ text: string; cut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...CONFIG, ...args], { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      if (cut) return;
      chunks.push(data);
      size += data.length;
      if (size > cap) {
        cut = true;
        child.kill();
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!cut && code !== 0) {
        reject(new Error(`git ${args[0]} failed in ${cwd}: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const all = Buffer.concat(chunks);
      resolve(cut ? { text: cutAtLine(all, cap), cut } : { text: all.toString('utf8'), cut });
    });
  });
}

/** The first `cap` bytes, ending at the last complete line (never inside a UTF-8 character). */
function cutAtLine(data: Buffer, cap: number): string {
  if (data.length <= cap) return data.toString('utf8');
  if (cap <= 0) return '';
  const end = data.lastIndexOf(0x0a, cap - 1);
  return end < 0 ? '' : data.subarray(0, end + 1).toString('utf8');
}

const BINARY = /^Binary files .* differ$/m;

/** One file's patch between the trees (both paths for a rename), at most `cap` bytes. */
async function filePatch(cwd: string, from: string, to: string, entry: Entry, cap: number): Promise<{ text: string; cut: boolean }> {
  const paths = entry.oldPath !== undefined ? [entry.oldPath, entry.path] : [entry.path];
  const args = ['diff', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', from, to, '--', ...paths.map((p) => `:(literal)${p}`)];
  return capturedGit(args, cwd, cap);
}

/**
 * The net change between two trees, limited to the folder `cwd` (paths relative to it): one entry per file
 * with its kind and unified diff text, binary files without text, cut at `limits` (spec 7).
 */
export async function diffTrees(cwd: string, from: string, to: string, limits: DiffLimits = DEFAULT_LIMITS): Promise<TreeDiff> {
  const all = parseNameStatus(await git(['diff', ...DIFF_FLAGS, '--name-status', '-z', from, to, '--'], cwd));
  const entries = all.slice(0, limits.files);
  const files: TurnDiffFile[] = [];
  let used = 0;
  let truncated = all.length > entries.length;
  for (let start = 0; start < entries.length; start += PARALLEL) {
    const batch = entries.slice(start, start + PARALLEL);
    const patches = await Promise.all(
      batch.map((entry) => (used >= limits.totalBytes ? undefined : filePatch(cwd, from, to, entry, limits.fileBytes))),
    );
    batch.forEach((entry, i) => {
      const file: TurnDiffFile = { path: entry.path, kind: entry.kind, diff: '' };
      if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
      const patch = patches[i];
      if (patch === undefined) {
        file.truncated = true;
      } else if (!patch.cut && BINARY.test(patch.text.split('\n@@')[0]!)) {
        file.binary = true;
      } else {
        const room = limits.totalBytes - used;
        const bytes = Buffer.byteLength(patch.text);
        file.diff = bytes <= room ? patch.text : cutAtLine(Buffer.from(patch.text), room);
        if (patch.cut || bytes > room) file.truncated = true;
        used += Buffer.byteLength(file.diff);
        if (bytes > room) used = limits.totalBytes;
      }
      if (file.truncated) truncated = true;
      files.push(file);
    });
  }
  const result: TreeDiff = { files };
  if (truncated) result.truncated = true;
  if (all.length > entries.length) result.omittedFiles = all.length - entries.length;
  return result;
}
