// Pure translations between Codex app-server shapes (docs/research/rea/codex-app-server-schema/v2) and
// the protocol vocabulary of protocol-v1.md section 5. This file and adapter.ts are the only places that
// know Codex's names.
import type { Decision, FileChange, InputPart, ItemStatus, ModelInfo, SessionStatus, TurnError, Usage } from '../../generated/common.js';
import type { DeltaField } from '../../journal/types.js';
import type { AdapterItem, FinalTurnStatus } from '../../core/adapter.js';

type Json = Record<string, unknown>;

const DECISIONS: readonly Decision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
const ITEM_STATUSES: readonly ItemStatus[] = ['inProgress', 'completed', 'failed', 'declined'];

/** Codex approval server requests and the protocol approval kind each one becomes. */
export const APPROVAL_METHODS = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permission',
} as const;
export type ApprovalMethod = keyof typeof APPROVAL_METHODS;

export const INPUT_METHOD = 'item/tool/requestUserInput';

/** Codex item delta notifications and the protocol delta field each one streams. */
export const DELTA_METHODS: Readonly<Record<string, DeltaField>> = {
  'item/agentMessage/delta': 'text',
  'item/plan/delta': 'text',
  'item/reasoning/summaryTextDelta': 'summary',
  'item/reasoning/textDelta': 'text',
  'item/commandExecution/outputDelta': 'output',
  'item/fileChange/outputDelta': 'patch',
};

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const obj = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Protocol InputPart -> Codex UserInput. */
export function toUserInput(input: readonly InputPart[]): Json[] {
  return input.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text, text_elements: [] };
    if (part.type === 'image') return { type: 'image', url: part.url };
    return { type: 'mention', name: part.name, path: part.path };
  });
}

/** Codex FileUpdateChange -> protocol FileChange (`update` is `modify`). */
export function toFileChanges(changes: unknown): FileChange[] {
  return list(changes).map((raw) => {
    const change = obj(raw);
    const kind = str(obj(change.kind).type);
    return {
      path: str(change.path),
      kind: kind === 'add' ? 'add' : kind === 'delete' ? 'delete' : 'modify',
      diff: str(change.diff),
    };
  });
}

function status(item: Json, completed: boolean): ItemStatus {
  const value = item.status;
  if (typeof value === 'string' && (ITEM_STATUSES as readonly string[]).includes(value)) return value as ItemStatus;
  return completed ? 'completed' : 'inProgress';
}

/**
 * A Codex ThreadItem as a protocol item, or undefined for the user's own message (the core journals that
 * itself, with the client's message id). `completed` tells an `item/completed` from an `item/started`.
 */
export function toItem(raw: unknown, completed: boolean): AdapterItem | undefined {
  const item = obj(raw);
  const itemId = str(item.id);
  const type = str(item.type);
  const base = { itemId, status: status(item, completed) };
  switch (type) {
    case 'userMessage':
      return undefined;
    case 'agentMessage':
      return { ...base, type: 'agentMessage', text: str(item.text) };
    case 'plan':
      return { ...base, type: 'plan', text: str(item.text) };
    case 'reasoning': {
      const out: AdapterItem = { ...base, type: 'reasoning', summary: list(item.summary).map((s) => str(s)).join('\n') };
      const content = list(item.content);
      if (content.length > 0) out.text = content.map((s) => str(s)).join('\n');
      return out;
    }
    case 'commandExecution': {
      const out: AdapterItem = {
        ...base,
        type: 'command',
        command: str(item.command),
        cwd: str(item.cwd),
        output: str(item.aggregatedOutput),
      };
      if (typeof item.exitCode === 'number') out.exitCode = item.exitCode;
      if (typeof item.durationMs === 'number') out.durationMs = item.durationMs;
      return out;
    }
    case 'fileChange':
      return { ...base, type: 'fileChange', changes: toFileChanges(item.changes) };
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const out: AdapterItem = { ...base, type: 'toolCall', tool: str(item.tool), arguments: obj(item.arguments) };
      if (typeof item.server === 'string') out.server = item.server;
      const result = type === 'mcpToolCall' ? item.result : item.contentItems;
      if (result !== undefined && result !== null) out.result = result;
      if (item.error !== undefined && item.error !== null) out.error = item.error;
      return out;
    }
    case 'webSearch': {
      const out: AdapterItem = { ...base, type: 'toolCall', tool: 'webSearch', arguments: { query: str(item.query) } };
      if (Array.isArray(item.results)) out.result = item.results;
      return out;
    }
    case 'imageView':
      return { ...base, type: 'toolCall', tool: 'imageView', arguments: { path: str(item.path) } };
    default:
      return { ...base, type: 'other', raw: item };
  }
}

