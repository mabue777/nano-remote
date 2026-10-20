// Starts the Playwright smoke's host (e2e-server.ts) from plain Node. Node strips types but cannot run
// the fake host's TypeScript (parameter properties, extensionless imports), so Vite's module runner
// loads it, the same transform vitest uses.
import { fileURLToPath } from 'node:url';

import { runnerImport } from 'vite';

const port = Number(process.env.E2E_PORT ?? 4173);
const { module } = await runnerImport(fileURLToPath(new URL('./e2e-server.ts', import.meta.url)), {
  configFile: false,
  logLevel: 'error',
});
const started = await module.startE2eHost(port);
console.log(`e2e host on ${started.url}`);

const stop = () => {
  void started.close().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
