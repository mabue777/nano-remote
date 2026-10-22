// The chat engine's vocabulary (ADR 0006, provider-connection.md section 4): one async stream of unified
// events for both routes, whatever the vendor. Reasoning text is flagged, never mixed into the answer.
import type { ProviderErrorReason } from '../../generated/common';
import type { ProviderKind } from '../providers/types';

/** One turn sent to the model. */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Request shaping the caller may ask for; translated per vendor by the quirks table. */
export interface ChatOptions {
  /** The single thinking switch; undefined leaves the vendor's default. */
  thinking?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/** The part of a Provider record the engine needs (see providers/types.ts). */
export interface ChatProvider {
  id: string;
  name: string;
  baseURL: string;
  kind: ProviderKind;
}

/**
 * Why a chat failed: the relay's reasons (protocol section 15) plus `host_unavailable`, when the provider
 * runs through the Mac and no stream to it is open.
 */
export type ChatErrorReason = ProviderErrorReason | 'host_unavailable';

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The unified stream. Every chat ends with exactly one `done` or `error`, and nothing follows it.
 * `done` with status `aborted` means the caller's signal fired; text streamed before it stays valid.
 */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ({ type: 'usage' } & ChatUsage)
  | { type: 'done'; status: 'completed' | 'aborted' }
  | {
      type: 'error';
      reason: ChatErrorReason;
      /** One plain sentence for the user that names the provider. */
      message: string;
      /** The server's own words, for logs; never shown raw. */
      detail?: string;
      status?: number;
      retryAfterMs?: number;
    };

export type ChatErrorEvent = Extract<ChatEvent, { type: 'error' }>;
