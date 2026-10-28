import { defineConfig } from '@playwright/test';

import { hostPort, hostRules } from './e2e/ports';

// Smoke test against the fake host (test/e2e-server.ts): one origin that serves the built app
// (host/public, written by `vite build`), POST /v1/pair and the stream. Phone viewport, 390 x 844.
// The fake model provider (test/fake-provider.ts) listens with https on the next port; the browser maps
// its two public names there and accepts its self-signed certificate, so the app calls it directly
// (ADR 0006: https on a public host). The OpenAI preset's host, api.openai.com, is mapped there too
// (with the port), so pasting an OpenAI key in Settings > Providers reaches the fake.
//
// Spec files run in parallel, one per worker at a time. Each worker has its own fake host and provider
// (e2e/ports.ts: worker n on 4173 + 2n and the next port); the specs import `test` from
// e2e/worker-host.ts, which points baseURL and the browser's host mapping at that worker's pair. The fake
// host keeps state across a file's tests (resets, scripted failures), so a host is never shared.
// E2E_WORKERS overrides the count (1 runs everything on 4173 / 4174 as before).
const workers = Number(process.env.E2E_WORKERS ?? 4);
if (!Number.isInteger(workers) || workers < 1) throw new Error(`E2E_WORKERS must be a positive integer, got ${process.env.E2E_WORKERS}`);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers,
  forbidOnly: true,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${hostPort(0)}`, // per worker in e2e/worker-host.ts
    headless: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
    launchOptions: {
      // One flag: with --host-resolver-rules also present, Chromium ignored --host-rules (measured).
      // Per worker in e2e/worker-host.ts.
      args: [`--host-rules=${hostRules(0)}`],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: Array.from({ length: workers }, (_, index) => ({
    command: 'node ./test/e2e-host.mjs',
    env: { E2E_PORT: String(hostPort(index)) },
    url: `http://127.0.0.1:${hostPort(index)}/pair`,
    reuseExistingServer: false,
    timeout: 30_000,
  })),
});
