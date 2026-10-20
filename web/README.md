# web

The Nano Remote phone client: a TypeScript web app built by Vite into `host/public` and served by
Nano Host over the tailnet (ADR 0004). Added to the iPhone home screen, it gets Web Push from the
host (ADR 0005). This is the empty scaffold; Phase 2 of `docs/plan/roadmap.md` builds the real UI.

## Framework: Vite + Preact

Chosen over the other candidate (Vite + Svelte) and over React:

- **Small.** Preact is about 4 kB; the whole shell stays tiny, which matters on a phone over a
  tailnet and for the "renders instantly from the Replica" goal.
- **Plain TypeScript, no compiler dialect.** Components are `.tsx` files; `tsc --noEmit` checks
  them with no plugin. Svelte needs `svelte-check` and a second language the headless build
  engines handle less reliably.
- **Hooks and signals.** `preact/hooks` for local state now; `@preact/signals` is the natural fit
  for the Replica (fine-grained updates of a long, streaming session view) when Phase 2 needs it.
- **Ecosystem without React's weight.** React libraries work through `preact/compat` if ever
  needed; nothing in v1 needs them.
- **No SSR, no router framework.** The host serves static files; a hash or history router is a
  few lines when sessions get their own URLs.

The Vite config uses esbuild's automatic JSX runtime pointed at Preact instead of
`@preact/preset-vite`, so there is no Babel in the toolchain. Add the preset later only if
Prefresh (HMR that keeps component state) is wanted during development.

## Layout

- `index.html`, `src/main.tsx`, `src/app.tsx`: the app shell.
- `src/generated/`: protocol types generated from `protocol/schema/*.json` by
  `host/scripts/generate-types.mjs`; gitignored, regenerated on every verify, never hand-edited.
- `src/**/*.test.ts`: vitest unit tests (node environment; add `happy-dom` when a test needs the DOM).
- `e2e/smoke.spec.ts`: Playwright smoke test. It starts `vite preview` on the build output
  (`host/public`) and checks the index page renders. Phase 2 points it at Nano Host instead.

## Commands (from the repo root)

```
pnpm -C web dev          # dev server with HMR
pnpm -C web typecheck    # tsc --noEmit
pnpm -C web test         # vitest run
pnpm -C web build        # vite build -> host/public
pnpm -C web smoke        # playwright test (needs a build and the chromium browser)
pnpm -C web verify       # generate + typecheck + test + build + smoke; the gate
```

Playwright needs its chromium once: `pnpm -C web exec playwright install chromium`
(`scripts/bootstrap.sh` does this; `scripts/verify.sh` does it only when the browser is missing).
