#!/usr/bin/env bash
# Manually start the three Python APIs as persistent services for independent debugging.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRADING_WAS_HEALTHY=0
MARKET_WAS_HEALTHY=0
if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then
  TRADING_WAS_HEALTHY=1
fi
if curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1; then
  MARKET_WAS_HEALTHY=1
fi

echo "[1/3] 启动 trading-core (:8000)"
bash "$ROOT/backend/dsh-trading-core/start.sh" "$@"

echo "[2/3] 启动 market-watch (:8100)"
if bash "$ROOT/backend/market-watch/start.sh"; then
  :
else
  STATUS=$?
  if [[ "$TRADING_WAS_HEALTHY" == 0 ]]; then
    echo "[回滚] market-watch 启动失败，停止本次启动的 trading-core" >&2
    bash "$ROOT/backend/dsh-trading-core/stop_all.sh"
  fi
  exit "$STATUS"
fi

echo "[3/3] 启动 industry-chain (:8200)"
if bash "$ROOT/backend/industry-chain/start.sh"; then
  :
else
  STATUS=$?
  if [[ "$MARKET_WAS_HEALTHY" == 0 ]]; then
    echo "[回滚] industry-chain 启动失败，停止本次启动的 market-watch" >&2
    bash "$ROOT/backend/market-watch/stop_all.sh"
  fi
  if [[ "$TRADING_WAS_HEALTHY" == 0 ]]; then
    echo "[回滚] industry-chain 启动失败，停止本次启动的 trading-core" >&2
    bash "$ROOT/backend/dsh-trading-core/stop_all.sh"
  fi
  exit "$STATUS"
fi

echo "[完成] 手动常驻投研后台已就绪；使用 ./start.sh backend-stop 停止"
