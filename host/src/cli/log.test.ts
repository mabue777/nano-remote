import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, formatLine, redact } from './log.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('structured log', () => {
  it('writes one JSON line per event to stdout and the log file (0600)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nano-log-'));
    const file = path.join(dir, 'Logs', 'host.log');
    const out: string[] = [];
    const logger = createLogger({ file, stdout: { write: (t) => out.push(t) }, now: () => new Date('2026-10-20T18:00:00Z') });
    logger.info('host.start', { pid: 7 });
    logger.forModule('http')('http request failed', new Error('boom'));
    const expected = [
      '{"ts":"2026-10-20T18:00:00.000Z","level":"info","event":"host.start","pid":7}\n',
      '{"ts":"2026-10-20T18:00:00.000Z","level":"error","event":"http.log","message":"http request failed","error":{"name":"Error","message":"boom"}}\n',
    ];
    expect(out).toEqual(expected);
    expect(readFileSync(file, 'utf8')).toBe(expected.join(''));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('never writes tokens, codes, cookies or secrets, at any depth', () => {
    const line = formatLine('info', 'x', {
      deviceToken: 'tok-123',
      code: '12345678',
      pairingCode: '87654321',
      headers: { cookie: 'nano_device=abc', authorization: 'Bearer abc' },
      list: [{ secret: 's' }],
      clientId: 'dev_1',
      closeCode: 4010,
    });
    for (const secret of ['tok-123', '12345678', '87654321', 'nano_device=abc', 'Bearer abc', '"s"']) {
      expect(line).not.toContain(secret);
    }
    expect(JSON.parse(line)).toMatchObject({ clientId: 'dev_1', closeCode: 4010, deviceToken: '[redacted]', code: '[redacted]' });
  });

  it('keeps an error code but not an error object’s other fields', () => {
    const error = Object.assign(new Error('nope'), { code: 'ENOENT', token: 't' });
    expect(redact({ error })).toEqual({ error: { name: 'Error', message: 'nope', errorCode: 'ENOENT' } });
  });
});
