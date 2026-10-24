// Pure translations between pi's RPC shapes (pi docs/rpc-commands.md, json.md, message-types.md,
// rpc-extension-ui.md) and the protocol vocabulary of protocol-v1.md section 5. This file and adapter.ts
// are the only places that know pi's names.
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { AdapterApprovalRequest, AdapterInputPart, AdapterItem } from '../../core/adapter.js';
import type { Decision, FileChange, InputQuestion, ItemStatus, ModelInfo, Usage } from '../../generated/common.js';
import { fileLine, inlineImage, parseDataUrl } from '../shared/attachments.js';

type Json = Record<string, unknown>;

/** The confirm title of Nano's approval extension (host/pi-extension/nano-approval.js). */
export const APPROVAL_TITLE = 'nano-approval';

/** A pi confirm can only say yes or no; `cancel` declines and interrupts the turn. */
export const APPROVAL_DECISIONS: readonly Decision[] = ['accept', 'decline', 'cancel'];

/** Dialog methods that wait for an answer; everything else (notify, setStatus, ...) is fire-and-forget. */
export const DIALOG_METHODS = ['confirm', 'select', 'input', 'editor'] as const;
export type DialogMethod = (typeof DIALOG_METHODS)[number];

/** The question id of the single question a pi dialog becomes. */
export const ANSWER_ID = 'answer';

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
export const obj = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// ---- input ---------------------------------------------------------------------------------------

/**
 * A pi prompt (pi docs rpc-commands.md `prompt`, `steer`): the text parts joined, mentions as their path,
 * images as pi `ImageContent {type: "image", data, mimeType}` (a stored attachment is read from its path,
 * spec 8.1), and a file, or an image of a type the model input does not take, as `Attached file: <path>`.
 */
export async function toPrompt(input: readonly AdapterInputPart[]): Promise<{ message: string; images?: Json[] }> {
  const text: string[] = [];
  const images: Json[] = [];
  for (const part of input) {
    if (part.type === 'text') text.push(part.text);
    else if (part.type === 'mention') text.push(part.path);
    else if (part.type === 'file') text.push(fileLine(part));
    else if (part.path === undefined) {
      // A data URL passes as it is; any other URL pi cannot fetch.
      const parsed = parseDataUrl(part.url);
      if (parsed !== undefined) images.push({ type: 'image', mimeType: parsed.mediaType, data: parsed.data });
    } else {
      const image = await inlineImage(part);
      if (image !== undefined) images.push({ type: 'image', mimeType: image.mediaType, data: image.data });
      else text.push(fileLine(part));
    }
  }
  const out: { message: string; images?: Json[] } = { message: text.join('\n') };
  if (images.length > 0) out.images = images;
  return out;
}

// ---- models --------------------------------------------------------------------------------------

/** The protocol model id of a pi model: `provider/id`, the form of pi's own `--model`. */
export function modelKey(model: unknown): string | undefined {
  const m = obj(model);
  if (typeof m.provider !== 'string' || typeof m.id !== 'string' || m.provider === '' || m.id === '') return undefined;
  return `${m.provider}/${m.id}`;
}

/** `provider/id` -> pi's `set_model {provider, modelId}` (the id itself may contain slashes). */
export function splitModel(key: string): { provider: string; modelId: string } | undefined {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return undefined;
  return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) };
}

/** pi `get_available_models` entries -> protocol ModelInfo with the provider name; `current` is the default. */
export function toModels(models: unknown, current: unknown, level?: unknown): ModelInfo[] {
  const currentKey = modelKey(current);
  const out: ModelInfo[] = [];
  for (const raw of list(models)) {
    const key = modelKey(raw);
    if (key === undefined) continue;
    const m = obj(raw);
    const model: ModelInfo = { id: key, displayName: str(m.name) || str(m.id), default: key === currentKey, provider: str(m.provider) };
    const [first, ...more] = thinkingLevels(raw);
    if (first !== undefined) {
      model.efforts = [first, ...more];
      if (typeof level === 'string') model.defaultEffort = fitThinkingLevel(raw, level);
    }
    out.push(model);
  }
  return out;
}

// ---- thinking levels (spec 4 ModelInfo.efforts, 5.1 settings.effort) -----------------------------

