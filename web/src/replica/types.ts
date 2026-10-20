// Replica shapes: the phone's local copy of a session's Journal (CONTEXT.md "Replica"). Wire shapes come
// from the generated protocol types; the view types add only what the phone needs on top (optimistic
// sends). Everything here is plain JSON so a view can be persisted as is.
import type {
  ApprovalRequest,
  InputRequest,
  ItemStarted,
  JournalEvent,
  SessionChanged,
  SessionSummary,
  TurnBase,
  TurnError,
  Usage,
} from '../generated/events';

export type { JournalEvent, SessionSummary, Usage };

/** Session = SessionSummary plus settings (spec 5.1). */
export type Session = SessionChanged['session'];
export type SessionStatus = SessionSummary['status'];
export type Item = ItemStarted['item'];
export type ApprovalRequestBody = ApprovalRequest['request'];
export type InputRequestBody = InputRequest['request'];
export type Decision = ApprovalRequestBody['availableDecisions'][number];
export type InputPart = Extract<Item, { type: 'userMessage' }>['content'][number];

/**
 * A turn as the Replica shows it. Host turns carry the spec 5.1 statuses; an optimistic turn created by
 * sendMessage is `sending` until the host's turn arrives, or `failed_to_send` when the host refused it.
 */
export interface TurnView {
  turnId: string;
  status: TurnBase['status'] | 'sending' | 'failed_to_send';
  startedAt: number;
  completedAt: number | null;
  error: TurnError | null;
  itemsTruncated?: boolean;
  items: string[];
  /** Set on optimistic turns only. */
  optimistic?: {
    clientMessageId: string;
    /** The host's turnId from the turn/start result, once known. */
    hostTurnId?: string;
    error?: TurnError & { data?: Record<string, unknown> };
  };
  /** Unknown fields from the host are kept (spec 12). */
  [key: string]: unknown;
}

export interface SessionView {
  sessionId: string;
  /** Full session (with settings) once opened; null until then. */
  session: Session | null;
  status: SessionStatus;
  /** The cursor: seq of the last applied Journal event. Meaningful only when `loaded`. */
  cursor: number;
  /** True once a snapshot or events-mode open gave this view a state the cursor refers to. */
  loaded: boolean;
  /** Oldest first; optimistic turns sit at the end until reconciled. */
  turns: TurnView[];
  items: Record<string, Item>;
  approvals: Record<string, ApprovalRequestBody>;
  inputs: Record<string, InputRequestBody>;
  usage: Usage | null;
  /** Opaque cursor for session/history, from the last snapshot. */
  olderCursor?: string;
  closedReason?: string;
}

export function emptyView(sessionId: string, summary?: SessionSummary): SessionView {
  return {
    sessionId,
    session: null,
    status: summary?.status ?? 'idle',
    cursor: 0,
    loaded: false,
    turns: [],
    items: {},
    approvals: {},
    inputs: {},
    usage: null,
  };
}
