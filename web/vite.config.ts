import { defineConfig } from 'vitest/config';

import { installableShell } from './build/pwa';

// Vite build + Vitest config in one file. The build lands in host/public so Nano Host can serve it.
// `pnpm test` runs the tests; `pnpm test:coverage` (and the verify gate) adds v8 coverage and fails when
// the stream client, the Replica, the router, the screen view models or local chat drop below 90% on any metric. The fake host in test/ is not measured.
export default defineConfig({
  plugins: [installableShell()],
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
    // Generous limits for a busy machine (coverage plus load slows tests several-fold); tests that assert
    // timing set their own short durations.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'build/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/stream/**/*.ts', 'src/replica/**/*.ts', 'src/routes/**/*.ts', 'src/screens/**/*.ts', 'src/pwa/**/*.ts', 'src/chat/**/*.ts', 'build/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'build/**/*.test.ts'],
      reporter: [['text', { skipFull: false }]],
      thresholds: {
        'src/stream/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/replica/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        // The router and the screens' view models; the .tsx components are covered by the Playwright smoke.
        'src/routes/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/screens/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        // The service worker registration and the build step that writes the manifest, icons and sw.js.
        'src/pwa/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        // Local chat: the provider store, presets, URL rules and model probing; the chat engine and history.
        'src/chat/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'build/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
