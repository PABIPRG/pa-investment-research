#!/usr/bin/env bash
# Launch the Electron desktop app, ensuring the Electron binary is present first
# (on Windows electron's own postinstall is broken — see ensure-electron.sh).
# Usage: scripts/run-electron.sh build|dev [electron arguments...]
# Example: scripts/run-electron.sh build --profile investment-research
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-dev}"
if [[ $# -gt 0 ]]; then
  shift
fi
if [[ "$MODE" != "build" && "$MODE" != "dev" ]]; then
  echo "[错误] 启动模式必须是 build 或 dev: $MODE" >&2
  exit 1
fi

bash "$ROOT/scripts/ensure-electron.sh"

cd frontend
if [[ "$MODE" == "build" ]]; then
  pnpm run build
fi

# Keep this immediately before launch: a build or dependency refresh may restore
# quarantine attributes propagated by GUI checkout tools such as Sourcetree.
bash "$ROOT/scripts/prepare-macos-native-modules.sh"
if [[ $# -gt 0 ]]; then
  pnpm --filter @deepseek-ai/dsh-electron run start -- "$@"
else
  pnpm --filter @deepseek-ai/dsh-electron run start
fi
