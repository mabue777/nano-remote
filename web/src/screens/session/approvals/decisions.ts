// Approval cards (spec 5.3): what a card shows for each request kind and which buttons it offers. Pure
// functions; the model, the components and the lab's New look use them. The line an answered card leaves is
// answered.ts.
//
// Buttons: only the decisions the adapter listed in `availableDecisions`, always in the order accept,
// accept for session, decline, cancel; Accept and Decline sit in the row, the others behind More
// (groupButtons). Anything else in the list (a newer decision, or an object-valued
// Codex amendment an adapter forgot to drop) gets no button: the phone cannot know what it means.
import type { ApprovalRequestBody, Decision } from '../../../replica/types';
import { unwrapShell } from '../session-model';

export const DECISION_ORDER: readonly Decision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

export const DECISION_LABELS: Readonly<Record<Decision, string>> = {
  accept: 'Accept',
  acceptForSession: 'Accept for this session',
  decline: 'Decline',
  cancel: 'Cancel the turn',
};

/** What each decision does, for the button's accessible description. */
const DECISION_HINTS: Readonly<Record<Decision, string>> = {
  accept: 'Allow this once',
  acceptForSession: 'Allow this and the same kind of request for the rest of the session',
  decline: 'Refuse; the agent carries on without it',
  cancel: 'Refuse and stop the turn',
};

export interface DecisionButton {
  decision: Decision;
  label: string;
  hint: string;
  /** primary (ink) for accept, plain (a grey pill) for the rest: Cancel is grey like Decline, not red. */
  tone: 'primary' | 'plain';
}

function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISION_ORDER as readonly string[]).includes(value);
}

/** The buttons for an approval: the known decisions in `available`, in canonical order, once each. */
export function decisionButtons(available: readonly unknown[] | undefined): DecisionButton[] {
  const offered = new Set((available ?? []).filter(isDecision));
  return DECISION_ORDER.filter((d) => offered.has(d)).map((decision) => ({
    decision,
    label: DECISION_LABELS[decision],
    hint: DECISION_HINTS[decision],
    tone: decision === 'accept' ? 'primary' : 'plain',
  }));
}

/** The card's buttons: Accept and Decline in the row, the rest (for this session, cancel) behind More. */
export interface ButtonGroups {
  main: DecisionButton[];
  more: DecisionButton[];
}

const MAIN: ReadonlySet<Decision> = new Set(['accept', 'decline']);

/**
 * Splits the buttons into the row and the More list. When the adapter offers neither Accept nor Decline,
 * every button sits in the row: a card must never hide all of its choices.
 */
export function groupButtons(buttons: readonly DecisionButton[]): ButtonGroups {
  const main = buttons.filter((b) => MAIN.has(b.decision));
  if (main.length === 0) return { main: [...buttons], more: [] };
  return { main, more: buttons.filter((b) => !MAIN.has(b.decision)) };
}

export type DiffLineTone = 'add' | 'del' | 'hunk' | 'ctx';

export interface DiffPreview {
  lines: { text: string; tone: DiffLineTone }[];
  /** Lines not shown. */
  more: number;
}

/** The first `max` lines of a unified diff with their tone; file headers (---/+++) are skipped. */
export function diffPreview(diff: string, max = 12): DiffPreview {
  const all = diff
    .split('\n')
    .filter((line, i, lines) => !(line === '' && i === lines.length - 1))
    .filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('diff --git') && !line.startsWith('index '));
  const tone = (line: string): DiffLineTone =>
    line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
  return { lines: all.slice(0, max).map((text) => ({ text, tone: tone(text) })), more: Math.max(0, all.length - max) };
}

export type ApprovalBody =
  | { kind: 'command'; command: string; fullCommand: string; cwd: string }
  | { kind: 'fileChange'; files: { path: string; kind: string; preview: DiffPreview }[]; grantRoot?: string }
  | { kind: 'permission'; scope?: string };

export interface ApprovalCardView {
  requestId: string;
  kind: ApprovalRequestBody['kind'];
  title: string;
  reason: string;
  body: ApprovalBody;
  buttons: DecisionButton[];
}

/** Card content for any approval kind; an unknown kind newer than this client renders like permission. */
export function approvalCard(request: ApprovalRequestBody): ApprovalCardView {
  const base = { requestId: request.requestId, kind: request.kind, reason: request.reason ?? '', buttons: decisionButtons(request.availableDecisions) };
  switch (request.kind) {
    case 'command':
      return {
        ...base,
        title: 'Run this command?',
        body: { kind: 'command', command: unwrapShell(request.command), fullCommand: request.command, cwd: request.cwd },
      };
    case 'fileChange':
      return {
        ...base,
        title: request.changes.length === 1 ? 'Change this file?' : `Change ${request.changes.length} files?`,
        body: {
          kind: 'fileChange',
          files: request.changes.map((c) => ({ path: c.path, kind: c.kind, preview: diffPreview(typeof c.diff === 'string' ? c.diff : '') })),
          ...(typeof request.grantRoot === 'string' && request.grantRoot !== '' ? { grantRoot: request.grantRoot } : {}),
        },
      };
    default: {
      const scope = (request as { scope?: unknown }).scope;
      return {
        ...base,
        title: 'Approval required',
        body: { kind: 'permission', ...(scope === 'turn' || scope === 'session' ? { scope } : {}) },
      };
    }
  }
}
