// Structured logging for the host service: one JSON line per event, written to stdout and appended to
// the log file. Secrets never reach a line: fields whose names say token, code, cookie, secret,
// password or authorization are replaced with "[redacted]", at any depth, before serializing.
//
//   {"ts":"2026-10-20T18:00:00.000Z","level":"info","event":"host.start","pid":123,"version":"0.0.0"}
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/** Field names that may carry credentials. Security-pass seam. */
export const REDACTED_FIELD = /token|code|cookie|secret|password|authorization|credential/i;

/** Field names that look secret but carry none: close codes, HTTP status codes, error codes. */
const SAFE_FIELDS: ReadonlySet<string> = new Set(['closeCode', 'statusCode', 'errorCode', 'exitCode']);

/** A copy of `value` with every secret-named field replaced. Errors become `{name, message}`. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (value instanceof Error) {
    const out: LogFields = { name: value.name, message: value.message };
    const code = (value as NodeJS.ErrnoException).code;
    if (typeof code === 'string') out.errorCode = code;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: LogFields = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = REDACTED_FIELD.test(key) && !SAFE_FIELDS.has(key) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** One log line, without the trailing newline. */
export function formatLine(level: LogLevel, event: string, fields: LogFields = {}, now = new Date()): string {
  const safe = redact(fields) as LogFields;
  return JSON.stringify({ ts: now.toISOString(), level, event, ...safe });
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Adapter for the host modules' `(message, error?) => void` log option. */
  forModule(module: string): (message: string, error?: unknown) => void;
}

export interface LoggerOptions {
  /** Appended to; its folder is created. Omit for stdout only. */
  file?: string;
  /** Default: process.stdout. */
  stdout?: { write(text: string): unknown };
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const stdout = options.stdout ?? process.stdout;
  const now = options.now ?? (() => new Date());
  if (options.file) mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
  let fileReady = false;
  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    const line = `${formatLine(level, event, fields, now())}\n`;
    stdout.write(line);
    if (!options.file) return;
    try {
      appendFileSync(options.file, line, { mode: 0o600 });
      if (!fileReady) {
        chmodSync(options.file, 0o600);
        fileReady = true;
      }
    } catch {
      // A full disk or a removed folder must not take the host down; stdout still has the line.
    }
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    forModule: (module) => (message, error) =>
      write(error === undefined ? 'info' : 'error', `${module}.log`, error === undefined ? { message } : { message, error }),
  };
}
