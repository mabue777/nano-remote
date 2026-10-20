import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSocket, HostScript } from '../../test/doubles';
import { bytesToBase64, utf8 } from './chunking';
import { CloseCode, DEFAULT_TIMING, MAX_MESSAGE_BYTES, MAX_UNACKED_ENVELOPES } from './constants';
import { EnvelopeStream, MessageTooLarge, type Presence, type StreamClose } from './envelope-stream';

const STREAM = 'stream-1';

function setup(presence: Presence = 'foreground') {
  const socket = new FakeSocket();
  const host = new HostScript(socket, STREAM);
  const messages: unknown[] = [];
  const pongs: string[] = [];
  const closes: StreamClose[] = [];
  let opened = 0;
  const stream = new EnvelopeStream({
    socket,
    clientId: 'dev_test',
    streamId: STREAM,
    timing: DEFAULT_TIMING,
    presence: () => presence,
    onOpen: () => {
      opened += 1;
    },
    onMessage: (m) => messages.push(m),
    onPong: (s) => pongs.push(s),
    onClose: (c) => closes.push(c),
  });
  return { socket, host, stream, messages, pongs, closes, opened: () => opened };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EnvelopeStream (spec 2)', () => {
  it('opens with a ping carrying presence, then numbers every sequence-consuming envelope from 1', () => {
    const { socket, stream, opened } = setup('background');
    expect(stream.send({ method: 'x' })).toBe(false); // not open yet
    socket.open();
    socket.open(); // a second open event changes nothing
    expect(opened()).toBe(1);
    expect(stream.open).toBe(true);
    stream.send({ id: 'c-1', method: 'initialize', params: {} });
    stream.ping('foreground');
    stream.send({ method: 'initialized' });
    expect(socket.sent.map((e) => [e.type, e.seq_id])).toEqual([
      ['ping', 1],
      ['client_message', 2],
      ['ping', 3],
      ['client_message', 4],
    ]);
    expect(socket.sent[0]).toEqual({ type: 'ping', client_id: 'dev_test', stream_id: STREAM, seq_id: 1, state: 'background' });
    expect(socket.sent[2].state).toBe('foreground');
    expect(socket.sent[1].message).toEqual({ id: 'c-1', method: 'initialize', params: {} });
  });

  it('pings every 30 s while open', () => {
    const { socket } = setup();
    socket.open();
    vi.advanceTimersByTime(DEFAULT_TIMING.pingIntervalMs * 2);
    expect(socket.ofType('ping')).toHaveLength(3);
  });

  it('acks batched: after 100 ms, or at once after 16 envelopes; an ack carries the highest seq_id', () => {
    const { socket, host, messages } = setup();
    socket.open();
    host.message({ method: 'a', params: {} });
    host.message({ method: 'b', params: {} });
    expect(socket.ofType('ack')).toHaveLength(0);
    vi.advanceTimersByTime(DEFAULT_TIMING.ackDelayMs);
    expect(socket.ofType('ack')).toEqual([{ type: 'ack', client_id: 'dev_test', stream_id: STREAM, seq_id: 2 }]);
    for (let i = 0; i < 16; i += 1) host.message({ method: 'n', params: {} });
    expect(socket.ofType('ack').map((a) => a.seq_id)).toEqual([2, 18]);
    vi.advanceTimersByTime(1000);
    expect(socket.ofType('ack')).toHaveLength(2); // nothing left to ack
    expect(messages).toHaveLength(18);
    // acks consume no seq_id: the next ping is still 2.
    vi.advanceTimersByTime(DEFAULT_TIMING.pingIntervalMs);
    expect(socket.ofType('ping').map((p) => p.seq_id)).toEqual([1, 2]);
  });

  it('forwards pongs and ignores binary frames and unknown envelope types', () => {
    const { socket, host, pongs, messages, closes } = setup();
    socket.open();
    host.pong(1, 'draining');
    socket.fire('message', { data: new Uint8Array([1, 2]) });
    host.raw({ type: 'future_thing', seq_id: 1 });
    expect(pongs).toEqual(['draining']);
    expect(messages).toEqual([]);
    expect(closes).toEqual([]);
  });

  it.each([
    ['a seq_id gap', (h: HostScript) => h.raw({ type: 'server_message', seq_id: 2, message: {} })],
    ['a repeated seq_id', (h: HostScript) => {
      h.message({ method: 'a' });
      h.raw({ type: 'server_message', seq_id: 1, message: {} });
    }],
    ['another stream_id', (h: HostScript) => h.raw({ type: 'server_message', seq_id: 1, stream_id: 'other', message: {} })],
    ['no seq_id', (h: HostScript) => h.raw({ type: 'server_message', message: {} })],
    ['no type', (h: HostScript) => h.raw({ seq_id: 1 })],
    ['an ack for an envelope never sent', (h: HostScript) => h.ack(9)],
    ['a message inside a chunked one', (h: HostScript) => {
      h.raw({ type: 'server_message_chunk', seq_id: 1, segment_id: 0, segment_count: 2, message_size_bytes: 10, message_chunk_base64: 'e30=' });
      h.raw({ type: 'server_message', seq_id: 2, message: {} });
    }],
    ['a broken chunk', (h: HostScript) =>
      h.raw({ type: 'server_message_chunk', seq_id: 1, segment_id: 1, segment_count: 2, message_size_bytes: 10, message_chunk_base64: 'e30=' })],
    ['a chunked message that is not JSON', (h: HostScript) =>
      h.raw({ type: 'server_message_chunk', seq_id: 1, segment_id: 0, segment_count: 1, message_size_bytes: 3, message_chunk_base64: bytesToBase64(utf8('{x}')) })],
  ])('closes with 4002 on %s', (_name, act) => {
    const { socket, host, closes } = setup();
    socket.open();
    act(host);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ code: CloseCode.sequence, byClient: true });
    expect(socket.closes[0]!.code).toBe(CloseCode.sequence);
  });

  it('closes with 4002 on a frame that is not JSON, and with 4009 on an oversized chunked message', () => {
    const a = setup();
    a.socket.open();
    a.socket.deliver('not json');
    expect(a.closes[0]!.code).toBe(CloseCode.sequence);
    const b = setup();
    b.socket.open();
    b.host.raw({ type: 'server_message_chunk', seq_id: 1, segment_id: 0, segment_count: 200, message_size_bytes: MAX_MESSAGE_BYTES + 1, message_chunk_base64: '' });
    expect(b.closes[0]!.code).toBe(CloseCode.tooLarge);
  });

  it('reassembles chunked server messages and acks every chunk', () => {
    const { socket, host, messages } = setup();
    socket.open();
    const message = { method: 'item/delta', params: { delta: 'x'.repeat(250_000) } };
    const bytes = utf8(JSON.stringify(message));
    const third = Math.ceil(bytes.length / 3 / 3) * 3;
    for (let i = 0; i < 3; i += 1) {
      host.raw({
        type: 'server_message_chunk',
        seq_id: i + 1,
        segment_id: i,
        segment_count: 3,
        message_size_bytes: bytes.length,
        message_chunk_base64: bytesToBase64(bytes.subarray(i * third, (i + 1) * third)),
      });
    }
    expect(messages).toEqual([message]);
    vi.advanceTimersByTime(DEFAULT_TIMING.ackDelayMs);
    expect(socket.ofType('ack').at(-1).seq_id).toBe(3);
  });

  it('sends messages above 100 KiB as consecutive chunks, each with its own seq_id', () => {
    const { socket, stream } = setup();
    socket.open();
    const message = { id: 'c-9', method: 'turn/start', params: { input: [{ type: 'text', text: 'y'.repeat(220_000) }] } };
    stream.send(message);
    const chunks = socket.ofType('client_message_chunk');
    expect(chunks.map((c) => [c.seq_id, c.segment_id, c.segment_count])).toEqual([
      [2, 0, 3],
      [3, 1, 3],
      [4, 2, 3],
    ]);
    const joined = Buffer.concat(chunks.map((c) => Buffer.from(c.message_chunk_base64, 'base64'))).toString('utf8');
    expect(JSON.parse(joined)).toEqual(message);
    expect(stream.backlog.unackedEnvelopes).toBe(3);
  });

  it('throws MessageTooLarge above 16 MiB and stays open', () => {
    const { socket, stream } = setup();
    socket.open();
    expect(() => stream.send({ blob: 'z'.repeat(MAX_MESSAGE_BYTES) })).toThrow(MessageTooLarge);
    expect(stream.open).toBe(true);
  });

  it('holds messages back while 256 envelopes are unacked and releases them in order on ack', () => {
    const { socket, host, stream } = setup();
    socket.open();
    for (let i = 0; i < MAX_UNACKED_ENVELOPES + 2; i += 1) stream.send({ method: 'n', params: { i } });
    expect(socket.messages).toHaveLength(MAX_UNACKED_ENVELOPES);
    expect(stream.backlog).toMatchObject({ unackedEnvelopes: MAX_UNACKED_ENVELOPES, waiting: 2 });
    host.ack(3); // acks the ping (1) and messages 2 and 3
    expect(socket.messages.map((m) => m.params.i).slice(-2)).toEqual([MAX_UNACKED_ENVELOPES, MAX_UNACKED_ENVELOPES + 1]);
    expect(stream.backlog.waiting).toBe(0);
    host.ack(3); // a repeated ack changes nothing
    expect(stream.backlog.unackedEnvelopes).toBe(MAX_UNACKED_ENVELOPES);
  });

  it('client_closed: flushes the pending ack, says goodbye with the next seq_id, closes 1000', () => {
    const { socket, host, stream, closes } = setup();
    socket.open();
    host.message({ method: 'a' });
    stream.clientClosed('background');
    expect(socket.sent.map((e) => e.type)).toEqual(['ping', 'ack', 'client_closed']);
    expect(socket.ofType('client_closed')[0]).toMatchObject({ seq_id: 2, reason: 'background' });
    expect(closes).toEqual([{ code: 1000, reason: 'client closed: background', byClient: true }]);
    stream.close(1000, 'again'); // idempotent
    stream.ping();
    stream.clientClosed('user');
    expect(closes).toHaveLength(1);
    expect(stream.send({})).toBe(false);
    socket.serverClose(1000);
    expect(closes).toHaveLength(1);
  });

  it('reports a close from the host once, with its code, and stops timers', () => {
    const { socket, host, closes } = setup();
    socket.open();
    host.message({ method: 'a' });
    socket.serverClose(4008, 'ping timeout');
    socket.serverClose(4008, 'again');
    expect(closes).toEqual([{ code: 4008, reason: 'ping timeout', byClient: false }]);
    vi.advanceTimersByTime(DEFAULT_TIMING.pingIntervalMs * 3);
    expect(socket.ofType('ping')).toHaveLength(1);
    expect(socket.ofType('ack')).toHaveLength(0);
    socket.deliver({ type: 'server_message', client_id: 'dev_test', stream_id: STREAM, seq_id: 2, message: {} });
  });

  it('treats a close event without a code as 1006, and survives a socket that refuses to close', () => {
    const a = setup();
    a.socket.fire('close', {});
    expect(a.closes[0]).toEqual({ code: 1006, reason: '', byClient: false });
    const b = setup();
    b.socket.closeThrows = true;
    b.stream.close(4002, 'x');
    expect(b.closes[0]).toMatchObject({ code: 4002, byClient: true });
  });
});
