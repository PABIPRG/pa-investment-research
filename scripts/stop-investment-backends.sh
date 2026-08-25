#!/usr/bin/env bash
# Stop the two manually started persistent Python APIs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

wait_for_port_release() {
  local port="$1"
  for _ in $(seq 1 50); do
    if ! lsof -t -i ":$port" >/dev/null 2>&1; then
      echo "[ok] :$port 已释放"
      return 0
    fi
    sleep 0.1
  done
  echo "[错误] :$port 在停止后仍被占用" >&2
  return 1
}

echo "[1/2] 停止 market-watch (:8100)"
bash "$ROOT/backend/market-watch/stop_all.sh"

echo "[2/2] 停止 trading-core (:8000)"
bash "$ROOT/backend/dsh-trading-core/stop_all.sh"

FAILED=0
wait_for_port_release 8100 || FAILED=1
wait_for_port_release 8000 || FAILED=1
if [[ "$FAILED" != 0 ]]; then
  exit 1
fi

echo "[完成] 手动常驻投研后台已停止"
