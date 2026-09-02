#!/usr/bin/env bash
# 演示数据：回灌最近 5 个已结算交易日的真实影子验证数据（自测/演示专用，非产品功能）。
# 让自进化页面无需等待 5 个交易日即可展示进化闭环。回灌前会先备份，可还原。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/backend/dsh-trading-core"
cd "$CORE"

# venv 双布局：Windows Git Bash 用 Scripts/，Unix 用 bin/（同 product/start.sh pick_py）
PY="$CORE/env/Scripts/python.exe"
if [ ! -x "$PY" ]; then
  PY="$CORE/env/bin/python"
fi
if [ ! -x "$PY" ]; then
  echo "[error] Python 虚拟环境缺失，请先运行 init 初始化（backend/dsh-trading-core/init.sh）" >&2
  exit 1
fi

echo "[演示数据] 使用 $PY"
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$CORE/_demo_evolution_backfill.py"
