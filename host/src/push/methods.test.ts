import { describe, expect, it } from 'vitest';

import { DeviceStore } from '../devices/store.js';
import { MethodRegistry, type RequestContext } from '../stream/router.js';
import { registerPushMethods } from './methods.js';

const context = (clientId: string): RequestContext => ({
  clientId,
  streamId: '00000000-0000-4000-8000-000000000000',
  onClose: () => {},
  afterResponse: () => {},
  isOptedOut: () => false,
});

describe('push methods', () => {
  it('a device revoked between authentication and push/subscribe gets unauthorized and stores nothing', async () => {
    const devices = new DeviceStore({ path: ':memory:' });
    const registry = registerPushMethods(new MethodRegistry(), { subscriptions: devices.push });
    const phone = devices.create({ displayName: 'Phone', platform: 'ios-web' }).device.clientId;
    devices.revoke(phone);
    const subscription = { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } };
    await expect(registry.dispatch('push/subscribe', { subscription }, context(phone))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    // Without a log option the handlers still work.
    expect(await registry.dispatch('push/unsubscribe', { endpoint: subscription.endpoint }, context(phone))).toEqual({ ok: true });
    expect(devices.push.list()).toEqual([]);
    devices.close();
  });
});
