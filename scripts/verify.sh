#!/bin/sh
# Repo-wide verify gate for Nano Remote. Exit 0 only when every package is green.
#
#   1. protocol: python3 -I protocol/verify.py   (schemas, examples, negative cases)
#   2. types:    node host/scripts/generate-types.mjs (host/src/generated and web/src/generated, once)
#   3. at once:  host tsc, web tsc, web vite build (into host/public)
#   4. host:     vitest run, alone
#   5. web:      vitest run --coverage
#   6. web:      playwright test                  (the e2e smoke against the build, 4 workers)
#
# The same checks as `pnpm -C host verify` and `pnpm -C web verify`. Step 3 runs its three checks side by
# side (none reads another's output, none is timing-sensitive) with each one's output in a log printed
# when it ends. Host vitest runs alone: its adapter tests spawn real agent processes with 10 s start-up
# timeouts, which starve when other checks share a loaded machine. Any failure fails the gate (exit 1,
# or the check's own code) and skips the steps after it.
# The e2e reserves its own block of fake-host ports (lock dirs in /tmp), so gates in two checkouts can
# run at the same time.
# Built for a bare environment (no shell profile, launchd-style): PATH is set here, Homebrew first.
# No full reinstalls: dependencies are installed only when node_modules is missing, and then with a
# frozen lockfile. First-time setup (creates the lockfile, downloads chromium) is scripts/bootstrap.sh.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export CI=1
PYTHON=/Library/Frameworks/Python.framework/Versions/3.14/bin/python3
HOME=${HOME:-/tmp}
export HOME

START=$(date +%s)
step() {
  printf '\n== %s (%ss elapsed)\n' "$1" "$(( $(date +%s) - START ))"
}
die() {
  printf 'verify: %s\n' "$1" >&2
  exit 2
}

step "toolchain"
[ -x "$PYTHON" ] || die "python not found at $PYTHON"
command -v node >/dev/null 2>&1 || die "node not found on PATH=$PATH (brew install node)"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found on PATH=$PATH (brew install pnpm)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "node 22 or newer required, found $(node --version) at $(command -v node)"
printf 'node %s (%s), pnpm %s (%s), python %s\n' \
  "$(node --version)" "$(command -v node)" "$(pnpm --version)" "$(command -v pnpm)" "$("$PYTHON" --version)"

step "protocol: python3 -I protocol/verify.py"
"$PYTHON" -I protocol/verify.py

step "dependencies"
[ -f pnpm-lock.yaml ] || die "pnpm-lock.yaml is missing; run scripts/bootstrap.sh once and commit the lockfile"
if [ ! -d node_modules ] || [ ! -d host/node_modules ] || [ ! -d web/node_modules ]; then
  echo "node_modules missing; installing with a frozen lockfile"
  pnpm install --frozen-lockfile
else
  echo "node_modules present; install skipped"
fi

step "playwright chromium"
BROWSERS=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}
if ls -d "$BROWSERS"/chromium-* >/dev/null 2>&1; then
  echo "chromium present in $BROWSERS; install skipped"
else
  echo "chromium missing in $BROWSERS; installing"
  pnpm -C web exec playwright install chromium
fi

step "types: node host/scripts/generate-types.mjs"
node host/scripts/generate-types.mjs

step "host tsc, web tsc, web build (side by side)"
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/verify.XXXXXX")
PIDS=""
PORT_LOCK=""
cleanup() {
  rm -rf "$LOGS"
  [ -z "$PORT_LOCK" ] || rm -rf "$PORT_LOCK"
}
# On Ctrl-C or a kill from outside, take the side-by-side checks down too.
trap 'for pid in $PIDS; do pkill -TERM -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; done; cleanup; exit 130' INT TERM
trap cleanup EXIT
start() { # name, then the command; output goes to $LOGS/name.log
  name=$1
  shift
  ( "$@" >"$LOGS/$name.log" 2>&1; echo $? >"$LOGS/$name.status" ) &
  PIDS="$PIDS $!"
}
start host-tsc pnpm -C host exec tsc --noEmit -p tsconfig.json
start web-tsc pnpm -C web exec tsc --noEmit -p tsconfig.json
start web-build pnpm -C web exec vite build
wait
FAILED=0
for name in host-tsc web-tsc web-build; do
  status=$(cat "$LOGS/$name.status" 2>/dev/null || echo 1)
  printf '\n-- %s (exit %s)\n' "$name" "$status"
  cat "$LOGS/$name.log"
  [ "$status" = 0 ] || [ "$FAILED" != 0 ] || FAILED=$status
done
PIDS=""
if [ "$FAILED" != 0 ]; then
  printf '\nverify: a check above failed (exit %s); the remaining checks skipped\n' "$FAILED" >&2
  exit "$FAILED"
fi

step "host: vitest run (alone)"
pnpm -C host exec vitest run

step "web: vitest run --coverage"
pnpm -C web exec vitest run --coverage

step "e2e ports"
# Blocks 100 ports apart from 4173 (e2e/ports.ts: worker n on base + 2n and the next port). A block is
# taken with an atomic mkdir; a lock whose gate is gone is taken over. The block's ports must be free.
E2E_WORKERS=${E2E_WORKERS:-4}
export E2E_WORKERS
k=0
while [ "$k" -lt 20 ]; do
  base=$((4173 + 100 * k))
  lock=/tmp/nano-remote-e2e-ports-$base
  if ! mkdir "$lock" 2>/dev/null; then
    owner=$(cat "$lock/pid" 2>/dev/null || echo "")
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock"
      mkdir "$lock" 2>/dev/null || { k=$((k + 1)); continue; }
    else
      k=$((k + 1))
      continue
    fi
  fi
  echo $$ >"$lock/pid"
  if node -e '
    const net = require("node:net");
    const [base, count] = process.argv.slice(1).map(Number);
    const ports = Array.from({ length: count }, (_, i) => base + i);
    Promise.all(ports.map((port) => new Promise((ok, bad) => {
      const s = net.createServer().once("error", bad).listen(port, "127.0.0.1", () => s.close(ok));
    }))).then(() => process.exit(0), () => process.exit(1));
  ' "$base" $((2 * E2E_WORKERS)); then
    PORT_LOCK=$lock
    break
  fi
  rm -rf "$lock"
  k=$((k + 1))
done
[ -n "$PORT_LOCK" ] || die "no free block of e2e ports from 4173 (20 blocks tried)"
E2E_HOST_BASE=$base
export E2E_HOST_BASE
echo "e2e hosts on ports $E2E_HOST_BASE to $((E2E_HOST_BASE + 2 * E2E_WORKERS - 1)), $E2E_WORKERS workers"

step "web: playwright test (e2e smoke)"
pnpm -C web exec playwright test

step "all green"