/** The engine's own decisions, without the object-valued ones (execpolicy and network amendments). */
export function decisionsFrom(available: unknown, fallback: readonly Decision[] = DECISIONS): Decision[] {
  if (!Array.isArray(available)) return [...fallback];
  return available.filter((d): d is Decision => typeof d === 'string' && (DECISIONS as readonly string[]).includes(d));
}

/** What the engine expects back for an approval. */
export function approvalResponse(method: ApprovalMethod, decision: Decision, params: Json): Json {
  if (method !== 'item/permissions/requestApproval') return { decision };
  // Permissions are granted, not decided: the requested profile for a turn or the session, or nothing.
  if (decision === 'accept' || decision === 'acceptForSession') {
    return { permissions: obj(params.permissions), scope: decision === 'accept' ? 'turn' : 'session' };
  }
  return { permissions: {}, scope: 'turn' };
}

/** Protocol answers keyed by question id -> Codex `ToolRequestUserInputResponse`. */
export function inputResponse(answers: Record<string, string[]>): Json {
  const out: Record<string, { answers: string[] }> = {};
  for (const [id, values] of Object.entries(answers)) out[id] = { answers: values };
  return { answers: out };
}

/** Codex ThreadStatus -> protocol session status (`notLoaded` says nothing about the session). */
export function toSessionStatus(raw: unknown): SessionStatus | undefined {
  const value = obj(raw);
  switch (value.type) {
    case 'idle':
      return 'idle';
    case 'systemError':
      return 'error';
    case 'active': {
      const flags = list(value.activeFlags);
      if (flags.includes('waitingOnApproval')) return 'waiting_approval';
      if (flags.includes('waitingOnUserInput')) return 'waiting_input';
      return 'running';
    }
    default:
      return undefined;
  }
}

/**
 * Codex ThreadTokenUsage -> protocol Usage. Codex sends one per model request, mid-turn included.
 * `inputTokens`/`outputTokens` are the thread totals (`total`: every request summed, so input grows by the
 * whole context per request). `contextPercent` is how full the window is, from the latest request alone
 * (`last.totalTokens` / `modelContextWindow`), never from the cumulative `total`.
 */
export function toUsage(raw: unknown): Usage {
  const usage = obj(raw);
  const total = obj(usage.total);
  const last = obj(usage.last);
  const out: Usage = { inputTokens: num(total.inputTokens), outputTokens: num(total.outputTokens) };
  const window = usage.modelContextWindow;
  if (typeof window === 'number' && window > 0) {
    out.contextPercent = Math.min(100, Math.round((num(last.totalTokens) / window) * 1000) / 10);
  }
  return out;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Codex TurnStatus -> the final status of a turn. */
export function toFinalStatus(value: unknown): FinalTurnStatus {
  return value === 'interrupted' || value === 'failed' ? value : 'completed';
}

/** Codex TurnError -> protocol TurnError. `codexErrorInfo` is a string or a one-key object. */
export function toTurnError(raw: unknown): TurnError {
  const error = obj(raw);
  const info = error.codexErrorInfo;
  const code = typeof info === 'string' ? info : Object.keys(obj(info))[0] ?? 'agent_error';
  const out: TurnError = { code, message: str(error.message, 'the turn failed') };
  if (typeof error.additionalDetails === 'string') out.details = error.additionalDetails;
  return out;
}

/** Codex `model/list` entries -> protocol ModelInfo, hidden models left out. */
export function toModels(data: unknown): ModelInfo[] {
  return list(data)
    .map(obj)
    .filter((m) => m.hidden !== true && typeof m.id === 'string')
    .map((m) => ({ id: str(m.id), displayName: str(m.displayName, str(m.id)), default: m.isDefault === true }));
}

/** The model a session gets when its settings name none: the engine's default, else its first. */
export function defaultModel(models: readonly ModelInfo[]): string | undefined {
  return (models.find((m) => m.default) ?? models[0])?.id;
}

/** The engine version from the `initialize` userAgent (`codex_cli_rs/0.163.0 (...)`). */
export function versionFrom(userAgent: string): string | undefined {
  return /\/(\d[^\s/]*)/.exec(userAgent)?.[1];
}
