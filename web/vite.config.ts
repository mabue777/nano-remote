import { defineConfig } from 'vitest/config';

// Vite build + Vitest config in one file. The build lands in host/public so Nano Host can serve it.
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
    include: ['src/**/*.test.ts'],
  },
});
