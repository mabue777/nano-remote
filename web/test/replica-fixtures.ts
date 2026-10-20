// Small builders for Replica tests: sessions, turns, items and Journal events for one session.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const SID = 'ses_1';

export function session(over: Record<string, unknown> = {}): any {
  return {
    sessionId: SID,
    agentId: 'codex',
    title: 'Create hello.txt',
    cwd: '/work',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    lastSeq: 0,
    pending: { approvals: 0, inputs: 0 },
    settings: { model: 'gpt-5-codex' },
    ...over,
  };
}

export function summary(over: Record<string, unknown> = {}): any {
  const { settings: _settings, ...rest } = session(over);
  return rest;
}

export function turn(turnId: string, over: Record<string, unknown> = {}): any {
  return { turnId, status: 'inProgress', startedAt: 10, completedAt: null, error: null, items: [], ...over };
}

export function agentItem(itemId: string, turnId: string, text = '', over: Record<string, unknown> = {}): any {
  return { itemId, type: 'agentMessage', turnId, status: 'inProgress', text, ...over };
}

export function userItem(itemId: string, turnId: string, clientMessageId?: string): any {
  return {
    itemId,
    type: 'userMessage',
    turnId,
    status: 'completed',
    content: [{ type: 'text', text: 'hi' }],
    ...(clientMessageId ? { clientMessageId } : {}),
  };
}

export function approval(requestId: string, turnId = 't1'): any {
  return {
    requestId,
    kind: 'command',
    sessionId: SID,
    turnId,
    itemId: 'i9',
    createdAt: 1,
    expiresAt: null,
    command: 'ls',
    cwd: '/work',
    reason: 'May I?',
    availableDecisions: ['accept', 'decline'],
  };
}

export function inputRequest(requestId: string): any {
  return { requestId, kind: 'input', sessionId: SID, turnId: 't1', itemId: 'i8', isBlocking: true, questions: [] };
}

export function ev(seq: number, method: string, params: Record<string, unknown> = {}, sessionId = SID): any {
  return { method, params: { sessionId, seq, ...params } };
}

export function snapshot(cursor: number, turns: any[] = [], over: Record<string, unknown> = {}): any {
  return {
    mode: 'snapshot',
    session: session({ lastSeq: cursor }),
    turns,
    cursor,
    pending: { approvals: [], inputs: [] },
    ...over,
  };
}

export function eventsResult(events: any[], cursor: number, over: Record<string, unknown> = {}): any {
  return { mode: 'events', session: session({ lastSeq: cursor }), events, cursor, pending: { approvals: [], inputs: [] }, ...over };
}
