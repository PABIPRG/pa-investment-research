#!/usr/bin/env bash
# Build and launch the browser version of the investment-research profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/frontend"

pnpm run build:lib
pnpm run build:web
exec node apps/cli/lib/bin.js --profile investment-research "$@"
