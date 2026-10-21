// The four `thread/tokenUsage/updated` notifications of the 2026-10-21 field check session
// (docs/plan/field-checks.md, defect 3), two turns of Codex on Ollama `kimi-k3:cloud`.
//
// Source: the engine's rollout file for thread 01a15da1-fd4d-7f53-9243-ef7b77dddee9
// (~/.config/codex/sessions/2026/10/21/rollout-2026-10-21T10-44-19-….jsonl, `token_count` events), in the
// camelCase app-server shape of docs/research/rea/codex-app-server-schema/v2/ThreadTokenUsageUpdatedNotification.json.
// The host Journal of the same session holds the mapped `usage/updated` events at the same points.
//
// What it shows:
// - Codex sends one notification per model request, so several per turn, not only at turn end.
// - `total` sums every request of the thread; each request re-sends the conversation, so total input
//   grows by the context size per request (15,625 -> 32,495 -> 49,451 -> 66,646).
// - `last` is the latest request alone; its `totalTokens` is what fills the context window
//   (15,701 -> 16,938 -> 17,156 -> 17,217 of 996,147: 1.6% -> 1.7%).
// - Turn 2's first request ended in a command that waited 22 s for approval. Codex recorded that request's
//   usage at 08:49:00.878 but sent the notification only at 08:49:22.927, after the command finished. So
//   while an approval is pending the latest numbers are the previous request's.

const THREAD = '01a15da1-fd4d-7f53-9243-ef7b77dddee9';
const TURN_1 = '01a15da2-026b-7f03-999b-5cb604c96a78';
const TURN_2 = '01a15da6-4064-77e2-8061-b5fe393cd533';
const WINDOW = 996147;

const breakdown = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  inputTokens,
  cachedInputTokens,
  cacheWriteInputTokens: 0,
  outputTokens,
  reasoningOutputTokens: 0,
  totalTokens: inputTokens + outputTokens,
});

const note = (turnId: string, total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) => ({
  method: 'thread/tokenUsage/updated',
  params: { threadId: THREAD, turnId, tokenUsage: { total, last, modelContextWindow: WINDOW } },
});

export const FIELD_CHECK_USAGE = [
  // Turn 1, request 1 and 2.
  note(TURN_1, breakdown(15625, 0, 76), breakdown(15625, 0, 76)),
  note(TURN_1, breakdown(32495, 1408, 144), breakdown(16870, 1408, 68)),
  // Turn 2, request 1 (sent after the approved command finished) and request 2.
  note(TURN_2, breakdown(49451, 18304, 344), breakdown(16956, 16896, 200)),
  note(TURN_2, breakdown(66646, 35456, 366), breakdown(17195, 17152, 22)),
] as const;

/** The protocol `Usage` each notification maps to; the Journal of the field check holds exactly these. */
export const FIELD_CHECK_MAPPED = [
  { inputTokens: 15625, outputTokens: 76, contextPercent: 1.6 },
  { inputTokens: 32495, outputTokens: 144, contextPercent: 1.7 },
  { inputTokens: 49451, outputTokens: 344, contextPercent: 1.7 },
  { inputTokens: 66646, outputTokens: 366, contextPercent: 1.7 },
] as const;
