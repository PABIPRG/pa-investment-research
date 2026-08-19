#!/usr/bin/env bash
# ============================================================
#  market-watch 一键启动（macOS / Linux）
#   服务1: 适配器 FastAPI  :8100（盘中盯盘 Agent）
#   服务2: dsh Web UI      :3081（带 11 工具插件）
#   - 已运行的服务会自动跳过，不会重复启动
# 用法: ./start.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

PATCH="$(pwd)/dsh-plugin/cordis.yml"
DSH_RUN="${DSH_RUN:-${TMPDIR:-/tmp}/dsh-run-mw}"
LOGS="$(pwd)/logs"
mkdir -p "$LOGS" "$DSH_RUN"

echo "================================================================"
echo "  market-watch 启动"
echo "================================================================"
echo

# ---------- 前置检查 ----------
if [ ! -d env ]; then
    echo "[错误] 未找到虚拟环境 env，请先运行 ./init.sh" >&2
    exit 1
fi
if [ ! -f .env ]; then
    echo "[警告] 未找到 .env，请先运行 ./init.sh"
fi

# ---------- 1. 适配器 ----------
if curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1; then
    echo "[OK] 适配器已在运行 (:8100)"
else
    echo "[1/2] 启动适配器 (:8100)..."
    ( PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
        nohup env/bin/python -m uvicorn market_watch.app:app --host 127.0.0.1 --port 8100 --log-level warning \
        >> "$LOGS/adapter.log" 2>&1 & )
    for _ in $(seq 1 120); do
        curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1 && break
        sleep 1
    done
    if ! curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1; then
        echo "[错误] 适配器启动超时，请查看 $LOGS/adapter.log" >&2
        exit 1
    fi
    echo "[OK] 适配器就绪 (:8100)"
fi

# ---------- 2. dsh Web UI ----------
if curl -sf -o /dev/null http://127.0.0.1:3081 2>/dev/null; then
    echo "[注意] :3081 已有服务，未启动新的 dsh"
    echo "       如需本项目的 dsh，请先运行 ./stop_all.sh 清理再启动"
else
    echo "[2/2] 启动 dsh Web UI (:3081, 插件已加载)..."
    ( cd "$DSH_RUN" && nohup npx @deepseek-ai/dsh web --patch "$PATCH" --port 3081 >> "$LOGS/dsh.log" 2>&1 & )
    for _ in $(seq 1 120); do
        curl -sf -o /dev/null http://127.0.0.1:3081 2>/dev/null && break
        sleep 1
    done
    if ! curl -sf -o /dev/null http://127.0.0.1:3081 2>/dev/null; then
        echo "[错误] dsh Web UI 启动超时，请查看 $LOGS/dsh.log" >&2
        exit 1
    fi
    echo "[OK] dsh Web UI 就绪 (:3081)"
fi

echo
echo "全部就绪！"
echo "  - dsh 对话页 : http://127.0.0.1:3081   (Settings-Models 填 DeepSeek API Key)"
echo "  - 适配器状态 : http://127.0.0.1:8100/health"
echo "  - 日志        : $LOGS/adapter.log / dsh.log"
echo "  - 停止        : ./stop_all.sh"
