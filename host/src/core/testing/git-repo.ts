// A throwaway git repository for the Changes tests (git-changes, turn-changes, the adapters' e2e tests).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The host's environment without GIT_* variables, so the user's git setup cannot leak into a test. */
function env(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) out[key] = value;
  return out;
}

const IDENTITY = ['-c', 'user.name=Nano Test', '-c', 'user.email=test@nano.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export interface TestRepo {
  /** The work tree root (real path). */
  root: string;
  /** Runs git in the root (or `cwd`) and returns stdout. */
  git(args: string[], cwd?: string): string;
  /** Writes a file relative to the root, creating folders. */
  write(file: string, content: string | Buffer): void;
  /** Commits everything with this message. */
  commit(message: string): void;
  remove(): void;
}

export function makeRepo(files: Record<string, string | Buffer> = {}): TestRepo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nano-repo-')));
  const git = (args: string[], cwd = root) => execFileSync('git', [...IDENTITY, ...args], { cwd, env: env(), encoding: 'utf8' });
  const write = (file: string, content: string | Buffer) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  git(['init', '-q', '-b', 'main']);
  for (const [file, content] of Object.entries(files)) write(file, content);
  return {
    root,
    git,
    write,
    commit(message) {
      git(['add', '-A']);
      git(['commit', '-q', '--allow-empty', '-m', message]);
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
