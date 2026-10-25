// The transcript's rows in the new look (docs/research/new-look-prototype.md, item 4): each tool call is one
// line, an icon and a verb phrase ("Ran npm test", "Edited src/parser.ts"); a finished turn folds its work
// behind "N previous messages" and a hairline says "Worked for 3m 12s". Plain rules over the session model's
// rows, shared by the session view, local chat and the lab (/lab), which built them first.
import type { IconName } from '../../ui/Icon';
import type { ItemRow, Tone } from './session-model';

/** "Worked for 12s", "Worked for 3m 12s", "Worked for 3h 42m" (the iOS Codex wording); a stopped turn passes its own lead. */
export function workedFor(ms: number, lead = 'Worked for'): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${lead} ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${lead} ${minutes}m ${seconds % 60}s`;
  return `${lead} ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "1 previous message", "3 previous messages". */
export function previousMessages(count: number): string {
  return `${count} previous message${count === 1 ? '' : 's'}`;
}

/** One transcript row: leading icon, verb and target in secondary text, an optional tag (failed, declined). */
export interface RowLine {
  icon: IconName;
  verb: string;
  target: string;
  /** A running item: the icon turns. */
  busy: boolean;
  tag?: { text: string; tone: Tone };
}

type RowItem = Exclude<ItemRow, { kind: 'user' } | { kind: 'agent' }>;

function tagOf(state: string, tone: Tone): RowLine['tag'] {
  if (tone === 'error') return { text: state, tone };
  if (state === 'Declined') return { text: state, tone: 'muted' };
  return undefined;
}

function filesVerb(kinds: string[], busy: boolean): string {
  if (busy) return 'Editing';
  if (kinds.length > 0 && kinds.every((k) => k === 'add')) return 'Created';
  if (kinds.length > 0 && kinds.every((k) => k === 'delete')) return 'Deleted';
  return 'Edited';
}

/** The one line a non-message item shows. */
export function rowLine(item: RowItem): RowLine {
  switch (item.kind) {
    case 'command': {
      const busy = item.tone === 'busy';
      const tag = tagOf(item.state, item.tone);
      return { icon: busy ? 'spinner' : 'terminal', verb: busy ? 'Running' : item.state === 'Declined' ? 'Declined' : 'Ran', target: item.command, busy, ...(tag ? { tag } : {}) };
    }
    case 'fileChange': {
      const busy = item.tone === 'busy';
      const tag = tagOf(item.state, item.tone);
      const target = item.files.length === 1 ? item.files[0]!.path : `${item.files.length} files`;
      return { icon: busy ? 'spinner' : 'file-diff', verb: filesVerb(item.files.map((f) => f.kind), busy), target, busy, ...(tag ? { tag } : {}) };
    }
    case 'tool': {
      const busy = item.tone === 'busy';
      const tag = tagOf(item.state, item.tone);
      return { icon: busy ? 'spinner' : 'wrench', verb: busy ? 'Calling' : 'Called', target: item.summary, busy, ...(tag ? { tag } : {}) };
    }
    case 'reasoning':
      return { icon: 'lightbulb', verb: item.streaming ? 'Thinking' : 'Thought', target: item.summary.split('\n')[0]!.trim(), busy: false };
    case 'plan':
      return { icon: 'list', verb: 'Updated the plan', target: '', busy: false };
    case 'other':
      return { icon: 'gear', verb: item.label, target: '', busy: false };
  }
}

/**
 * A turn's items laid out for the view. A finished turn keeps its user messages and its last agent message
 * (the answer) in sight and folds everything else behind "N previous messages"; a running turn shows its
 * items in order.
 */
export interface TurnLayout {
  /** Shown above the fold: every item of a running turn, the user messages of a finished one. */
  lead: ItemRow[];
  /** The finished turn's intermediate work, in order (empty for a running turn). */
  work: ItemRow[];
  /** The finished turn's answer, shown after the work and the "Worked for" line. */
  answer?: ItemRow;
}

export function layoutTurn(items: readonly ItemRow[], final: boolean): TurnLayout {
  if (!final) return { lead: [...items], work: [] };
  let answerAt = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.kind === 'agent') {
      answerAt = i;
      break;
    }
  }
  const lead = items.filter((item) => item.kind === 'user');
  const work = items.filter((item, i) => item.kind !== 'user' && i !== answerAt);
  return answerAt >= 0 ? { lead, work, answer: items[answerAt]! } : { lead, work };
}
