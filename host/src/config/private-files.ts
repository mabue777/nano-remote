// Owner-only files and folders (security pass, docs/security/host-v0-pass.md item 5). Everything the host
// keeps on disk that a local attacker could use (config, Journal, device hashes, control secret, VAPID
// key, TLS key) is 0600, and the NanoHost folder that holds them is 0700.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Creates the folder 0700 (and tightens it if it already exists). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(dir, PRIVATE_DIR_MODE);
}

/**
 * Makes sure `file` exists with mode 0600 before anyone else creates it (SQLite would create it 0644).
 * Missing parent folders are created 0700; existing ones are left alone, because the Journal may live
 * in a folder the user chose. An existing file is tightened.
 */
export function ensurePrivateFile(file: string): void {
  const parent = path.dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
  closeSync(openSync(file, 'a', PRIVATE_FILE_MODE));
  chmodSync(file, PRIVATE_FILE_MODE);
}

/** Tightens SQLite's side files (`-wal`, `-shm`) of `file` when they exist. */
export function tightenSqliteSideFiles(file: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const side = `${file}${suffix}`;
    if (existsSync(side)) chmodSync(side, PRIVATE_FILE_MODE);
  }
}
