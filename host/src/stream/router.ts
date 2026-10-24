// Message layer (spec 3, 10): a typed registry of client-to-host request methods and the error type
// handlers throw (defined in ../errors.ts, re-exported). The stream connection owns the ordering rules (initialize first); this file owns
// "which handler, which params type, which error shape".
import type * as m from '../generated/methods.js';
import { RpcError, type ErrorBody, type ErrorCode } from '../errors.js';
import type { Bad } from './guard.js';

// RpcError lives in ../errors.ts (adapters and core throw it without depending on the transport);
// re-exported here so existing importers keep working.
export { RpcError, type ErrorBody, type ErrorCode };

/** Params and result types per request method, from protocol/schema/methods.json (spec 4 to 9, 15). */
export interface MethodMap {
  initialize: { params: m.InitializeParams; result: m.InitializeResult };
  'host/status': { params: m.HostStatusParams; result: m.HostStatus };
  'host/settings/update': { params: m.HostSettingsUpdateParams; result: m.HostSettingsUpdateResult };
  'agent/list': { params: m.AgentListParams; result: m.AgentListResult };
  'model/list': { params: m.ModelListParams; result: m.ModelListResult };
  'fs/readDirectory': { params: m.FsReadDirectoryParams; result: m.FsReadDirectoryResult };
  'project/list': { params: m.ProjectListParams; result: m.ProjectListResult };
  'session/list': { params: m.SessionListParams; result: m.SessionListResult };
  'session/start': { params: m.SessionStartParams; result: m.SessionStartResult };
  'session/open': { params: m.SessionOpenParams; result: m.SessionOpenResult };
  'events/since': { params: m.EventsSinceParams; result: m.EventsSinceResult };
  'session/history': { params: m.SessionHistoryParams; result: m.SessionHistoryResult };
  'session/close': { params: m.SessionCloseParams; result: m.Ok };
  'session/archive': { params: m.SessionArchiveParams; result: m.Ok };
  'session/unarchive': { params: m.SessionUnarchiveParams; result: m.Ok };
  'session/delete': { params: m.SessionDeleteParams; result: m.Ok };
  'session/rename': { params: m.SessionRenameParams; result: m.Ok };
  'session/settings/update': { params: m.SessionSettingsUpdateParams; result: m.SessionSettingsUpdateResult };
  'turn/start': { params: m.TurnStartParams; result: m.TurnStartResult };
  'turn/steer': { params: m.TurnSteerParams; result: m.TurnSteerResult };
  'turn/interrupt': { params: m.TurnInterruptParams; result: m.Ok };
  'turn/diff': { params: m.TurnDiffParams; result: m.TurnDiffResult };
  'approval/resolve': { params: m.ApprovalResolveParams; result: m.Ok };
  'input/answer': { params: m.InputAnswerParams; result: m.Ok };
  'device/list': { params: m.DeviceListParams; result: m.DeviceListResult };
  'device/revoke': { params: m.DeviceRevokeParams; result: m.Ok };
  'device/rename': { params: m.DeviceRenameParams; result: m.Ok };
  'push/subscribe': { params: m.PushSubscribeParams; result: m.Ok };
  'push/unsubscribe': { params: m.PushUnsubscribeParams; result: m.Ok };
  'push/test': { params: m.PushTestParams; result: m.Ok };
  'provider/list': { params: m.ProviderListParams; result: m.ProviderListResult };
  'provider/models': { params: m.ProviderModelsParams; result: m.ProviderModelsResult };
  'provider/chat': { params: m.ProviderChatParams; result: m.Ok };
  'provider/abort': { params: m.ProviderAbortParams; result: m.Ok };
  'provider/discover': { params: m.ProviderDiscoverParams; result: m.ProviderDiscoverResult };
}
export type MethodName = keyof MethodMap;

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'not_initialized',
  'unsupported_protocol',
  'unauthorized',
  'invalid_params',
  'method_not_found',
  'not_found',
  'session_busy',
  'turn_mismatch',
  'already_resolved',
  'cursor_expired',
  'agent_unavailable',
  'not_supported',
  'not_a_repository',
  'rate_limited',
  'provider_unavailable',
  'internal',
]);

/**
 * Maps anything a handler throws to an error body. RpcError passes through; errors that carry a known
 * protocol `code` (the Journal's errors do) keep it, with `invalid_params` getting a `data.path`;
 * everything else is `internal` and its message stays in the host log, not on the wire.
 */
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof RpcError) return error.toBody();
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && KNOWN_CODES.has(error.code)) {
    const code = error.code as ErrorCode;
    const data = code === 'invalid_params' ? { path: 'params' } : undefined;
    return data ? { code, message: error.message, data } : { code, message: error.message };
  }
  return { code: 'internal', message: 'internal error' };
}

/** What a handler knows about the stream the request came from. */
export interface RequestContext {
  clientId: string;
  streamId: string;
  /** Registers cleanup for when the stream closes (spec 6: closing the socket unsubscribes everything). */
  onClose(fn: () => void): void;
  /**
   * Runs `fn` right after this request's response (result or error) went out on the stream. Session
   * open uses it to start live delivery only after its response, so no event overtakes it (spec 6).
   * Hooks registered by the `initialize` handler are not run.
   */
  afterResponse(fn: () => void): void;
  /** True when the client named `method` in `optOutNotifications` at `initialize` (spec 4). */
  isOptedOut(method: string): boolean;
}

export type Handler<M extends MethodName> = (
  params: MethodMap[M]['params'],
  context: RequestContext,
) => MethodMap[M]['result'] | Promise<MethodMap[M]['result']>;

/** Optional params check; returns a Bad (path relative to the message, e.g. `params.sessionId`) or null. */
export type ParamsCheck = (params: unknown) => Bad | { ok: true; value: unknown };

interface Entry {
  handler: (params: unknown, context: RequestContext) => unknown;
  check: ParamsCheck | undefined;
}

/** Typed method registry. Unregistered methods answer `method_not_found` (spec 3). */
export class MethodRegistry {
  private readonly entries = new Map<string, Entry>();

  register<M extends MethodName>(method: M, handler: Handler<M>, check?: ParamsCheck): this {
    if (this.entries.has(method)) throw new Error(`method ${method} is already registered`);
    this.entries.set(method, { handler: handler as Entry['handler'], check });
    return this;
  }

  has(method: string): boolean {
    return this.entries.has(method);
  }

  /** Runs a request and returns its result object; throws RpcError (or whatever the handler threw). */
  async dispatch(method: string, params: unknown, context: RequestContext): Promise<Record<string, unknown>> {
    const entry = this.entries.get(method);
    if (!entry) throw new RpcError('method_not_found', `unknown method ${method}`, { method });
    const input = params ?? {};
    if (entry.check) {
      const checked = entry.check(input);
      if (!checked.ok) throw RpcError.invalidParams(checked.path, checked.message);
    }
    const result = await entry.handler(input, context);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new Error(`handler for ${method} returned a non-object result`);
    }
    return result as Record<string, unknown>;
  }
}
