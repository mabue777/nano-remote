// Params checks for the core's methods. Each throws `invalid_params` with `data.path` (spec 10) naming the
// offending field, so handlers can read typed values in one line. Unknown fields are ignored (spec 3).
import type { Decision, InputPart, Settings } from '../generated/common.js';
import { RpcError } from '../errors.js';

type Params = Record<string, unknown>;

const DECISIONS: readonly Decision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

function bad(key: string, message: string): RpcError {
  return RpcError.invalidParams(`params.${key}`, message);
}

export function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') throw bad(key, `${key} must be a non-empty string`);
  return value;
}

export function optStr(params: Params, key: string): string | undefined {
  return params[key] === undefined ? undefined : str(params, key);
}

/** A non-negative integer (cursors) or, with `min: 1`, a positive one (limits, turn counts). */
export function optInt(params: Params, key: string, min = 0): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw bad(key, `${key} must be an integer >= ${min}`);
  }
  return value;
}

export function int(params: Params, key: string): number {
  const value = optInt(params, key);
  if (value === undefined) throw bad(key, `${key} is required`);
  return value;
}

export function optBool(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw bad(key, `${key} must be a boolean`);
  return value;
}

export function optSettings(params: Params, key: string): Settings | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad(key, `${key} must be an object`);
  return value as Settings;
}

/** A non-empty list of InputParts (spec 5.1): text, image or mention. */
export function input(params: Params, key: string): InputPart[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) throw bad(key, `${key} must be a non-empty array of input parts`);
  value.forEach((part: unknown, index) => {
    const at = `${key}.${index}`;
    if (typeof part !== 'object' || part === null) throw bad(at, 'input part must be an object');
    const p = part as Params;
    if (p.type === 'text' && typeof p.text === 'string') return;
    if (p.type === 'image' && typeof p.url === 'string') return;
    if (p.type === 'mention' && typeof p.name === 'string' && typeof p.path === 'string') return;
    throw bad(at, 'input part must be {type:"text", text}, {type:"image", url} or {type:"mention", name, path}');
  });
  return value as InputPart[];
}

export function optInput(params: Params, key: string): InputPart[] | undefined {
  return params[key] === undefined ? undefined : input(params, key);
}

export function decision(params: Params, key: string): Decision {
  const value = params[key];
  if (!DECISIONS.includes(value as Decision)) throw bad(key, `${key} must be one of ${DECISIONS.join(', ')}`);
  return value as Decision;
}

/** `{<questionId>: [string]}` (spec 5.3). */
export function answers(params: Params, key: string): Record<string, string[]> {
  const value = params[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad(key, `${key} must be an object`);
  for (const [question, list] of Object.entries(value)) {
    if (!Array.isArray(list) || !list.every((answer) => typeof answer === 'string')) {
      throw bad(`${key}.${question}`, 'answers must be arrays of strings');
    }
  }
  return value as Record<string, string[]>;
}