/** pi's thinking levels, lowest first (pi-agent-core ThinkingLevel, pi 1.4.0). */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const isThinkingLevel = (value: unknown): value is string => (PI_THINKING_LEVELS as readonly unknown[]).includes(value);

/**
 * The thinking levels pi offers for a model, as pi computes them (pi-ai getSupportedThinkingLevels): none
 * for a model without `reasoning` (pi would offer only `off`, which is no choice); else every level whose
 * `thinkingLevelMap` entry is not null, xhigh and max only when the map names them.
 */
export function thinkingLevels(model: unknown): string[] {
  const m = obj(model);
  if (m.reasoning !== true) return [];
  const map = obj(m.thinkingLevelMap);
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
  });
}

/** A level fitted to a model the way pi does on a model switch (pi-ai clampThinkingLevel): up first, then down. */
export function fitThinkingLevel(model: unknown, level: string): string {
  const available = thinkingLevels(model);
  if (available.length === 0) return 'off';
  if (available.includes(level)) return level;
  const at = (PI_THINKING_LEVELS as readonly string[]).indexOf(level);
  if (at === -1) return available[0]!;
  const above = PI_THINKING_LEVELS.slice(at).find((l) => available.includes(l));
  const below = [...PI_THINKING_LEVELS.slice(0, at)].reverse().find((l) => available.includes(l));
  return above ?? below ?? available[0]!;
}

// ---- items ---------------------------------------------------------------------------------------

/** The text of a pi tool result (`{content: [{type: "text", text}]}`). */
export function resultText(result: unknown): string {
  return list(obj(result).content)
    .map(obj)
    .filter((c) => c.type === 'text')
    .map((c) => str(c.text))
    .join('');
}

/** A whole new file as a diff: every line added. */
function addedLines(content: string): string {
  if (content === '') return '';
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  return lines.map((line) => `+${line}`).join('\n');
}

/** pi `edit` replacements as a diff of removed and added lines. */
function editLines(edits: unknown): string {
  return list(edits)
    .map(obj)
    .map((e) => [...str(e.oldText).split('\n').map((l) => `-${l}`), ...str(e.newText).split('\n').map((l) => `+${l}`)].join('\n'))
    .join('\n');
}

/**
 * The file changes a `write` or `edit` call makes. A write to a file that already exists is a `modify`;
 * the check runs before the tool does (when the call starts or asks for approval).
 */
export function toFileChanges(toolName: string, args: Json, cwd: string, patch?: string): FileChange[] {
  const file = str(args.path);
  if (toolName === 'write') {
    const exists = file !== '' && existsSync(path.resolve(cwd, file));
    return [{ path: file, kind: exists ? 'modify' : 'add', diff: addedLines(str(args.content)) }];
  }
  return [{ path: file, kind: 'modify', diff: patch ?? editLines(args.edits) }];
}

/** A pi tool call as a protocol item: bash is a command, write and edit are file changes, the rest tool calls. */
export function toToolItem(itemId: string, toolName: string, args: Json, cwd: string, status: ItemStatus): AdapterItem {
  if (toolName === 'bash') return { itemId, status, type: 'command', command: str(args.command), cwd, output: '' };
  if (toolName === 'write' || toolName === 'edit') return { itemId, status, type: 'fileChange', changes: toFileChanges(toolName, args, cwd) };
  return { itemId, status, type: 'toolCall', tool: toolName, arguments: args };
}

/**
 * The finished tool item from `tool_execution_end`. `declined` is true when the host refused the call
 * (Nano's extension blocked it); any other error result is `failed`.
 */
export function finishToolItem(started: AdapterItem, end: Json, declined: boolean): AdapterItem {
  const isError = end.isError === true;
  const status: ItemStatus = declined ? 'declined' : isError ? 'failed' : 'completed';
  const result = obj(end.result);
  const text = resultText(result);
  const out = { ...started, status } as AdapterItem & Json;
  if (started.type === 'command') {
    out.output = text;
    const exit = obj(result.structuredContent).exit_code;
    if (typeof exit === 'number') out.exitCode = exit;
    if (typeof end.durationMs === 'number') out.durationMs = end.durationMs;
  } else if (started.type === 'fileChange') {
    const patch = obj(result.details).patch;
    if (typeof patch === 'string' && patch !== '') {
      out.changes = started.changes.map((change, i) => (i === 0 ? { ...change, diff: patch } : change));
    }
  } else if (started.type === 'toolCall') {
    if (isError) out.error = text;
    else out.result = result.structuredContent ?? text;
  }
  return out as AdapterItem;
}

