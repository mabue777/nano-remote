// Live: the relay against the real Ollama on this Mac. Runs only with NANO_LIVE_OLLAMA=1; never in the
// gate (it needs Ollama running).
//
//   NANO_LIVE_OLLAMA=1 pnpm -C host exec vitest run src/providers/live.test.ts
//
// Lists the models of http://127.0.0.1:11434 through the relay and runs "Find local servers" on this
// Mac's own addresses; prints both. With NANO_LIVE_OLLAMA_MODEL=<local model> it also streams one short
// chat (cloud models need an ollama.com login, so no model is chosen by default).
import { describe, expect, it } from 'vitest';

import { discover } from './discover.js';
import { ProviderRelay } from './relay.js';

const LIVE = process.env.NANO_LIVE_OLLAMA === '1';
const MODEL = process.env.NANO_LIVE_OLLAMA_MODEL;
const OLLAMA = 'http://127.0.0.1:11434';

describe.skipIf(!LIVE)('live Ollama through the relay', () => {
  const relay = new ProviderRelay();

  it('lists the models of http://127.0.0.1:11434', async () => {
    const models = await relay.models(relay.resolve({ baseURL: OLLAMA }));
    console.log(`provider/models ${OLLAMA} -> ${models.length} models:\n${models.map((m) => `  ${m.id}`).join('\n')}`);
    expect(models.length).toBeGreaterThan(0);
  });

  it('finds Ollama among the local servers', async () => {
    const started = Date.now();
    const candidates = await discover();
    console.log(`provider/discover (${Date.now() - started} ms) -> ${JSON.stringify(candidates)}`);
    expect(candidates).toContainEqual({ baseURL: OLLAMA, kind: 'ollama' });
  }, 30_000);

  it.skipIf(MODEL === undefined)('streams a short chat', async () => {
    const deltas: string[] = [];
    const outcome = await relay.chat(
      relay.resolve({ baseURL: OLLAMA }),
      { model: MODEL!, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], options: { maxTokens: 64 } },
      { delta: (kind, text) => deltas.push(`${kind}:${text}`), usage: (u) => console.log('usage', u) },
      new AbortController().signal,
    );
    console.log(`provider/chat ${MODEL} -> ${JSON.stringify(outcome)}; ${deltas.length} deltas: ${deltas.join('').slice(0, 200)}`);
    expect(outcome.status).toBe('completed');
  }, 120_000);
});
