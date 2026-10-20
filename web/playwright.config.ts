import { defineConfig } from '@playwright/test';

// Smoke test: serve the built app (host/public, written by `vite build`) and load the index page.
// Phase 2 replaces the static preview server with Nano Host itself.
const origin = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  forbidOnly: true,
  reporter: 'list',
  use: {
    baseURL: origin,
    headless: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
    url: origin,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
