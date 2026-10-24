// Pure translations between Claude Agent SDK shapes (sdk.d.ts of @anthropic-ai/claude-agent-sdk 0.3.308)
// and the protocol vocabulary of protocol-v1.md section 5. This file and adapter.ts are the only places
// that know Claude's names.
import { existsSync } from 'node:fs';
import path from 'node:path';

import type {
  Decision,
  FileChange,
  InputQuestion,
  ModelInfo,
  Settings,
  TurnError,
  Usage,
} from '../../generated/common.js';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

import type { AdapterApprovalRequest, AdapterInputPart, AdapterInputRequest, AdapterItem, FinalTurnStatus } from '../../core/adapter.js';
import type { ClaudeConfig } from '../../config/claude.js';
import { fileLine, inlineImage } from '../shared/attachments.js';

type Json = Record<string, unknown>;

/** The SDK's PermissionMode values the adapter uses. */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/** What `canUseTool` answers (the SDK's PermissionResult, the fields the adapter sets). */
export type PermissionAnswer =
  | { behavior: 'allow'; updatedInput: Json; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export const DECLINE_MESSAGE = 'The user declined this action.';
export const CANCEL_MESSAGE = 'The user cancelled this action and stopped the turn.';

/** Tools whose calls become `command` items and approvals. */
const COMMAND_TOOLS = new Set(['Bash']);
/** Tools whose calls become `fileChange` items and approvals. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const QUESTION_TOOL = 'AskUserQuestion';

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const obj = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The child's environment: the host's own minus the variables of a Claude Code session the host may itself
 * run in (CLAUDECODE, CLAUDE_PID, CLAUDE_EFFORT, CLAUDE_CODE_* except the OAuth token), so the child is a
 * clean headless run; CLAUDE_CONFIG_DIR names the configured folder (the login); then the config's extras.
 */
export function childEnv(config: Pick<ClaudeConfig, 'configDir' | 'env'>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue;
    if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN') continue;
    out[key] = value;
  }
  out.CLAUDE_CONFIG_DIR = config.configDir;
  return { ...out, ...config.env };
}

/** The approvalMode values a Claude session honours (spec 5.1); anything else runs as `default`. */
export const CLAUDE_APPROVAL_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'never'];

/**
 * The permission mode of a session (spec 5.1 `approvalMode`): `never` (the client's "Bypass approvals")
 * is bypassPermissions, `acceptEdits` and `plan` are the Claude modes of the same name, anything else is
 * `default`, the only mode in which every tool call reaches `canUseTool`. `approvalMode` is what the
 * session reports back as in effect.
 */
export function sessionPolicy(settings: Settings): { permissionMode: ClaudePermissionMode; approvalMode: string } {
  const mode = settings.approvalMode;
  if (mode === 'never') return { permissionMode: 'bypassPermissions', approvalMode: 'never' };
  if (mode === 'acceptEdits' || mode === 'plan') return { permissionMode: mode, approvalMode: mode };
  return { permissionMode: 'default', approvalMode: 'default' };
}

/** The model of a session: its settings' model, else the configured default. */
export function sessionModel(settings: Settings, config: Pick<ClaudeConfig, 'defaultModel'>): string {
  return typeof settings.model === 'string' && settings.model !== '' ? settings.model : config.defaultModel;
}

/**
 * Protocol input as the text of one user message. Text parts are joined by blank lines. A mention becomes
 * `@path` (Claude Code's own way to point at a file), a file attachment (spec 8.1) `Attached file: <path>`,
 * and an image that is not sent as an image block its path line or URL (a data URL is too large for a
 * prompt and is left out with a note).
 */
export function toUserText(input: readonly AdapterInputPart[]): string {
  return input
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'mention') return `@${part.path}`;
      if (part.type === 'file' || part.path !== undefined) return fileLine(part);
      return part.url.startsWith('data:') ? '[an image was attached, but this agent cannot receive images]' : `[image: ${part.url}]`;
    })
    .join('\n\n');
}

