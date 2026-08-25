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

# Replace this launcher with the actual Electron process. Keeping pnpm and its
# script shell between the terminal and Electron makes a signal sent to the
# launcher's PID stop the wrapper without necessarily reaching Electron, which
# can strand Electron-owned sidecars. Electron itself owns graceful profile
# teardown and stops only the Python processes created by that profile.
cd "$ROOT/frontend/apps/electron"
ELECTRON_BINARY="$(node -p "require('electron')")"
exec "$ELECTRON_BINARY" . "$@"
