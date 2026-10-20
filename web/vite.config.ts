import { defineConfig } from 'vitest/config';

// Vite build + Vitest config in one file. The build lands in host/public so Nano Host can serve it.
// `pnpm test` runs the tests; `pnpm test:coverage` (and the verify gate) adds v8 coverage and fails when
// the stream client, the Replica, the router or the screen view models drop below 90% on any metric. The fake host in test/ is not measured.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: '../host/public',
    emptyOutDir: true,
    sourcemap: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/stream/**/*.ts', 'src/replica/**/*.ts', 'src/routes/**/*.ts', 'src/screens/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: [['text', { skipFull: false }]],
      thresholds: {
        'src/stream/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/replica/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        // The router and the screens' view models; the .tsx components are covered by the Playwright smoke.
        'src/routes/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/screens/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