// ---- dialogs -------------------------------------------------------------------------------------

/** The call Nano's extension asks about, from the confirm's JSON message; undefined when it is not one. */
export function parseApproval(request: Json): { toolCallId: string; toolName: string; input: Json; cwd: string } | undefined {
  if (request.method !== 'confirm' || request.title !== APPROVAL_TITLE) return undefined;
  try {
    const call = obj(JSON.parse(str(request.message)));
    if (typeof call.toolName !== 'string') return undefined;
    return { toolCallId: str(call.toolCallId), toolName: call.toolName, input: obj(call.input), cwd: str(call.cwd) };
  } catch {
    return undefined;
  }
}

/** A Nano approval as a protocol request: command for bash, fileChange for write and edit, else permission. */
export function toApproval(requestId: string, call: { toolCallId: string; toolName: string; input: Json; cwd: string }, sessionCwd: string): AdapterApprovalRequest {
  // The session folder as the user picked it (pi reports the resolved path, /private/var for /var).
  const cwd = sessionCwd || call.cwd;
  const base = { requestId, itemId: call.toolCallId, expiresAt: null, availableDecisions: [...APPROVAL_DECISIONS] };
  if (call.toolName === 'bash') {
    return { ...base, kind: 'command', command: str(call.input.command), cwd, reason: 'pi wants to run a shell command' };
  }
  if (call.toolName === 'write' || call.toolName === 'edit') {
    return { ...base, kind: 'fileChange', changes: toFileChanges(call.toolName, call.input, cwd), reason: `pi wants to ${call.toolName} a file` };
  }
  return {
    ...base,
    kind: 'permission',
    permissions: { tool: call.toolName, arguments: call.input },
    scope: 'turn',
    reason: `pi wants to use the ${call.toolName} tool`,
  };
}

/** pi's answer to a Nano approval. */
export function approvalAnswer(decision: Decision): Json {
  return { confirmed: decision === 'accept' || decision === 'acceptForSession' };
}

/** Any other dialog (select, input, editor, a foreign confirm) as one question. */
export function toQuestion(request: Json): InputQuestion {
  const title = str(request.title);
  const question = str(request.message) || title;
  const base = { id: ANSWER_ID, header: title, question, isSecret: false };
  if (request.method === 'select') {
    return { ...base, isOther: false, options: list(request.options).map((o) => ({ label: str(o), description: '' })) };
  }
  if (request.method === 'confirm') {
    return { ...base, isOther: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] };
  }
  return { ...base, isOther: true };
}

/** Protocol answers -> pi's dialog response; nothing picked or typed cancels the dialog. */
export function dialogAnswer(method: string, answers: Record<string, string[]>): Json {
  const value = (answers[ANSWER_ID] ?? Object.values(answers)[0] ?? []).find((v) => v !== '');
  if (value === undefined) return { cancelled: true };
  if (method === 'confirm') return { confirmed: value === 'Yes' };
  return { value };
}

// ---- turns and usage -----------------------------------------------------------------------------

/** pi `get_session_stats` -> protocol Usage: session totals, and how full the context window is now. */
export function toUsage(stats: unknown): Usage {
  const s = obj(stats);
  const tokens = obj(s.tokens);
  const usage: Usage = {
    inputTokens: num(tokens.input) + num(tokens.cacheRead) + num(tokens.cacheWrite),
    outputTokens: num(tokens.output),
  };
  const percent = obj(s.contextUsage).percent;
  if (typeof percent === 'number' && Number.isFinite(percent)) usage.contextPercent = Math.min(100, Math.round(percent * 10) / 10);
  return usage;
}

/** The pi version from `pi --version` (`1.3.0`). */
export function versionFrom(output: string): string | undefined {
  return /(\d+\.\d+[^\s]*)/.exec(output)?.[1];
}
