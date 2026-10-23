import { defineConfig } from 'vitest/config';

// `pnpm test` (and the verify gate) runs plain tests. `pnpm test:coverage` adds v8 coverage and fails
// when the Journal or the envelope stream drops below 95%, or the session core, the Codex adapter, the Claude
// adapter, the pi adapter, the adapters' shared plumbing, the HTTPS server, pairing, the device store, Web Push, the provider relay, keep-awake or attachments below 90%, on any metric. Tests (the live
// Codex and Claude tests included) and testing/ helpers are not measured.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Generous limits for a busy machine: coverage instrumentation plus load slows tests several-fold, and
    // vitest's 5 s / 10 s defaults timed out unrelated tests at load average 9-12. Tests that assert timing
    // (a timeout firing, a delay elapsing) set their own short durations and are unaffected.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.test.ts', 'src/**/testing/**'],
      reporter: [['text', { skipFull: false }]],
      thresholds: {
        'src/journal/**': { lines: 95, branches: 95, functions: 95, statements: 95 },
        'src/stream/**': { lines: 95, branches: 95, functions: 95, statements: 95 },
        'src/core/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/adapters/codex/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/adapters/claude/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/adapters/pi/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/adapters/shared/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/http/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/pairing/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/devices/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/push/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/providers/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/power/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/attachments/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
