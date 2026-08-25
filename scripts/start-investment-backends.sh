#!/usr/bin/env bash
# Start the two Python APIs used by the investment-research profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/2] 启动 trading-core (:8000)"
bash "$ROOT/backend/dsh-trading-core/start.sh" "$@"

echo "[2/2] 启动 market-watch (:8100)"
bash "$ROOT/backend/market-watch/start.sh"

echo "[完成] 投研后台服务已就绪"
