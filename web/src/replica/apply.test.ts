import { describe, expect, it } from 'vitest';

import { SID, agentItem, approval, ev, inputRequest, session, snapshot, turn, userItem } from '../../test/replica-fixtures';
import { applyEvent, isOptimisticId, optimisticId, reconcile, replaceWithSnapshot } from './apply';
import { emptyView, type SessionView, type TurnView } from './types';

function optimistic(view: SessionView, clientMessageId: string, hostTurnId?: string): void {
  const id = optimisticId(clientMessageId);
  view.items[id] = { itemId: id, type: 'userMessage', turnId: id, status: 'inProgress', content: [], clientMessageId };
  view.turns.push({
    turnId: id,
    status: 'sending',
    startedAt: 0,
    completedAt: null,
    error: null,
    items: [id],
    optimistic: { clientMessageId, ...(hostTurnId ? { hostTurnId } : {}) },
  } as TurnView);
}

describe('applyEvent (spec 5.2)', () => {
  it('builds turns and items from turn and item events and moves the cursor', () => {
    const view = emptyView(SID);
    applyEvent(view, ev(1, 'turn/started', { turn: turn('t1') }));
    applyEvent(view, ev(2, 'item/started', { turnId: 't1', item: agentItem('i1', 't1') }));
    applyEvent(view, ev(3, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'Hel' }));
    applyEvent(view, ev(4, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'text', delta: 'lo' }));
    applyEvent(view, ev(5, 'item/delta', { turnId: 't1', itemId: 'i1', field: 'summary', delta: 'new field' }));
    applyEvent(view, ev(6, 'item/delta', { turnId: 't1', itemId: 'nope', field: 'text', delta: 'lost' }));
    expect(view.items.i1).toMatchObject({ text: 'Hello', summary: 'new field' });
    applyEvent(view, ev(7, 'item/completed', { turnId: 't1', item: agentItem('i1', 't1', 'Hello!', { status: 'completed' }) }));
    applyEvent(view, ev(8, 'turn/completed', { turn: turn('t1', { status: 'completed', completedAt: 20, items: ['i1', 'i2'] }) }));
    expect(view.items.i1).toMatchObject({ text: 'Hello!', status: 'completed' });
    expect(view.turns).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed', completedAt: 20, items: ['i1', 'i2'] })]);
    expect(view.cursor).toBe(8);
  });

  it('creates a stub turn for an item whose turn it has not seen', () => {
    const view = emptyView(SID);
    applyEvent(view, ev(1, 'item/started', { turnId: 'tX', item: agentItem('i1', 'tX') }));
    applyEvent(view, ev(2, 'item/completed', { turnId: 'tX', item: agentItem('i1', 'tX', 'done') }));
    expect(view.turns).toEqual([expect.objectContaining({ turnId: 'tX', status: 'inProgress', items: ['i1'] })]);
  });

  it('tracks session, status, pending requests, usage and closing', () => {
    const view = emptyView(SID);
    applyEvent(view, ev(1, 'status/changed', { status: 'running' }));
    expect(view.status).toBe('running');
    applyEvent(view, ev(2, 'session/changed', { session: session({ title: 'Renamed', status: 'running' }) }));
    applyEvent(view, ev(3, 'status/changed', { status: 'waiting_approval' }));
    expect(view.session).toMatchObject({ title: 'Renamed', status: 'waiting_approval' });
    applyEvent(view, ev(4, 'approval/request', { request: approval('r1') }));
    applyEvent(view, ev(5, 'input/request', { request: inputRequest('r2') }));
    expect(Object.keys(view.approvals)).toEqual(['r1']);
    expect(Object.keys(view.inputs)).toEqual(['r2']);
    applyEvent(view, ev(6, 'request/resolved', { requestId: 'r1', kind: 'command', resolvedBy: 'dev', decision: 'accept' }));
    applyEvent(view, ev(7, 'request/resolved', { requestId: 'r2', kind: 'input', resolvedBy: 'dev', answers: {} }));
    expect(view.approvals).toEqual({});
    expect(view.inputs).toEqual({});
    applyEvent(view, ev(8, 'usage/updated', { usage: { inputTokens: 5, outputTokens: 6 } }));
    expect(view.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
    applyEvent(view, ev(9, 'session/closed', { reason: 'archived' }));
    expect(view).toMatchObject({ status: 'closed', closedReason: 'archived', session: { status: 'closed' } });
    const bare = emptyView(SID);
    applyEvent(bare, ev(1, 'session/closed', { reason: 'deleted' }));
    expect(bare.status).toBe('closed');
  });

  it('ignores methods it does not know, except for the cursor (spec 12)', () => {
    const view = emptyView(SID);
    applyEvent(view, ev(1, 'future/thing', { x: 1 }));
    expect(view.cursor).toBe(1);
    expect(view.turns).toEqual([]);
  });

  it('puts host turns before optimistic turns', () => {
    const view = emptyView(SID);
    optimistic(view, 'm1');
    applyEvent(view, ev(1, 'turn/started', { turn: turn('t1') }));
    expect(view.turns.map((t) => t.turnId)).toEqual(['t1', 'local:m1']);
  });
});

