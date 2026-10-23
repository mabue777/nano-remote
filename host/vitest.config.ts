import { defineConfig } from 'vitest/config';

// `pnpm test` (and the verify gate) runs plain tests. `pnpm test:coverage` adds v8 coverage and fails
// when the Journal or the envelope stream drops below 95%, or the session core, the Codex adapter, the Claude
// adapter, the pi adapter, the HTTPS server, pairing, the device store, Web Push or the provider relay below 90%, on any metric. Tests (the live
// Codex and Claude tests included) and testing/ helpers are not measured.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
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
        'src/http/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/pairing/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/devices/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/push/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/providers/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
