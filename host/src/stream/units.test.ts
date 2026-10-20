// Unit tests for the pieces under the server: chunking, presence, the method registry and error mapping.
import { describe, expect, it, vi } from 'vitest';

import { CursorExpired, InvalidParams } from '../journal/errors.js';
import { ChunkError, MessageTooLarge, Reassembler, splitMessage } from './chunking.js';
import { CloseCode, MAX_MESSAGE_BYTES, SEGMENT_BYTES, SEND_SEGMENT_BYTES } from './constants.js';
import { PresenceRegistry } from './presence.js';
import { MethodRegistry, RpcError, toErrorBody, type RequestContext } from './router.js';

const segment = (fields: Partial<Parameters<Reassembler['push']>[0]> = {}) => ({
  segment_id: 0,
  segment_count: 1,
  message_size_bytes: 3,
  message_chunk_base64: Buffer.from('abc').toString('base64'),
  ...fields,
});

const codeOf = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as ChunkError).code;
  }
  return undefined;
};

describe('chunking', () => {
  it('leaves messages up to 100 KiB whole and splits larger ones into padding-free segments', () => {
    expect(splitMessage(Buffer.alloc(SEGMENT_BYTES))).toBeNull();
    const bytes = Buffer.alloc(SEGMENT_BYTES * 2 + 5, 7);
    const segments = splitMessage(bytes)!;
    expect(segments.map((s) => s.segment_id)).toEqual([0, 1, 2]);
    expect(segments.slice(0, -1).every((s) => !s.message_chunk_base64.endsWith('='))).toBe(true);
    expect(Buffer.from(segments.map((s) => s.message_chunk_base64).join(''), 'base64').equals(bytes)).toBe(true);
    expect(SEND_SEGMENT_BYTES % 3).toBe(0);
    expect(() => splitMessage(Buffer.alloc(MAX_MESSAGE_BYTES + 1))).toThrow(MessageTooLarge);
  });

  it('round-trips through the reassembler', () => {
    const text = JSON.stringify({ blob: 'x'.repeat(300_000) });
    const reassembler = new Reassembler();
    const segments = splitMessage(Buffer.from(text))!;
    const results = segments.map((s) => reassembler.push(s));
    expect(results.slice(0, -1)).toEqual([undefined, undefined]);
    expect(results.at(-1)).toBe(text);
    expect(reassembler.inProgress).toBe(false);
  });

  it('rejects broken sequences with the right close code', () => {
    expect(codeOf(() => new Reassembler().push(segment({ message_size_bytes: MAX_MESSAGE_BYTES + 1 })))).toBe(CloseCode.tooLarge);
    expect(codeOf(() => new Reassembler().push(segment({ segment_id: 1, segment_count: 2 })))).toBe(CloseCode.sequence);
    expect(codeOf(() => new Reassembler().push(segment({ message_size_bytes: SEGMENT_BYTES + 1 })))).toBe(CloseCode.sequence);

    const outOfOrder = new Reassembler();
    outOfOrder.push(segment({ segment_count: 3, message_size_bytes: 9 }));
    expect(codeOf(() => outOfOrder.push(segment({ segment_id: 2, segment_count: 3, message_size_bytes: 9 })))).toBe(CloseCode.sequence);

    const changedCount = new Reassembler();
    changedCount.push(segment({ segment_count: 3, message_size_bytes: 9 }));
    expect(codeOf(() => changedCount.push(segment({ segment_id: 1, segment_count: 4, message_size_bytes: 9 })))).toBe(CloseCode.sequence);

    const changedSize = new Reassembler();
    changedSize.push(segment({ segment_count: 3, message_size_bytes: 9 }));
    expect(codeOf(() => changedSize.push(segment({ segment_id: 1, segment_count: 3, message_size_bytes: 8 })))).toBe(CloseCode.sequence);

    const oversizedSegment = Buffer.alloc(SEGMENT_BYTES + 2).toString('base64');
    expect(codeOf(() => new Reassembler().push(segment({ message_size_bytes: 200_000, segment_count: 2, message_chunk_base64: oversizedSegment })))).toBe(
      CloseCode.tooLarge,
    );
    expect(codeOf(() => new Reassembler().push(segment({ message_size_bytes: 2 })))).toBe(CloseCode.sequence);
    expect(codeOf(() => new Reassembler().push(segment({ message_size_bytes: 4 })))).toBe(CloseCode.sequence);
  });
});

