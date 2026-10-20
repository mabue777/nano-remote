// Errors the Journal throws. Each carries the protocol error code (protocol-v1.md section 10) the
// envelope server maps it to, so callers translate without string matching.

export class JournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * The Journal no longer holds `cursor + 1` (compacted away), or the cursor is ahead of the head.
 * Either way the client must re-open in snapshot mode (spec 6, `events/since`).
 */
export class CursorExpired extends JournalError {
  readonly sessionId: string;
  readonly cursor: number;
  /** Lowest seq the Journal still holds minus one: every cursor >= floor (and <= head) is servable. */
  readonly floor: number;
  readonly head: number;

  constructor(sessionId: string, cursor: number, floor: number, head: number) {
    super(
      'cursor_expired',
      `cursor ${cursor} for session ${sessionId} is outside the Journal (holds ${floor + 1}..${head})`,
    );
    this.sessionId = sessionId;
    this.cursor = cursor;
    this.floor = floor;
    this.head = head;
  }
}

/** A second `request/resolved` for the same request: the first resolution won (spec 5.3). */
export class AlreadyResolved extends JournalError {
  readonly requestId: string;
  readonly resolvedBy: string;

  constructor(requestId: string, resolvedBy: string) {
    super('already_resolved', `request ${requestId} was already resolved by ${resolvedBy}`);
    this.requestId = requestId;
    this.resolvedBy = resolvedBy;
  }
}

/** Malformed input from a caller: bad cursor, unknown method, non-object params. */
export class InvalidParams extends JournalError {
  constructor(message: string) {
    super('invalid_params', message);
  }
}
