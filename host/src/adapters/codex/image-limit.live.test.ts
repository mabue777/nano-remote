// Live: the provider's image limit (Ollama Cloud: 60 images per conversation) against the real engine.
// Runs only with NANO_LIVE_CODEX=1; never in the gate (it spends real tokens on the operator's account).
//
//   NANO_LIVE_CODEX=1 pnpm -C host exec vitest run src/adapters/codex/image-limit.live.test.ts
//
// NANO_LIVE_CODEX_MODEL picks the model (default glm-5.3-flash:cloud, the model of the bricked sessions).
// Steps and the raw engine messages around each compaction go to $TMPDIR/nano-live-codex-images.log.
//
//   1. 50 tiny PNGs in one turn, then a turn without images: the adapter compacts first (avoid path).
//   2. 30 PNGs, then 31 PNGs: the second turn crosses 60 and the provider rejects it (recover path):
//      the turn either continues after a compaction or fails with image_limit, and the adapter stays usable.
//
// Run of 2026-10-29 (codex-cli 0.163.0-alpha.11.1, glm-5.3-flash:cloud): step 1 compacted before the turn
// (the engine runs the compaction as a turn of its own: turn/started, a contextCompaction item,
// turn/completed; no thread/compacted notification) and the turn after it completed. In step 2 the provider
// accepted all 61 identical PNGs, so the rejection did not come; the next turn compacted 61 images first
// and completed. The recover path is covered by the fake-engine tests in adapter.test.ts.
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AdapterEvent } from '../../core/adapter.js';
import { CodexAdapter } from './adapter.js';
import { codexConfig } from '../../config/codex.js';
import { until } from './testing/fake-codex.js';

const LIVE = process.env.NANO_LIVE_CODEX === '1';
const MODEL = process.env.NANO_LIVE_CODEX_MODEL ?? 'glm-5.3-flash:cloud';
const STEP_MS = 300_000;
const LOG_FILE = path.join(tmpdir(), 'nano-live-codex-images.log');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const started = Date.now();
function step(message: string): void {
  const line = `[images +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
}

const images = (n: number) => Array.from({ length: n }, () => ({ type: 'image' as const, url: PNG }));
const text = (value: string) => ({ type: 'text' as const, text: value });

describe.skipIf(!LIVE)('Codex image limit, live against the real engine and provider', () => {
  it(
    'compacts before the limit, and recovers or fails cleanly past it',
    async () => {
      const adapter = new CodexAdapter({ config: codexConfig(), log: (m) => step(`log: ${m}`) });
      // The raw engine messages, abbreviated (the instance field shadows the prototype method).
      const self = adapter as unknown as { onNotification: (method: string, params: Record<string, unknown>) => void };
      const original = self.onNotification.bind(adapter);
      self.onNotification = (method, params) => {
        if (!method.includes('delta') && method !== 'thread/tokenUsage/updated') {
          const item = params.item as { type?: string } | undefined;
          const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
          step(`  engine ${method}${item ? ` item=${item.type}` : ''}${turn ? ` turn=${turn.id} ${turn.status ?? ''} ${turn.error?.message ?? ''}` : ''}`);
        }
        original(method, params);
      };
      const events: AdapterEvent[] = [];
      adapter.onEvent((e) => {
        events.push(e);
        if (e.method === 'item/completed') step(`  host item ${e.params.item.type} ${JSON.stringify((e.params.item as { text?: string }).text ?? '').slice(0, 120)}`);
        if (e.method === 'turn/completed') step(`  host turn/completed ${JSON.stringify(e.params)}`);
      });
      const turns = () => events.filter((e): e is Extract<AdapterEvent, { method: 'turn/completed' }> => e.method === 'turn/completed');
      const run = async (label: string, input: Parameters<CodexAdapter['turnStart']>[0]) => {
        const before = turns().length;
        step(`${label}: turn/start with ${input.filter((p) => p.type === 'image').length} images`);
        await adapter.turnStart(input, `live-${label}`);
        await until(() => (turns().length > before ? true : undefined), `${label} end`, STEP_MS);
        return turns().at(-1)!.params;
      };

      try {
        const threadId = await adapter.start(mkdtempSync(path.join(tmpdir(), 'nano-live-images-')), { model: MODEL, sandbox: 'read-only' });
        step(`thread ${threadId} model ${MODEL}`);

        const one = await run('A1', [text('These are test images. Reply with the word OK only.'), ...images(50)]);
        step(`A1 -> ${JSON.stringify(one)}`);
        const two = await run('A2', [text('Reply with the word OK only.')]);
        step(`A2 -> ${JSON.stringify(two)}`);

        const three = await run('B1', [text('More test images. Reply with the word OK only.'), ...images(30)]);
        step(`B1 -> ${JSON.stringify(three)}`);
        const four = await run('B2', [text('More test images. Reply with the word OK only.'), ...images(31)]);
        step(`B2 -> ${JSON.stringify(four)}`);
        expect(four.status === 'completed' || four.error?.code === 'image_limit').toBe(true);

        const five = await run('B3', [text('Reply with the word OK only.')]);
        step(`B3 -> ${JSON.stringify(five)}`);
      } finally {
        await adapter.kill();
      }
    },
    STEP_MS * 6,
  );
});
