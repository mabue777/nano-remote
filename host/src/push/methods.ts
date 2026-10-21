// Push methods on the stream (protocol-v1.md section 9): `push/subscribe`, `push/unsubscribe`, `push/test`.
// Every method acts on the stream's authenticated client; a clientId in params is never read.
import type { PushSubscription } from '../generated/common.js';
import { isObject } from '../stream/guard.js';
import { RpcError, type MethodRegistry } from '../stream/router.js';
import type { PushSubscriptionStore } from './subscriptions.js';

export interface PushMethodsOptions {
  subscriptions: PushSubscriptionStore;
  /** Event name and clientId only: the endpoint and keys are capabilities and are never logged. */
  log?: (event: string, clientId: string) => void;
}

type Params = Record<string, unknown>;

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw RpcError.invalidParams(path, `${path} must be a non-empty string`);
  return value;
}

/** Checks `params.subscription` against common.json PushSubscription (endpoint, keys.p256dh, keys.auth). */
export function subscriptionOf(params: Params): PushSubscription {
  const value = params.subscription;
  if (!isObject(value)) throw RpcError.invalidParams('params.subscription', 'subscription must be an object');
  const endpoint = nonEmptyString(value.endpoint, 'params.subscription.endpoint');
  const keys = value.keys;
  if (!isObject(keys)) throw RpcError.invalidParams('params.subscription.keys', 'params.subscription.keys must be an object');
  const p256dh = nonEmptyString(keys.p256dh, 'params.subscription.keys.p256dh');
  const auth = nonEmptyString(keys.auth, 'params.subscription.keys.auth');
  return { endpoint, keys: { p256dh, auth } };
}

/** Registers the three push methods on the router and returns it. */
export function registerPushMethods(registry: MethodRegistry, options: PushMethodsOptions): MethodRegistry {
  const { subscriptions } = options;
  const log = options.log ?? (() => {});
  return registry
    .register('push/subscribe', (params, context) => {
      const subscription = subscriptionOf(params as Params);
      // The stream authenticated this client a moment ago; false means it was revoked in between.
      if (!subscriptions.subscribe(context.clientId, subscription)) {
        throw new RpcError('unauthorized', 'device revoked');
      }
      log('push.subscribed', context.clientId);
      return { ok: true as const };
    })
    .register('push/unsubscribe', (params, context) => {
      // The schema requires the endpoint; the host keeps one subscription per client and drops it whatever
      // the endpoint, so a browser that lost track of its old endpoint can still clean up.
      nonEmptyString((params as Params).endpoint, 'params.endpoint');
      subscriptions.unsubscribe(context.clientId);
      log('push.unsubscribed', context.clientId);
      return { ok: true as const };
    })
    .register('push/test', () => {
      // The sender (RFC 8291 encryption, VAPID JWT) comes in the next step of Phase 3.
      throw new RpcError('not_supported', 'push/test is not available yet');
    });
}
