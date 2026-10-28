// The scope rule of every file read (protocol-v1.md section 4.1): a requested path is resolved with
// `realpath` and must land inside the `realpath` of the session folder. `..`, absolute paths elsewhere and
// symlinks that point out of the folder all end the same way: `not_found`, with nothing in the answer that
// says whether or what exists outside.
//
// What is left open, on purpose: between the check and the read a process on the Mac could swap a folder
// inside the session for a symlink. Only the agent (or the user) writes there, and the agent can already
// read any file the host user can, so this adds no reach; the final component is still opened with
// O_NOFOLLOW so a swapped file link is refused.
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { RpcError } from '../errors.js';

/** A path inside a session folder, resolved. */
export interface ScopedPath {
  /** `realpath` of the session folder. */
  root: string;
  /** `realpath` of the requested path; inside `root` or equal to it. */
  real: string;
  /** `real` relative to `root`, '/'-separated; '' for the folder itself. */
  relative: string;
}

/** The one answer for "outside the folder", "missing" and "unreadable": no hint of which. */
export function outOfScope(requested: string): RpcError {
  return new RpcError('not_found', 'no such file or folder in the session folder', { path: requested });
}

/** True when `real` is `root` or below it. Both must already be `realpath` results. */
export function isInside(root: string, real: string): boolean {
  if (real === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return real.startsWith(prefix);
}

/** `realpath`, or undefined when the path does not resolve (missing, a loop, no permission). */
async function resolveReal(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EACCES' || code === 'EPERM' || code === 'ENAMETOOLONG') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves `requested` against the session folder `cwd`. A relative path is taken from the folder; an
 * absolute one is accepted only when it resolves inside it. '' and '.' name the folder itself.
 * `invalid_params` (`data.path` = `paramPath`) for a path with a NUL byte; `not_found` for everything that
 * does not resolve inside the folder, including a session folder that no longer exists.
 */
export async function resolveInSession(cwd: string, requested: string, paramPath = 'params.path'): Promise<ScopedPath> {
  if (requested.includes('\0')) throw RpcError.invalidParams(paramPath, 'path must not contain NUL');
  if (cwd === '' || !path.isAbsolute(cwd)) throw outOfScope(requested);
  const root = await resolveReal(cwd);
  if (root === undefined) throw outOfScope(requested);
  const candidate = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested === '' ? '.' : requested);
  const real = await resolveReal(candidate);
  if (real === undefined || !isInside(root, real)) throw outOfScope(requested);
  return { root, real, relative: path.relative(root, real).split(path.sep).join('/') };
}
