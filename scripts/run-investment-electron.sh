#!/usr/bin/env bash
# Build and launch the Electron version of the investment-research profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/run-electron.sh" build --profile investment-research "$@"
