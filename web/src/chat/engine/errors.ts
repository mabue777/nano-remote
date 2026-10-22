// One sentence per failure that names the provider and the fix (provider-connection.md section 3 step 4).
// Both routes end in the same sentences; the server's own text only goes to `detail`.
import { HOST_UNAVAILABLE_MESSAGE } from '../providers/probe';
import type { ChatErrorEvent, ChatErrorReason } from './types';

export { HOST_UNAVAILABLE_MESSAGE };

export function chatMessage(name: string, reason: ChatErrorReason, retryAfterMs?: number): string {
  switch (reason) {
    case 'host_unavailable':
      return HOST_UNAVAILABLE_MESSAGE;
    case 'unauthorized':
      return `${name} rejected the key. Check the key in Settings.`;
    case 'rate_limited':
      return retryAfterMs !== undefined && retryAfterMs > 0
        ? `${name} is rate limiting requests. Try again in ${Math.ceil(retryAfterMs / 1000)} s.`
        : `${name} is rate limiting requests. Wait a minute and try again.`;
    case 'unreachable':
      return `${name} is not reachable. Check the address and that the server is running.`;
    case 'timeout':
      return `${name} accepted the request but sent nothing back. Try again, or pick a smaller model.`;
    case 'not_found':
      return `${name} does not know this model. Pick another model.`;
    case 'bad_response':
      return `${name} sent a reply this app could not read.`;
    case 'upstream':
      return `${name} reported an error while answering. Try again.`;
  }
}

export function chatError(
  name: string,
  reason: ChatErrorReason,
  extra: { detail?: string; status?: number; retryAfterMs?: number } = {},
): ChatErrorEvent {
  const event: ChatErrorEvent = { type: 'error', reason, message: chatMessage(name, reason, extra.retryAfterMs) };
  if (extra.detail !== undefined && extra.detail !== '') event.detail = extra.detail;
  if (extra.status !== undefined) event.status = extra.status;
  if (extra.retryAfterMs !== undefined) event.retryAfterMs = extra.retryAfterMs;
  return event;
}

/** The relay's reason for an HTTP status that is an error. */
export function reasonForStatus(status: number): ChatErrorReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  // 410: Ollama Cloud answers it for a retired model (recorded 2026-10-22).
  if (status === 404 || status === 410) return 'not_found';
  return 'upstream';
}
