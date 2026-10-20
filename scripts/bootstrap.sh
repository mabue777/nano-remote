#!/bin/sh
# One-time setup for a fresh clone (or after dependency changes): installs workspace dependencies
# (creating or updating pnpm-lock.yaml) and Playwright's chromium. The verify gate never does this;
# it only installs when node_modules is missing, with a frozen lockfile. Commit pnpm-lock.yaml.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
HOME=${HOME:-/tmp}
export HOME

command -v node >/dev/null 2>&1 || { echo "bootstrap: node not found on PATH=$PATH (brew install node)" >&2; exit 2; }
command -v pnpm >/dev/null 2>&1 || { echo "bootstrap: pnpm not found on PATH=$PATH (brew install pnpm)" >&2; exit 2; }

echo "== pnpm install (lockfile created or updated)"
pnpm install

echo "== playwright chromium"
pnpm -C web exec playwright install chromium

echo
echo "bootstrap done. Next: scripts/verify.sh, then commit pnpm-lock.yaml."
