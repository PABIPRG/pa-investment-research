#!/usr/bin/env bash
# ============================================================
#  market-watch 停止脚本（macOS / Linux）
#   - 按端口 8100/3081 找到监听进程并结束
# ============================================================
set -euo pipefail

echo "停止 market-watch 服务..."
killed=0
for port in 8100 3081; do
    pids="$(lsof -t -i :$port 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        for pid in $pids; do
            kill "$pid" 2>/dev/null && { echo "  [OK] 已停止 :$port 进程 $pid"; killed=1; } || true
        done
    fi
done
if [ "$killed" = "0" ]; then
    echo "  [提示] 没有检测到 :8100 / :3081 的监听进程"
fi
echo "完成。"
