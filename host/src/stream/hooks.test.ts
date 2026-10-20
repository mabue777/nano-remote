// The request context hooks the session core relies on: after-response callbacks (live delivery starts
// only after a response, spec 6) and the stream's notification opt-outs (spec 4).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_MESSAGE_BYTES, MethodRegistry, RpcError, StreamServer } from './index.js';
import { TestClient } from './testing/client.js';

let server: StreamServer | undefined;
let client: TestClient | undefined;

afterEach(async () => {
  client?.close();
  await server?.close();
  server = client = undefined;
});

const INIT = {
  protocolVersion: 1,
  host: { hostId: 'h', name: 'h', version: '0', os: 'darwin', arch: 'arm64' },
  device: { clientId: 'dev_test', displayName: 'T' },
  agents: [],
  push: { vapidPublicKey: 'k', subscribed: false },
  limits: { maxMessageBytes: MAX_MESSAGE_BYTES, snapshotTurns: 5 },
};

describe('request context hooks', () => {
  it('runs after-response hooks after the response, also for errors, and logs hooks that throw', async () => {
    const log = vi.fn();
    const seenOptOut: boolean[] = [];
    const registry = new MethodRegistry()
      .register('initialize', () => INIT)
      .register('session/close', async (_params, context) => {
        context.afterResponse(() => {
          throw new Error('hook bug');
        });
        context.afterResponse(() => server!.notifyStream(context.streamId, 'session/updated', { after: true }));
        seenOptOut.push(context.isOptedOut('item/delta'), context.isOptedOut('turn/started'));
        await Promise.resolve();
        return { ok: true as const };
      })
      .register('session/archive', (_params, context) => {
        context.afterResponse(() => server!.notifyStream(context.streamId, 'session/updated', { afterError: true }));
        throw new RpcError('not_found', 'no such session');
      });
    server = new StreamServer({ authenticate: () => 'dev_test', registry, log });
    await server.listen();
    client = await TestClient.connect(server.url);
    await client.handshake({ optOutNotifications: ['item/delta'] });

    const id = client.request('session/close', { sessionId: 's' });
    await client.until(() => client!.messages.find((m) => m.method === 'session/updated'));
    const responseAt = client.messages.findIndex((m) => m.id === id);
    const notifyAt = client.messages.findIndex((m) => m.method === 'session/updated');
    expect(responseAt).toBeGreaterThanOrEqual(0);
    expect(notifyAt).toBe(responseAt + 1);
    expect(seenOptOut).toEqual([true, false]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('after-response hook of session/close failed'), expect.any(Error));

    const failed = client.request('session/archive', { sessionId: 's' });
    await client.until(() => client!.messages.find((m) => (m.params as { afterError?: boolean } | undefined)?.afterError));
    const errorAt = client.messages.findIndex((m) => m.id === failed);
    expect(client.messages[errorAt]).toMatchObject({ error: { code: 'not_found' } });
    expect((client.messages[errorAt + 1]!.params as { afterError: boolean }).afterError).toBe(true);
  });
});