describe('presence registry', () => {
  it('counts a client connected while any stream is open and tracks per-stream state', () => {
    let now = 100;
    const presence = new PresenceRegistry(() => now);
    const events: [string, boolean][] = [];
    const off = presence.onChange((id, connected) => events.push([id, connected]));
    presence.onChange(() => {
      throw new Error('listener bug');
    });
    const a = {};
    const b = {};
    presence.open('dev', a);
    presence.open('dev', b);
    presence.identify('dev', a, 'stream-a');
    now = 200;
    presence.ping('dev', a, 'background');
    presence.ping('dev', {}, 'foreground');
    presence.identify('nobody', a, 'x');
    expect(presence.streams('dev')).toEqual([
      { streamId: 'stream-a', state: 'background', openedAt: 100, lastPingAt: 200 },
      { streamId: '', state: undefined, openedAt: 100, lastPingAt: undefined },
    ]);
    expect(presence.connectedClients()).toEqual(['dev']);
    presence.close('dev', a);
    presence.close('dev', a);
    presence.close('nobody', a);
    expect(presence.isConnected('dev')).toBe(true);
    presence.close('dev', b);
    expect(presence.isConnected('dev')).toBe(false);
    expect(presence.streams('dev')).toEqual([]);
    off();
    presence.open('dev', a);
    expect(events).toEqual([
      ['dev', true],
      ['dev', false],
    ]);
  });

  it('uses the wall clock by default', () => {
    const presence = new PresenceRegistry();
    presence.open('dev', {});
    expect(presence.streams('dev')[0]!.openedAt).toBeGreaterThan(0);
  });
});

describe('method registry and errors', () => {
  const context: RequestContext = {
    clientId: 'dev',
    streamId: 's',
    onClose: vi.fn(),
    afterResponse: vi.fn(),
    isOptedOut: () => false,
  };

  it('dispatches typed handlers, checks params and rejects duplicates and unknown methods', async () => {
    const registry = new MethodRegistry().register('session/close', (params) => {
      expect(params.sessionId).toBe('s1');
      return { ok: true as const };
    });
    expect(registry.has('session/close')).toBe(true);
    expect(() => registry.register('session/close', () => ({ ok: true as const }))).toThrow(/already registered/);
    await expect(registry.dispatch('session/close', { sessionId: 's1' }, context)).resolves.toEqual({ ok: true });
    await expect(registry.dispatch('nope', {}, context)).rejects.toMatchObject({ code: 'method_not_found' });
  });

  it('passes empty params when none are sent and refuses non-object results', async () => {
    const registry = new MethodRegistry()
      .register('agent/list', (params) => ({ agents: [], seen: params }) as never)
      .register('host/status', () => 'nope' as never);
    await expect(registry.dispatch('agent/list', undefined, context)).resolves.toEqual({ agents: [], seen: {} });
    await expect(registry.dispatch('host/status', undefined, context)).rejects.toThrow(/non-object/);
  });

  it('maps errors to section 10 bodies', () => {
    expect(toErrorBody(new RpcError('session_busy', 'busy', { turnId: 't' }))).toEqual({
      code: 'session_busy',
      message: 'busy',
      data: { turnId: 't' },
    });
    expect(toErrorBody(new RpcError('not_found', 'gone'))).toEqual({ code: 'not_found', message: 'gone' });
    expect(toErrorBody(RpcError.invalidParams('params.x', 'bad'))).toEqual({
      code: 'invalid_params',
      message: 'bad',
      data: { path: 'params.x' },
    });
    expect(toErrorBody(new CursorExpired('s', 9, 3, 5))).toMatchObject({ code: 'cursor_expired' });
    expect(toErrorBody(new InvalidParams('bad cursor'))).toEqual({
      code: 'invalid_params',
      message: 'bad cursor',
      data: { path: 'params' },
    });
    expect(toErrorBody(Object.assign(new Error('x'), { code: 'ENOENT' }))).toEqual({ code: 'internal', message: 'internal error' });
    expect(toErrorBody('thrown string')).toEqual({ code: 'internal', message: 'internal error' });
  });
});
