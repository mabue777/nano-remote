import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkClientEnvelope, checkInitializeParams, checkMessage, isNotification, isRequest, requestIdOf } from './guard.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../protocol/examples');
const examples = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, value: JSON.parse(readFileSync(path.join(EXAMPLES, name), 'utf8')) as Record<string, unknown> }));

const HEADER = { client_id: 'dev_1', stream_id: '7c1e4b2a-9d3f-4e8a-b1c6-2f5d8e0a9b71', seq_id: 1 };
const CHUNK = {
  ...HEADER,
  type: 'client_message_chunk',
  segment_id: 0,
  segment_count: 1,
  message_size_bytes: 3,
  message_chunk_base64: 'AAAA',
};

const path_ = (value: unknown) => {
  const result = checkClientEnvelope(value);
  return result.ok ? 'ok' : result.path;
};

describe('envelope guard', () => {
  it('accepts every client-to-host envelope in protocol/examples and rejects the host-to-client ones', () => {
    const clientTypes = new Set(['client_message', 'client_message_chunk', 'ping', 'client_closed', 'ack']);
    let checked = 0;
    for (const { name, value } of examples) {
      const result = checkClientEnvelope(value);
      expect(result.ok, name).toBe(clientTypes.has(value.type as string));
      if (value.type === 'client_message') expect(checkMessage(value.message).ok, name).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it.each([
    [null, ''],
    [[], ''],
    [{ ...HEADER }, 'type'],
    [{ ...HEADER, type: 'hello' }, 'type'],
    [{ ...HEADER, type: 'ping', state: 'foreground', client_id: '' }, 'client_id'],
    [{ ...HEADER, type: 'ping', state: 'foreground', stream_id: 'not-a-uuid' }, 'stream_id'],
    [{ ...HEADER, type: 'ping', state: 'foreground', seq_id: 0 }, 'seq_id'],
    [{ ...HEADER, type: 'ping', state: 'foreground', seq_id: 1.5 }, 'seq_id'],
    [{ ...HEADER, type: 'client_message' }, 'message'],
    [{ ...HEADER, type: 'ack', message: {} }, 'message'],
    [{ ...HEADER, type: 'client_closed', reason: 'bored' }, 'reason'],
    [{ ...HEADER, type: 'client_closed', reason: 3 }, 'reason'],
    [{ ...HEADER, type: 'ping', state: 1 }, 'state'],
    [{ ...CHUNK, segment_id: -1 }, 'segment_id'],
    [{ ...CHUNK, segment_count: 0 }, 'segment_count'],
    [{ ...CHUNK, message_size_bytes: 0 }, 'message_size_bytes'],
    [{ ...CHUNK, message_chunk_base64: 'AA' }, 'message_chunk_base64'],
    [{ ...CHUNK, message_chunk_base64: 'A'.repeat(136_540) }, 'message_chunk_base64'],
    [{ ...CHUNK, message_chunk_base64: '!!!!' }, 'message_chunk_base64'],
    [{ ...CHUNK, message_chunk_base64: 7 }, 'message_chunk_base64'],
    [{ ...CHUNK, message_size_bytes: 1e9 }, 'ok'],
    [{ ...HEADER, type: 'client_closed' }, 'ok'],
    [{ ...HEADER, type: 'ack', extra: true }, 'ok'],
  ])('envelope %j fails at %s', (value, expected) => {
    expect(path_(value)).toBe(expected);
  });
});

describe('message guard', () => {
  it.each([
    [{ id: 1, method: 'session/list' }, 'ok'],
    [{ id: 'a', result: {} }, 'ok'],
    [{ id: 'a', error: { code: 'internal', message: 'x' } }, 'ok'],
    [{ method: 'initialized' }, 'ok'],
    ['text', 'message'],
    [{ id: 1.5, method: 'x' }, 'message.id'],
    [{ id: true, method: 'x' }, 'message.id'],
    [{ id: 1, method: 7 }, 'message.method'],
    [{ id: 1, method: 'Upper' }, 'message.method'],
    [{ id: 1, method: 'x', result: {} }, 'message'],
    [{ method: 'x', error: {} }, 'message'],
    [{ id: 1, method: 'x', params: 'p' }, 'message.params'],
    [{}, 'message'],
    [{ id: 1 }, 'message'],
    [{ id: 1, result: {}, error: {} }, 'message'],
    [{ id: 1, result: [] }, 'message.result'],
    [{ id: 1, error: 'x' }, 'message.error'],
    [{ id: 1, error: { code: 1, message: 'x' } }, 'message.error'],
    [{ id: 1, error: { code: 'x' } }, 'message.error'],
  ])('message %j -> %s', (value, expected) => {
    const result = checkMessage(value);
    expect(result.ok ? 'ok' : result.path).toBe(expected);
  });

  it('classifies requests and notifications and extracts usable ids', () => {
    expect(isRequest({ id: 1, method: 'x' })).toBe(true);
    expect(isNotification({ id: 1, method: 'x' })).toBe(false);
    expect(isNotification({ method: 'x' })).toBe(true);
    expect(isRequest({ id: 1, result: {} })).toBe(false);
    expect(requestIdOf({ id: 'a' })).toBe('a');
    expect(requestIdOf({ id: 2 })).toBe(2);
    expect(requestIdOf({ id: 2.5 })).toBeUndefined();
    expect(requestIdOf('x')).toBeUndefined();
  });
});

describe('initialize params guard', () => {
  const client = { name: 'n', version: 'v', platform: 'p' };
  it.each([
    [{ protocolVersion: 1, client }, 'ok'],
    [{ protocolVersion: 1, client: { ...client, userAgent: 'ua' }, optOutNotifications: ['a'] }, 'ok'],
    [undefined, 'params'],
    [{ protocolVersion: 0, client }, 'params.protocolVersion'],
    [{ protocolVersion: '1', client }, 'params.protocolVersion'],
    [{ protocolVersion: 1 }, 'params.client'],
    [{ protocolVersion: 1, client: { ...client, platform: 3 } }, 'params.client.platform'],
    [{ protocolVersion: 1, client: { ...client, userAgent: 3 } }, 'params.client.userAgent'],
    [{ protocolVersion: 1, client, optOutNotifications: 'a' }, 'params.optOutNotifications'],
    [{ protocolVersion: 1, client, optOutNotifications: ['a', 2] }, 'params.optOutNotifications.1'],
  ])('params %j -> %s', (value, expected) => {
    const result = checkInitializeParams(value);
    expect(result.ok ? 'ok' : result.path).toBe(expected);
  });
});
