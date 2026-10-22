// Throwaway spike. Same step-log format as spikes/host-drive/logs: one timestamped line per step,
// plus a git-ignored *.trace.jsonl with the raw wire traffic.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOG_DIR = join(SPIKE_DIR, "logs");
export const KIMI_BIN = "/Users/mabue/.kimi-code/bin/kimi";
export const WORK_ROOT = "/tmp/nano-kimi-drive";

export function now(): string {
  return new Date().toISOString();
}

export class StepLog {
  private path: string;
  private n = 0;
  constructor(name: string) {
    mkdirSync(LOG_DIR, { recursive: true });
    this.path = join(LOG_DIR, `${name}.log`);
    writeFileSync(this.path, "");
  }
  step(name: string, detail: string): void {
    this.n += 1;
    const line = `${now()}  ${this.n}. ${name}  ${detail}`;
    appendFileSync(this.path, line + "\n");
    console.log(line);
  }
}

export class Trace {
  private path: string;
  constructor(name: string) {
    mkdirSync(LOG_DIR, { recursive: true });
    this.path = join(LOG_DIR, `${name}.trace.jsonl`);
    writeFileSync(this.path, "");
  }
  write(dir: string, msg: unknown): void {
    appendFileSync(this.path, JSON.stringify({ t: now(), dir, msg }) + "\n");
  }
}

/** A fresh working directory for the agent. */
export function freshDir(name: string): string {
  const dir = join(WORK_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * An isolated KIMI_CODE_HOME whose only provider is the local fake model. The operator's
 * ~/.kimi-code (config, OAuth login, sessions) is never read or written by fake-model runs.
 */
export function fakeHome(name: string, modelUrl: string, extraToml = ""): string {
  const home = freshDir(`${name}-home`);
  writeFileSync(
    join(home, "config.toml"),
    [
      `default_model = "fake/fake-coder"`,
      ``,
      `[providers.fake]`,
      `type = "openai"`,
      `base_url = "${modelUrl}"`,
      `api_key = "not-a-secret"`,
      ``,
      `[models."fake/fake-coder"]`,
      `provider = "fake"`,
      `model = "fake-coder"`,
      `max_context_size = 131072`,
      ``,
      extraToml,
    ].join("\n"),
  );
  return home;
}
