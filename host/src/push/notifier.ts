// Decides, per client, which Journal events become a Web Push (protocol-v1.md section 9, ADR 0005), and
// sends them through the PushSender. The rules copy the captured behavior (runtime-capture N1 to N3):
//
//   approval/request, input/request   always, even while connected (iOS drops the socket ~30 s after lock)
//   turn/completed (final status)     only when the client has no open stream at that moment
//   status/changed to error           only when the client has no open stream at that moment
//   request/resolved, anything else   never
//
//   const notifier = new PushNotifier({ subscriptions: devices.push, presence, sender, title });
//   const core = new HostCore({ ..., onJournalEvent: (event) => notifier.handle(event) });
//
// Each stored subscription (one per client) is evaluated separately: with two phones, one connected, a
// finished turn pushes to the other one only.
//
// "At that moment" is literal: presence is read synchronously when the event is appended, and there is no
// grace window. A phone that was disconnected when the turn finished gets the push even if it reconnects
// a second later (it then sees the completion twice: once as a notification, once on the stream); a phone
// that was connected gets none even if it disconnects right after. Pending requests are replayed through
// `session/open`, so nothing is lost either way.
//
// Off the append path: `handle` only reads in-memory presence and queues the rest with setImmediate, so a
// slow or hanging push service never delays the Journal or the stream.
//
// Results: `gone` (404, 410) deletes the subscription. `failed` and `error` are logged and dropped. GAP:
// there is no retry queue in Phase 3, so a push lost to a network blip or a 5xx stays lost; the pending
// replay on reconnect covers requests, a completion is simply not announced.
//
// Payloads are `{title, body, url}` only: the title is the session title cut to one line of at most 60
// characters, the body a fixed phrase. No command text, path, item content or error message is ever sent.
// The url is `/s/<sessionId>`, the session route of the web app (SESSION in web/src/routes/router.ts).
import type { JournalEvent } from '../journal/types.js';
import type { PresenceRegistry } from '../stream/presence.js';
import { PUSH_TTL, type PushPayload, type PushSender, type SendOptions, type SendResult } from './sender.js';
import type { PushSubscriptionStore, StoredPushSubscription } from './subscriptions.js';

/** Longest title a push carries. */
export const MAX_PUSH_TITLE = 60;
/** Title when the session has none (or it is blank). */
export const FALLBACK_TITLE = 'Nano Host';

export const PUSH_BODY = {
  approval: 'Approval needed',
  input: 'Question waiting',
  completed: 'Turn finished',
  failed: 'Turn failed',
  interrupted: 'Turn interrupted',
  error: 'Session error',
} as const;

/** What one event pushes, before the per-client presence check. */
export interface PushPlan {
  kind: 'approval' | 'input' | 'completion' | 'error';
  sessionId: string;
  body: string;
  topic: string;
  ttl: number;
  /** True: only clients without an open stream get it. */
  onlyDisconnected: boolean;
}

/** The rules table (spec 9) as a pure function: undefined means the event never pushes. */
export function planFor(event: JournalEvent): PushPlan | undefined {
  const sessionId = event.params.sessionId;
  switch (event.method) {
    case 'approval/request':
      return {
        kind: 'approval',
        sessionId,
        body: PUSH_BODY.approval,
        topic: event.params.request.requestId,
        ttl: PUSH_TTL.approval,
        onlyDisconnected: false,
      };
    case 'input/request':
      return {
        kind: 'input',
        sessionId,
        body: PUSH_BODY.input,
        topic: event.params.request.requestId,
        ttl: PUSH_TTL.approval,
        onlyDisconnected: false,
      };
    case 'turn/completed': {
      const { status, turnId } = event.params.turn;
      if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') return undefined;
      return { kind: 'completion', sessionId, body: PUSH_BODY[status], topic: turnId, ttl: PUSH_TTL.completion, onlyDisconnected: true };
    }
    case 'status/changed':
      if (event.params.status !== 'error') return undefined;
      return { kind: 'error', sessionId, body: PUSH_BODY.error, topic: sessionId, ttl: PUSH_TTL.completion, onlyDisconnected: true };
    default:
      return undefined;
  }
}

