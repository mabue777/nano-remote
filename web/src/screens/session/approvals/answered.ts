// The one line an approval or question card leaves once it is answered (docs/research/new-look-prototype.md,
// items 5 and 13): a check and "Approved" in green, a cross and "Declined" in grey, and so on; for a question
// the answer itself. When another device or the agent resolved it, the same line says who. Pure; the model
// (approvals-model.ts), the cards (RequestCards.tsx) and the lab's New look use it.
import type { Decision } from '../../../replica/types';

/** Who resolved a request, as far as this device knows. */
export type Resolver =
  /** This device (its approval/resolve or input/answer went through). */
  | { by: 'me' }
  /** Another paired device; `name` once device/list has answered. */
  | { by: 'device'; name?: string }
  /** The agent withdrew the request (request/resolved with resolvedBy "agent"). */
  | { by: 'agent' }
  /** Gone without a known resolver: a reconnect's snapshot no longer lists it. */
  | { by: 'unknown' }
  /** The host was no longer waiting (not_found). */
  | { by: 'gone' };

export interface AnsweredText {
  text: string;
  /** ok: green (an approval went through); muted: grey. */
  tone: 'ok' | 'muted';
  /** The leading sign: a check, or a cross for a refusal or a request that went away. */
  mark: 'check' | 'x';
}

const DECIDED: Readonly<Record<Decision, AnsweredText>> = {
  accept: { text: 'Approved', tone: 'ok', mark: 'check' },
  acceptForSession: { text: 'Accepted for this session', tone: 'ok', mark: 'check' },
  decline: { text: 'Declined', tone: 'muted', mark: 'x' },
  cancel: { text: 'Turn cancelled', tone: 'muted', mark: 'x' },
};

const GONE: AnsweredText = { text: 'No longer waiting', tone: 'muted', mark: 'x' };

/** "on iPhone 15", or "on another device" while the name is unknown or blank. */
export function onDevice(name: string | undefined): string {
  const trimmed = name?.trim() ?? '';
  return `on ${trimmed !== '' ? trimmed : 'another device'}`;
}

/**
 * The answered line of an approval. `decision` is what was decided when it is known (always for this
 * device; for another device when request/resolved carried it).
 */
export function approvalAnswered(resolver: Resolver, decision: Decision | undefined): AnsweredText {
  switch (resolver.by) {
    case 'me':
      return decision !== undefined ? DECIDED[decision] : { text: 'Answered', tone: 'muted', mark: 'check' };
    case 'device': {
      const where = onDevice(resolver.name);
      if (decision === undefined) return { text: `Answered ${where}`, tone: 'muted', mark: 'check' };
      return { ...DECIDED[decision], text: `${DECIDED[decision].text} ${where}` };
    }
    case 'agent':
      return { text: 'Withdrawn by the agent', tone: 'muted', mark: 'x' };
    case 'unknown':
      return { text: `Answered ${onDevice(undefined)}`, tone: 'muted', mark: 'check' };
    case 'gone':
      return GONE;
  }
}

/** The answered line of a question: the answer (answerSummary), and who gave it when it was not this device. */
export function questionAnswered(resolver: Resolver, answer: string): AnsweredText {
  switch (resolver.by) {
    case 'me':
      return { text: answer !== '' ? answer : 'Answered', tone: 'muted', mark: 'check' };
    case 'device': {
      const text = `Answered ${onDevice(resolver.name)}`;
      return { text: answer !== '' ? `${text}: ${answer}` : text, tone: 'muted', mark: 'check' };
    }
    case 'agent':
      return { text: 'Answered by the agent', tone: 'muted', mark: 'check' };
    case 'unknown':
      return { text: `Answered ${onDevice(undefined)}`, tone: 'muted', mark: 'check' };
    case 'gone':
      return GONE;
  }
}

/**
 * Where answered lines go in the conversation: each in its turn (`byTurn`), or, when its turn is not on
 * screen (not loaded yet, or gone), at the end with the pending cards (`orphans`).
 */
export function placeByTurn<T extends { turnId: string }>(rows: readonly T[], turnIds: ReadonlySet<string>): { byTurn: Map<string, T[]>; orphans: T[] } {
  const byTurn = new Map<string, T[]>();
  const orphans: T[] = [];
  for (const row of rows) {
    if (!turnIds.has(row.turnId)) {
      orphans.push(row);
      continue;
    }
    const list = byTurn.get(row.turnId);
    if (list === undefined) byTurn.set(row.turnId, [row]);
    else list.push(row);
  }
  return { byTurn, orphans };
}

/**
 * Inside a turn: right after the item the request was about when that item is shown (the card stays where
 * it was), else at the end of the turn's rows (the item is folded away, or the request named no row).
 */
export function placeInTurn<T extends { itemId: string }>(rows: readonly T[], shownItemIds: ReadonlySet<string>): { after: Map<string, T[]>; end: T[] } {
  const after = new Map<string, T[]>();
  const end: T[] = [];
  for (const row of rows) {
    if (!shownItemIds.has(row.itemId)) {
      end.push(row);
      continue;
    }
    const list = after.get(row.itemId);
    if (list === undefined) after.set(row.itemId, [row]);
    else list.push(row);
  }
  return { after, end };
}
