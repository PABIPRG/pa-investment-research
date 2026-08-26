#!/usr/bin/env bash
# Build and launch the browser version of the investment-research profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/scripts/check-investment-python.sh"

cd "$ROOT/frontend"

pnpm run build:lib
pnpm run build:web

# Keep this immediately before launch: a build or dependency refresh may restore
# quarantine attributes propagated by GUI checkout tools such as Sourcetree.
bash "$ROOT/scripts/prepare-macos-native-modules.sh"

exec node apps/cli/lib/bin.js --profile investment-research "$@"
