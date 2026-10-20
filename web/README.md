# web

The Nano Remote phone client: a TypeScript web app built by Vite into `host/public` and served by
Nano Host over the tailnet (ADR 0004). Added to the iPhone home screen, it gets Web Push from the
host (ADR 0005). Phase 2 of `docs/plan/roadmap.md` builds the UI; the first screens (pairing, home with
host status and the session list, new session, the session view with its composer) are in.

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

- `index.html`, `src/main.tsx`, `src/app.tsx`: the app shell (one StreamClient and Replica per paired device).
- `src/routes/router.ts`: a history router for `/pair`, `/` and `/s/:sessionId`. The host answers these
  paths with index.html; the pairing code stays in the fragment (`/pair#code=12345678`).
- `src/screens/`: one view model per screen (`*-model.ts`, plain classes with vitest tests) and the
  Preact components that render them (`*.tsx`, covered by the Playwright smoke). `device.ts` keeps the
  clientId from pairing in localStorage; the device token stays in the host's HttpOnly cookie.
  `src/screens/session/` is the session view: the turn list (live deltas, commands, file changes,
  reasoning, inline errors, older turns by `session/history`), the pending-request banner, and the
  composer (send with an optimistic turn, steer while a turn runs, interrupt).
- `src/generated/`: protocol types generated from `protocol/schema/*.json` by
  `host/scripts/generate-types.mjs`; gitignored, regenerated on every verify, never hand-edited.
- `src/**/*.test.ts`: vitest unit tests (node environment; add `happy-dom` when a test needs the DOM).
- `e2e/smoke.spec.ts`: Playwright smoke at 390 x 844. `playwright.config.ts` starts `test/e2e-host.mjs`,
  which loads `test/e2e-server.ts` through Vite: the built app (`host/public`), `POST /v1/pair` with
  single-use codes and a cookie, and the fake host (`test/fake-host.ts`) on `/v1/stream` with three
  scripted sessions paged by two. The smoke pairs, lands on home, sees the sessions, starts a session,
  and checks wrong, expired and reused codes. `e2e/session.spec.ts` drives the session view: the
  fake host paces scripted turns so deltas arrive one by one, and test hooks reset the sessions, start
  a turn, approve from "another device" and delay a reply (see the header of `test/e2e-server.ts`).

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
