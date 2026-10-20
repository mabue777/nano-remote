#!/bin/sh
# Repo-wide verify gate for Nano Remote. Exit 0 only when every package is green.
#
#   1. protocol: python3 -I protocol/verify.py   (schemas, examples, negative cases)
#   2. host:     pnpm -C host verify             (generate types, tsc, vitest)
#   3. web:      pnpm -C web verify              (generate types, tsc, vitest, vite build, playwright smoke)
#
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

step "host: pnpm -C host verify"
pnpm -C host verify

step "web: pnpm -C web verify"
pnpm -C web verify

step "all green"
