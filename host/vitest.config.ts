import { defineConfig } from 'vitest/config';

// `pnpm test` (and the verify gate) runs plain tests. `pnpm test:coverage` adds v8 coverage and fails
// when the Journal or the envelope stream drops below 95% on any metric.
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
      },
    },
  },
});
