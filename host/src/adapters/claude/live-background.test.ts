// Live: the Claude adapter's background-task mapping against the real engine (the Claude Code executable
// bundled with the Claude Agent SDK). Runs only with NANO_LIVE_CLAUDE=1; never in the gate (it needs the
// operator's login and spends real tokens, on haiku, with tiny prompts).
//
//   NANO_LIVE_CLAUDE=1 pnpm -C host exec vitest run src/adapters/claude/live-background.test.ts
//
// One session: a turn launches a background subagent that runs a 60 s fixture script; the adapter must
// publish it (title from the description), then its activity (system/task_progress); a second message is
// taken while it runs (input/taken); a third keeps the main thread busy and is stopped, which must report
// the subagent cancelled. Steps go to $NANO_LIVE_CLAUDE_LOG (default $TMPDIR/nano-live-claude.log).
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AdapterEvent } from '../../core/adapter.js';
import type { BackgroundTask } from '../../generated/common.js';
import { ClaudeAdapter } from './adapter.js';
import { until } from './testing/fake-query.js';

const LIVE = process.env.NANO_LIVE_CLAUDE === '1';
const STEP_MS = 120_000;
const started = Date.now();
const LOG_FILE = process.env.NANO_LIVE_CLAUDE_LOG ?? path.join(tmpdir(), 'nano-live-claude.log');
function step(message: string): void {
  const line = `[live claude background +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
}

let adapter: ClaudeAdapter | undefined;
afterAll(async () => {
  await adapter?.kill();
});

describe.skipIf(!LIVE)('Claude adapter background tasks, live against the real engine', () => {
  it(
    'launch, activity, a message taken while it runs, Stop cancels it',
    async () => {
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'nano-live-bg-')));
      writeFileSync(path.join(cwd, 'wait.sh'), 'for i in 1 2 3 4 5 6; do echo tick $i; sleep 10; done\necho finished\n');
      const events: AdapterEvent[] = [];
      adapter = new ClaudeAdapter({ log: (m) => !m.startsWith('claude stderr') && step(`  engine: ${m.slice(0, 200)}`) });
      adapter.onEvent((event) => {
        events.push(event);
        if (event.method !== 'item/delta') step(`event ${event.method} ${JSON.stringify(event.params).slice(0, 300)}`);
      });
      const tasks = (): BackgroundTask[] => {
        const last = events.filter((e) => e.method === 'background/changed').at(-1);
        return last?.method === 'background/changed' ? last.params.tasks : [];
      };
      const turnEnds = () => events.filter((e) => e.method === 'turn/completed').length;

      await adapter.start(cwd, { model: 'haiku', approvalMode: 'never' });
      await adapter.turnStart(
        [
          {
            type: 'text',
            text:
              'Use the Agent tool with run_in_background set to true and description "wait for the fixture". The subagent prompt: ' +
              '"Run the Bash command `bash wait.sh` in the foreground (it takes about 60 seconds; it is a deliberate test fixture), then reply DONE." ' +
              'After launching it, reply with just the word LAUNCHED and end your turn. Do not wait for it.',
          },
        ],
        randomUUID(),
      );
      await until(() => (turnEnds() >= 1 ? true : undefined), 'the launching turn', STEP_MS);
      const launched = await until(() => tasks().find((t) => t.status === 'running'), 'a running task', STEP_MS);
      step(`launched ${JSON.stringify(launched)}`);
      expect(launched.title).toBe('wait for the fixture');

      const active = await until(() => tasks().find((t) => t.lastActivity !== undefined), 'its activity', STEP_MS);
      step(`activity "${active.lastActivity}"`);

      const second = randomUUID();
      const sentAt = Date.now();
      await adapter.turnStart([{ type: 'text', text: 'Reply with just the word PONG.' }], second);
      await until(() => events.find((e) => e.method === 'input/taken' && e.params.clientMessageId === second), 'input/taken', STEP_MS);
      step(`second message taken after ${Date.now() - sentAt} ms; task still ${tasks()[0]?.status}`);
      await until(() => (turnEnds() >= 2 ? true : undefined), 'the second turn', STEP_MS);
      expect(tasks()[0]?.status).toBe('running');

      await adapter.turnStart([{ type: 'text', text: 'Run the Bash command `bash wait.sh` in the foreground now, then reply DONE.' }], randomUUID());
      await until(() => events.find((e) => e.method === 'item/started' && (e.params.item as { type: string }).type === 'command'), 'the busy main thread', STEP_MS);
      const stopAt = Date.now();
      await adapter.interrupt();
      await until(() => (turnEnds() >= 3 ? true : undefined), 'the stopped turn', STEP_MS);
      const cancelled = await until(() => tasks().find((t) => t.status !== 'running'), 'the task ended', STEP_MS);
      step(`after Stop (${Date.now() - stopAt} ms): ${JSON.stringify(cancelled)}`);
      expect(cancelled.status).toBe('cancelled');
    },
    6 * STEP_MS,
  );
});