describe('replaceWithSnapshot (spec 6)', () => {
  it('replaces turns, items and pending, keeps unreconciled optimistic turns, takes the cursor', () => {
    const view = emptyView(SID);
    applyEvent(view, ev(1, 'turn/started', { turn: turn('old') }));
    view.approvals.stale = approval('stale');
    optimistic(view, 'keep');
    optimistic(view, 'echoed');
    view.closedReason = 'x';
    replaceWithSnapshot(
      view,
      snapshot(40, [{ ...turn('t9', { status: 'completed' }), items: [agentItem('i1', 't9', 'hi'), userItem('u1', 't9', 'echoed')] }], {
        pending: { approvals: [approval('r1')], inputs: [inputRequest('r2')] },
        olderCursor: 'older-1',
      }),
    );
    expect(view.turns.map((t) => t.turnId)).toEqual(['t9', 'local:keep']);
    expect(view.turns[0]!.items).toEqual(['i1', 'u1']);
    expect(Object.keys(view.items).sort()).toEqual(['i1', 'local:keep', 'u1']);
    expect(Object.keys(view.approvals)).toEqual(['r1']);
    expect(Object.keys(view.inputs)).toEqual(['r2']);
    expect(view).toMatchObject({ cursor: 40, loaded: true, olderCursor: 'older-1', status: 'idle' });
    expect(view.closedReason).toBeUndefined();
  });
});

describe('reconcile (spec 7)', () => {
  it('drops an optimistic turn when its host turn (by turnId from the turn/start result) is in the view', () => {
    const view = emptyView(SID);
    optimistic(view, 'm1', 't1');
    expect(reconcile(view)).toBe(false);
    applyEvent(view, ev(1, 'turn/started', { turn: turn('t1') }));
    expect(reconcile(view)).toBe(true);
    expect(view.turns.map((t) => t.turnId)).toEqual(['t1']);
    expect(view.items['local:m1']).toBeUndefined();
  });

  it('drops it when the userMessage item echoing its clientMessageId arrives', () => {
    const view = emptyView(SID);
    optimistic(view, 'm1');
    applyEvent(view, ev(1, 'item/started', { turnId: 't1', item: userItem('u1', 't1', 'other') }));
    expect(reconcile(view)).toBe(false);
    applyEvent(view, ev(2, 'item/started', { turnId: 't1', item: userItem('u2', 't1', 'm1') }));
    expect(reconcile(view)).toBe(true);
  });

  it('drops it when the host turn itself carries the clientMessageId', () => {
    const view = emptyView(SID);
    optimistic(view, 'm1');
    applyEvent(view, ev(1, 'turn/started', { turn: turn('t1', { clientMessageId: 'm1' }) }));
    expect(reconcile(view)).toBe(true);
    expect(reconcile(view)).toBe(false);
  });

  it('optimistic ids are recognisable', () => {
    expect(isOptimisticId(optimisticId('x'))).toBe(true);
    expect(isOptimisticId('itm_1')).toBe(false);
  });
});
