#!/usr/bin/env bash
# Launch the Electron desktop app, ensuring the Electron binary is present first
# (on Windows electron's own postinstall is broken — see ensure-electron.sh).
# Usage: scripts/run-electron.sh build|dev
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash "$ROOT/scripts/ensure-electron.sh"

cd frontend
if [[ "${1:-dev}" == "build" ]]; then
  pnpm run start:electron
else
  pnpm --filter @deepseek-ai/dsh-electron run start
fi
