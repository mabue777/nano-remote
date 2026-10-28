import { test as base } from '@playwright/test';

import { hostPort, hostRules } from './ports';

// The specs import `test` from here instead of @playwright/test: the same test, with baseURL (pages,
// the `request` fixture, browser.newContext()) and the browser's host mapping pointed at this worker's
// own fake host and provider (ports.ts), so workers never share a host's state.
export * from '@playwright/test';

export const test = base.extend<object, { workerHostPort: number }>({
  workerHostPort: [async ({}, use, workerInfo) => use(hostPort(workerInfo.parallelIndex)), { scope: 'worker' }],
  launchOptions: [
    async ({ launchOptions }, use, workerInfo) => {
      await use({ ...launchOptions, args: [`--host-rules=${hostRules(workerInfo.parallelIndex)}`] });
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ workerHostPort }, use) => use(`http://127.0.0.1:${workerHostPort}`),
});