/** An Anthropic image content block (base64 source). */
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/**
 * The content of one user message: the text alone when no image goes as an image block, else the image
 * blocks (stored attachments read from their path, data URLs decoded; JPEG, PNG, GIF and WebP) followed
 * by one text block with everything else (toUserText). Images of other types go as their path line.
 */
export async function toUserContent(input: readonly AdapterInputPart[]): Promise<string | (ImageBlock | { type: 'text'; text: string })[]> {
  const images: ImageBlock[] = [];
  const rest: AdapterInputPart[] = [];
  for (const part of input) {
    const image = part.type === 'image' ? await inlineImage(part) : undefined;
    if (image !== undefined) images.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
    else rest.push(part);
  }
  const text = toUserText(rest);
  if (images.length === 0) return text;
  return text === '' ? images : [...images, { type: 'text', text }];
}

/** The decisions an approval offers: "for the session" only when the SDK suggested rules to remember. */
export function decisionsFor(suggestions: unknown): Decision[] {
  return list(suggestions).length > 0 ? ['accept', 'acceptForSession', 'decline', 'cancel'] : ['accept', 'decline', 'cancel'];
}

/** A text as unified diff hunks: every line removed (`-`) or added (`+`). */
function hunk(oldText: string, newText: string): string {
  const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const removed = lines(oldText);
  const added = lines(newText);
  const header = `@@ -${removed.length === 0 ? 0 : 1},${removed.length} +${added.length === 0 ? 0 : 1},${added.length} @@`;
  return [header, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');
}

/**
 * The file changes of a Write, Edit, MultiEdit or NotebookEdit call. The diff is the tool's new text as
 * hunks (Edit: old_string removed, new_string added); the adapter does not read the file, so line numbers
 * start at 1. A Write to a file that exists is a modify.
 */
export function fileChangesFor(toolName: string, input: Json, cwd: string): FileChange[] {
  if (toolName === 'NotebookEdit') {
    return [{ path: str(input.notebook_path), kind: 'modify', diff: hunk('', str(input.new_source)) }];
  }
  const file = str(input.file_path);
  if (toolName === 'Write') {
    const exists = file !== '' && existsSync(path.resolve(cwd, file));
    return [{ path: file, kind: exists ? 'modify' : 'add', diff: hunk('', str(input.content)) }];
  }
  if (toolName === 'MultiEdit') {
    const edits = list(input.edits).map(obj);
    return [{ path: file, kind: 'modify', diff: edits.map((e) => hunk(str(e.old_string), str(e.new_string))).join('\n') }];
  }
  return [{ path: file, kind: 'modify', diff: hunk(str(input.old_string), str(input.new_string)) }];
}

/** A tool's protocol item kind. */
export function itemKind(toolName: string): 'command' | 'fileChange' | 'toolCall' {
  if (COMMAND_TOOLS.has(toolName)) return 'command';
  if (FILE_TOOLS.has(toolName)) return 'fileChange';
  return 'toolCall';
}

/** A `tool_use` block as the item it starts. */
export function toolItem(block: Json, cwd: string): AdapterItem {
  const itemId = str(block.id);
  const name = str(block.name);
  const input = obj(block.input);
  switch (itemKind(name)) {
    case 'command':
      return { itemId, type: 'command', status: 'inProgress', command: str(input.command), cwd, output: '' };
    case 'fileChange':
      return { itemId, type: 'fileChange', status: 'inProgress', changes: fileChangesFor(name, input, cwd) };
    default: {
      const item: AdapterItem = { itemId, type: 'toolCall', status: 'inProgress', tool: name, arguments: input };
      if (name.startsWith('mcp__')) item.server = name.split('__')[1] ?? '';
      return item;
    }
  }
}

/** The text of a tool_result's content (a string, or text blocks). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content)
    .map(obj)
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text))
    .join('\n');
}

/** A started tool item completed by its `tool_result` block (`is_error` makes it failed). */
export function completeToolItem(started: AdapterItem, block: Json): AdapterItem {
  const failed = block.is_error === true;
  const text = resultText(block.content);
  const status = failed ? 'failed' : 'completed';
  if (started.type === 'command') return { ...started, status, output: text };
  if (started.type === 'fileChange') return { ...started, status };
  const item: AdapterItem = { ...started, status };
  if (failed) item.error = text;
  else item.result = text;
  return item;
}

export interface MappedRequest {
  /** An approval, or a question (AskUserQuestion). */
  event: { method: 'approval/request'; request: AdapterApprovalRequest } | { method: 'input/request'; request: AdapterInputRequest };
  /** For a question: the question texts by protocol question id (the index), which the answers are keyed by. */
  questions: string[];
}

/** What `canUseTool` reports, as the protocol request a client answers. */
export function toRequest(
  requestId: string,
  toolName: string,
  input: Json,
  context: { toolUseID: string; suggestions?: unknown; title?: string; decisionReason?: string; cwd: string },
): MappedRequest {
  const itemId = context.toolUseID;
  const base = { requestId, itemId, expiresAt: null, availableDecisions: decisionsFor(context.suggestions) };
  const reason = str(context.title) || str(context.decisionReason);
  if (toolName === QUESTION_TOOL) {
    const raw = list(input.questions).map(obj);
    const questions: InputQuestion[] = raw.map((q, index) => {
      const question: InputQuestion = {
        id: String(index),
        header: str(q.header),
        question: str(q.question),
        isOther: true,
        isSecret: false,
      };
      if (Array.isArray(q.options)) {
        question.options = q.options.map((o) => ({ label: str(obj(o).label), description: str(obj(o).description) }));
      }
      if (q.multiSelect === true) question.multiSelect = true;
      return question;
    });
    return {
      event: { method: 'input/request', request: { requestId, kind: 'input', itemId, isBlocking: true, questions } },
      questions: raw.map((q) => str(q.question)),
    };
  }
  const kind = itemKind(toolName);
  if (kind === 'command') {
    const request: AdapterApprovalRequest = {
      ...base,
      kind: 'command',
      command: str(input.command),
      cwd: context.cwd,
      reason: str(input.description) || reason,
    };
    return { event: { method: 'approval/request', request }, questions: [] };
  }
  if (kind === 'fileChange') {
    const request: AdapterApprovalRequest = { ...base, kind: 'fileChange', changes: fileChangesFor(toolName, input, context.cwd), reason };
    return { event: { method: 'approval/request', request }, questions: [] };
  }
  const request: AdapterApprovalRequest = {
    ...base,
    kind: 'permission',
    permissions: { tool: toolName, input },
    scope: 'turn',
    reason,
  };
  return { event: { method: 'approval/request', request }, questions: [] };
}

/** A protocol decision as the SDK's permission answer. */
export function permissionAnswer(decision: Decision, input: Json, suggestions: unknown): PermissionAnswer {
  switch (decision) {
    case 'accept':
      return { behavior: 'allow', updatedInput: input };
    case 'acceptForSession':
      return { behavior: 'allow', updatedInput: input, updatedPermissions: list(suggestions) };
    case 'decline':
      return { behavior: 'deny', message: DECLINE_MESSAGE };
    default:
      return { behavior: 'deny', message: CANCEL_MESSAGE, interrupt: true };
  }
}

/**
 * Protocol answers (keyed by question id, the index) as AskUserQuestion's answer: the tool input plus
 * `answers` keyed by question text. Several picks (multiSelect, or an option plus free text) are joined
 * with ", ".
 */
export function questionAnswer(input: Json, questions: readonly string[], answers: Record<string, string[]>): PermissionAnswer {
  const out: Record<string, string> = {};
  for (const [id, values] of Object.entries(answers)) {
    const text = questions[Number(id)];
    if (text === undefined || !/^\d+$/.test(id)) continue;
    out[text] = values.join(', ');
  }
  return { behavior: 'allow', updatedInput: { ...input, answers: out } };
}

/**
 * The result message's usage as protocol Usage. The SDK reports the turn's main-loop tokens; input counts
 * cache reads and cache writes too (the uncached `input_tokens` alone is a handful of tokens per turn).
 */
export function toUsage(raw: unknown): Usage {
  const usage = obj(raw);
  return {
    inputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
  };
}

/**
 * How a `result` message ends the turn: interrupted when the host asked for it, completed on success,
 * failed on an error subtype or `is_error` (code: the subtype; message: the SDK's errors or result text).
 */
export function toTurnEnd(result: Json, interrupted: boolean): { status: FinalTurnStatus; error?: TurnError } {
  if (interrupted) return { status: 'interrupted' };
  const subtype = str(result.subtype, 'error');
  if (subtype === 'success' && result.is_error !== true) return { status: 'completed' };
  const errors = list(result.errors).map((e) => str(e)).filter((e) => e !== '');
  const message = errors.join('\n') || str(result.result) || 'the turn failed';
  return { status: 'failed', error: { code: subtype === 'success' ? 'agent_error' : subtype, message } };
}

/**
 * The SDK's model list as protocol ModelInfo: the `default` alias row is left out (it names whatever
 * the account's default is; sessions get the configured default instead, marked `default`).
 */
export function toModels(raw: unknown, defaultModel: string): ModelInfo[] {
  const models = list(raw)
    .map(obj)
    .filter((m) => typeof m.value === 'string' && m.value !== '' && m.value !== 'default')
    .map((m) => {
      const model: ModelInfo = { id: str(m.value), displayName: str(m.displayName, str(m.value)), default: m.value === defaultModel };
      // supportedEffortLevels, in Claude's order; no defaultEffort: the engine does not report one (spec 4).
      const levels = m.supportsEffort === false ? [] : CLAUDE_EFFORTS.filter((level) => list(m.supportedEffortLevels).includes(level));
      const [first, ...more] = levels;
      if (first !== undefined) model.efforts = [first, ...more];
      return model;
    });
  if (!models.some((m) => m.default) && models.length > 0) models[0]!.default = true;
  return models;
}

/** Claude Code's effort levels, lowest first (SDK EffortLevel). */
export const CLAUDE_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const isEffort = (value: unknown): value is EffortLevel => CLAUDE_EFFORTS.includes(value as EffortLevel);

/**
 * The effort a session sends for a requested level (spec 5.1 settings.effort), fitted to the model's levels
 * the way Claude Code downgrades silently: the level itself when the model has it, else the highest level
 * below it, else the model's lowest. Undefined when nothing is requested, the request is not a Claude level,
 * or the model has no effort control (`levels` empty). Unknown `levels` (a model the list did not name)
 * let a Claude level through as it is.
 */
export function fitEffort(requested: unknown, levels: readonly string[] | undefined): EffortLevel | undefined {
  if (!isEffort(requested)) return undefined;
  if (levels === undefined) return requested;
  const offered = CLAUDE_EFFORTS.filter((level) => levels.includes(level));
  if (offered.includes(requested)) return requested;
  const rank = CLAUDE_EFFORTS.indexOf(requested);
  const below = offered.filter((level) => CLAUDE_EFFORTS.indexOf(level) < rank);
  return below[below.length - 1] ?? offered[0];
}

/** Used when the SDK cannot list models. */
export const STATIC_MODELS: readonly ModelInfo[] = [
  { id: 'opus', displayName: 'Opus', default: true },
  { id: 'sonnet', displayName: 'Sonnet', default: false },
  { id: 'haiku', displayName: 'Haiku', default: false },
];

/** STATIC_MODELS with the configured default marked. */
export function staticModels(defaultModel: string): ModelInfo[] {
  return toModels(
    STATIC_MODELS.map((m) => ({ value: m.id, displayName: m.displayName })),
    defaultModel,
  );
}
