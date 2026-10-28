// One fake host per Playwright worker (playwright.config.ts starts them; worker-host.ts points each worker
// at its own). Worker n (its parallelIndex, 0 .. workers-1, stable across worker restarts) gets the host
// on HOST_BASE + 2n and that host's fake model provider on the next port. Worker 0 keeps 4173 / 4174.
// E2E_HOST_BASE moves the whole block, so two checkouts can run their e2e at once (scripts/verify.sh
// reserves a free block per run).
//
// The specs keep naming the provider as https://api.fake-provider.test:4174 (and ollama.com:4174): the
// browser maps that name and port to the worker's own provider, so the URLs the app stores and shows stay
// the same in every worker.
export const HOST_BASE = Number(process.env.E2E_HOST_BASE ?? 4173);
if (!Number.isInteger(HOST_BASE) || HOST_BASE < 1024 || HOST_BASE > 65000) {
  throw new Error(`E2E_HOST_BASE must be a port number from 1024 to 65000, got ${process.env.E2E_HOST_BASE}`);
}
export const SPEC_PROVIDER_PORT = 4174;
/** provider-settings.spec.ts expects nothing to listen there; no worker may use it. */
const RESERVED_PORT = 4199;
/** Workers per block; verify.sh spaces its blocks this far apart (2 ports a worker). */
const MAX_WORKERS = 12;

export function hostPort(parallelIndex: number): number {
  if (parallelIndex >= MAX_WORKERS) throw new Error(`too many e2e workers: at most ${MAX_WORKERS}`);
  const port = HOST_BASE + 2 * parallelIndex;
  if (port === RESERVED_PORT || port + 1 === RESERVED_PORT) throw new Error(`e2e worker port ${port} or ${port + 1} is ${RESERVED_PORT}, which must stay unused`);
  return port;
}

/** Chromium's single --host-rules flag for a worker (first matching rule wins). */
export function hostRules(parallelIndex: number): string {
  const provider = `127.0.0.1:${hostPort(parallelIndex) + 1}`;
  return [
    `MAP api.fake-provider.test:${SPEC_PROVIDER_PORT} ${provider}`,
    `MAP ollama.com:${SPEC_PROVIDER_PORT} ${provider}`,
    // Any other port (provider-settings' unreachable one) stays on that port of this machine.
    'MAP api.fake-provider.test 127.0.0.1',
    'MAP ollama.com 127.0.0.1',
    // The OpenAI preset's host has no port in its URL, so it is mapped with one.
    `MAP api.openai.com ${provider}`,
  ].join(', ');
}
