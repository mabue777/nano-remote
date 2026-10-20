// Test fixtures for the Journal: the protocol examples that carry Journal events, and builders for the
// events the examples do not cover. Builders return EventInput (no sessionId/seq; the Journal assigns them).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventInput, Item, JournalEvent, Turn } from '../types.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../protocol/examples');

const METHODS = new Set([
  'session/changed',
  'status/changed',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/delta',
  'item/completed',
  'approval/request',
  'input/request',
  'request/resolved',
  'usage/updated',
  'session/closed',
]);

interface Envelope {
  message?: { method?: string; params?: Record<string, unknown>; result?: { events?: JournalEvent[] } };
}

/** Every Journal event in protocol/examples, by file: notifications, plus events inside results. */
export function exampleEvents(): { file: string; event: JournalEvent }[] {
  const out: { file: string; event: JournalEvent }[] = [];
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith('.json')).sort()) {
    const envelope = JSON.parse(readFileSync(path.join(EXAMPLES, file), 'utf8')) as Envelope;
    const message = envelope.message;
    if (message?.method && METHODS.has(message.method)) {
      out.push({ file, event: { method: message.method, params: message.params } as JournalEvent });
    }
    for (const event of message?.result?.events ?? []) out.push({ file, event });
  }
  return out;
}

/** The example's event as an append input: `sessionId` and `seq` removed. */
export function asInput(event: JournalEvent): EventInput {
  const { sessionId: _s, seq: _q, ...params } = event.params;
  return { method: event.method, params } as EventInput;
}

export function sessionChanged(fields: { agentId?: string; title?: string; cwd?: string; settings?: Record<string, unknown> } = {}): EventInput {
  return {
    method: 'session/changed',
    params: {
      session: {
        sessionId: 'ignored',
        agentId: fields.agentId ?? 'codex',
        title: fields.title ?? 'A session',
        cwd: fields.cwd ?? '/tmp/project',
        status: 'idle',
        createdAt: 0,
        updatedAt: 0,
        lastSeq: 0,
        pending: { approvals: 0, inputs: 0 },
        settings: fields.settings ?? { model: 'gpt-5-codex' },
      },
    },
  };
}

export function turn(turnId: string, status: Turn['status'] = 'inProgress', extra: Partial<Turn> = {}): Turn {
  return {
    turnId,
    status,
    startedAt: 100,
    completedAt: status === 'inProgress' ? null : 200,
    error: null,
    items: [],
    ...extra,
  };
}

export function turnStarted(turnId: string): EventInput {
  return { method: 'turn/started', params: { turn: turn(turnId) } };
}

export function turnCompleted(turnId: string, status: 'completed' | 'interrupted' | 'failed' = 'completed'): EventInput {
  return { method: 'turn/completed', params: { turn: { ...turn(turnId), status, completedAt: 200 } } };
}

export function agentMessage(itemId: string, turnId: string, text = '', status: Item['status'] = 'inProgress'): Item {
  return { itemId, type: 'agentMessage', turnId, status, text };
}

export function itemStarted(item: Item): EventInput {
  return { method: 'item/started', params: { turnId: item.turnId, item } };
}

export function itemCompleted(item: Item): EventInput {
  return { method: 'item/completed', params: { turnId: item.turnId, item } };
}

export function itemDelta(
  itemId: string,
  turnId: string,
  delta: string,
  field: 'text' | 'summary' | 'output' | 'patch' = 'text',
): EventInput {
  return { method: 'item/delta', params: { itemId, turnId, field, delta } };
}

export function approvalRequest(requestId: string, turnId = 'trn_1'): EventInput {
  return {
    method: 'approval/request',
    params: {
      request: {
        requestId,
        kind: 'command',
        sessionId: 'ses_1',
        turnId,
        itemId: 'itm_cmd',
        createdAt: 150,
        expiresAt: null,
        command: 'echo hi',
        cwd: '/tmp/project',
        reason: 'May I?',
        availableDecisions: ['accept', 'decline'],
      },
    },
  };
}

export function inputRequest(requestId: string, turnId = 'trn_1'): EventInput {
  return {
    method: 'input/request',
    params: {
      request: {
        requestId,
        kind: 'input',
        sessionId: 'ses_1',
        turnId,
        itemId: 'itm_q',
        isBlocking: true,
        questions: [{ id: 'q1', header: 'Pick', question: 'Which one?', isOther: false, isSecret: false }],
      },
    },
  };
}

export function requestResolved(
  requestId: string,
  kind: 'command' | 'fileChange' | 'permission' | 'input' = 'command',
  resolvedBy = 'dev_a',
): EventInput {
  return {
    method: 'request/resolved',
    params:
      kind === 'input'
        ? { requestId, kind, resolvedBy, answers: { q1: ['A'] } }
        : { requestId, kind, resolvedBy, decision: 'accept' },
  };
}

export function statusChanged(status: 'idle' | 'running' | 'waiting_approval' | 'waiting_input' | 'error' | 'closed'): EventInput {
  return { method: 'status/changed', params: { status } };
}
