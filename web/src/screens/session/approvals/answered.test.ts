import { describe, expect, it } from 'vitest';

import { approvalAnswered, onDevice, placeByTurn, placeInTurn, questionAnswered } from './answered';

describe('answered line: approvals', () => {
  it('this device: the decision in one word, green for an approval, grey with a cross for a refusal', () => {
    expect(approvalAnswered({ by: 'me' }, 'accept')).toEqual({ text: 'Approved', tone: 'ok', mark: 'check' });
    expect(approvalAnswered({ by: 'me' }, 'acceptForSession')).toEqual({ text: 'Accepted for this session', tone: 'ok', mark: 'check' });
    expect(approvalAnswered({ by: 'me' }, 'decline')).toEqual({ text: 'Declined', tone: 'muted', mark: 'x' });
    expect(approvalAnswered({ by: 'me' }, 'cancel')).toEqual({ text: 'Turn cancelled', tone: 'muted', mark: 'x' });
    expect(approvalAnswered({ by: 'me' }, undefined)).toEqual({ text: 'Answered', tone: 'muted', mark: 'check' });
  });

  it('another device: the same words and the device, or "Answered on" when the decision is not known', () => {
    expect(approvalAnswered({ by: 'device', name: 'iPhone 15' }, 'accept')).toEqual({ text: 'Approved on iPhone 15', tone: 'ok', mark: 'check' });
    expect(approvalAnswered({ by: 'device', name: 'Mac' }, 'decline')).toEqual({ text: 'Declined on Mac', tone: 'muted', mark: 'x' });
    expect(approvalAnswered({ by: 'device' }, 'cancel').text).toBe('Turn cancelled on another device');
    expect(approvalAnswered({ by: 'device', name: 'Mac' }, undefined)).toEqual({ text: 'Answered on Mac', tone: 'muted', mark: 'check' });
  });

  it('the agent, an unknown resolver, and a request the host no longer waited for', () => {
    expect(approvalAnswered({ by: 'agent' }, 'cancel')).toEqual({ text: 'Withdrawn by the agent', tone: 'muted', mark: 'x' });
    expect(approvalAnswered({ by: 'unknown' }, undefined)).toEqual({ text: 'Answered on another device', tone: 'muted', mark: 'check' });
    expect(approvalAnswered({ by: 'gone' }, 'accept')).toEqual({ text: 'No longer waiting', tone: 'muted', mark: 'x' });
  });

  it('a blank device name reads "another device"', () => {
    expect(onDevice('  ')).toBe('on another device');
    expect(onDevice(undefined)).toBe('on another device');
    expect(onDevice(' iPad ')).toBe('on iPad');
  });
});

describe('answered line: questions', () => {
  it('this device: the answer itself', () => {
    expect(questionAnswered({ by: 'me' }, 'lab-fix')).toEqual({ text: 'lab-fix', tone: 'muted', mark: 'check' });
    expect(questionAnswered({ by: 'me' }, '')).toEqual({ text: 'Answered', tone: 'muted', mark: 'check' });
  });

  it('elsewhere: who answered, with the answer when request/resolved carried it', () => {
    expect(questionAnswered({ by: 'device', name: 'iPhone 15' }, 'main').text).toBe('Answered on iPhone 15: main');
    expect(questionAnswered({ by: 'device' }, '').text).toBe('Answered on another device');
    expect(questionAnswered({ by: 'agent' }, '').text).toBe('Answered by the agent');
    expect(questionAnswered({ by: 'unknown' }, '').text).toBe('Answered on another device');
    expect(questionAnswered({ by: 'gone' }, 'x')).toEqual({ text: 'No longer waiting', tone: 'muted', mark: 'x' });
  });
});

describe('where answered lines go', () => {
  const row = (requestId: string, turnId: string, itemId: string) => ({ requestId, turnId, itemId });

  it('in their turn, in answer order; a turn not on screen leaves them at the end', () => {
    const rows = [row('r1', 't1', 'i1'), row('r2', 't2', 'i5'), row('r3', 't1', 'i2'), row('r4', 't9', 'i9')];
    const placed = placeByTurn(rows, new Set(['t1', 't2']));
    expect(placed.byTurn.get('t1')!.map((r) => r.requestId)).toEqual(['r1', 'r3']);
    expect(placed.byTurn.get('t2')!.map((r) => r.requestId)).toEqual(['r2']);
    expect(placed.orphans.map((r) => r.requestId)).toEqual(['r4']);
  });

  it('after their item when it is shown, else at the end of the turn', () => {
    const rows = [row('r1', 't1', 'i1'), row('r2', 't1', 'i1'), row('r3', 't1', 'folded')];
    const placed = placeInTurn(rows, new Set(['i1', 'i2']));
    expect(placed.after.get('i1')!.map((r) => r.requestId)).toEqual(['r1', 'r2']);
    expect(placed.after.has('i2')).toBe(false);
    expect(placed.end.map((r) => r.requestId)).toEqual(['r3']);
  });
});
