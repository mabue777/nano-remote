import { defineConfig } from '@playwright/test';

// Smoke test against the fake host (test/e2e-server.ts): one origin that serves the built app
// (host/public, written by `vite build`), POST /v1/pair and the stream. Phone viewport, 390 x 844.
const port = 4173;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  forbidOnly: true,
  reporter: 'list',
  use: {
    baseURL: origin,
    headless: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node ./test/e2e-host.mjs',
    env: { E2E_PORT: String(port) },
    url: `${origin}/pair`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