/** One line, at most MAX_PUSH_TITLE characters (an ellipsis marks a cut). */
export function pushTitle(title: string | undefined): string {
  const line = (title ?? '').replace(/\s+/g, ' ').trim();
  if (line.length === 0) return FALLBACK_TITLE;
  const chars = [...line];
  return chars.length <= MAX_PUSH_TITLE ? line : `${chars.slice(0, MAX_PUSH_TITLE - 1).join('').trimEnd()}…`;
}

export interface PushNotifierLogFields {
  clientId: string;
  kind: PushPlan['kind'];
  outcome: SendResult['outcome'];
  statusCode?: number;
  reason?: string;
}

export interface PushNotifierOptions {
  subscriptions: Pick<PushSubscriptionStore, 'list' | 'deleteByEndpoint'>;
  presence: Pick<PresenceRegistry, 'connectedClients'>;
  sender: Pick<PushSender, 'send'>;
  /** The session's title (the push title before the one-line cut). */
  title: (sessionId: string) => string | undefined;
  /** False for an unknown or revoked device; such a client never gets a push. Default: every client. */
  isPaired?: (clientId: string) => boolean;
  /** `push.expired` (a gone subscription was deleted) and `push.dropped` (failed or error). ClientId only. */
  log?: (event: 'push.expired' | 'push.dropped', fields: PushNotifierLogFields) => void;
  /** Runs the deferred send work. Default setImmediate. */
  schedule?: (work: () => void) => void;
}

export class PushNotifier {
  private readonly log: NonNullable<PushNotifierOptions['log']>;
  private readonly schedule: (work: () => void) => void;
  private readonly isPaired: (clientId: string) => boolean;
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: PushNotifierOptions) {
    this.log = options.log ?? (() => {});
    this.schedule = options.schedule ?? ((work) => void setImmediate(work));
    this.isPaired = options.isPaired ?? (() => true);
  }

  /** Called for every appended Journal event. Never throws and never waits on the network. */
  handle(event: JournalEvent): void {
    if (this.closed) return;
    const plan = planFor(event);
    if (!plan) return;
    // Presence is read now, not when the deferred work runs: the rule is "no open stream at that moment".
    // The registry is in memory; the subscription list (a database read) waits for the deferred work.
    const connectedNow = plan.onlyDisconnected ? new Set(this.options.presence.connectedClients()) : new Set<string>();
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    this.inFlight.add(done);
    this.schedule(() => {
      this.deliver(plan, connectedNow)
        .catch(() => {})
        .finally(() => {
          this.inFlight.delete(done);
          resolve();
        });
    });
  }

  /** Resolves when every queued and running send has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Stops taking new events; sends already queued still run. */
  close(): Promise<void> {
    this.closed = true;
    return this.idle();
  }

  private async deliver(plan: PushPlan, connectedNow: ReadonlySet<string>): Promise<void> {
    const targets = this.options.subscriptions
      .list()
      .filter((stored) => this.isPaired(stored.clientId) && !connectedNow.has(stored.clientId));
    if (targets.length === 0) return;
    const payload: PushPayload = {
      title: pushTitle(this.options.title(plan.sessionId)),
      body: plan.body,
      url: `/s/${encodeURIComponent(plan.sessionId)}`,
    };
    const sendOptions: SendOptions = { ttl: plan.ttl, topic: plan.topic };
    await Promise.all(targets.map((stored) => this.sendOne(plan, stored, payload, sendOptions)));
  }

  private async sendOne(plan: PushPlan, stored: StoredPushSubscription, payload: PushPayload, sendOptions: SendOptions): Promise<void> {
    let result: SendResult;
    try {
      result = await this.options.sender.send(stored.clientId, stored.subscription, payload, sendOptions);
    } catch {
      result = { outcome: 'error', reason: 'network' };
    }
    if (result.outcome === 'delivered') return;
    const fields: PushNotifierLogFields = { clientId: stored.clientId, kind: plan.kind, outcome: result.outcome };
    if ('status' in result) fields.statusCode = result.status;
    else fields.reason = result.reason;
    if (result.outcome === 'gone') {
      this.options.subscriptions.deleteByEndpoint(stored.subscription.endpoint);
      this.log('push.expired', fields);
    } else {
      this.log('push.dropped', fields);
    }
  }
}
