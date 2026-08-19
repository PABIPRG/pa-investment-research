#!/usr/bin/env bash
# ============================================================
#  dsh-trading-core 一键启动脚本（macOS / Linux）
#    与 Windows 下的 start_all.bat 语义完全一致。
#
#    服务1: FastAPI 适配器  :8000（默认 engine 模式）
#    服务2: dsh Web UI      :3080（带 9 工具插件）
#
#  - 已运行的服务会自动跳过，不会重复启动
#  - 传 "fake" 则适配器以假任务模式启动（联调用，不依赖行情/LLM）
#  - 传 "engine" 或不传，则以真实引擎模式启动
#
#  用法: ./start_all.sh [fake|engine]
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# ---------- 基础路径（与 Windows 版 start_all.bat 对齐） ----------
PATCH="$(pwd)/dsh-plugin/cordis.yml"
DSH_RUN="${DSH_RUN:-${TMPDIR:-/tmp}/dsh-run-pa}"
LOGS="$(pwd)/logs"
mkdir -p "$LOGS" "$DSH_RUN"

# ---------- 参数解析 ----------
RUNNER="engine"
if [ "${1:-}" = "fake" ] || [ "${1:-}" = "engine" ]; then
    RUNNER="$1"
elif [ -n "${1:-}" ]; then
    echo "[错误] 参数仅支持 fake / engine，收到: '$1'" >&2
    echo "  用法: $0 [fake|engine]" >&2
    exit 1
fi

echo "================================================================"
echo "  dsh-trading-core 一键启动（macOS / Linux）"
echo "================================================================"
echo

# ---------- 前置检查 ----------
if [ ! -x env/bin/python ]; then
    echo "[错误] 未找到虚拟环境 env/bin/python，请先运行 ./install.sh" >&2
    exit 1
fi
if [ ! -f .env ]; then
    echo "[警告] 未找到 .env（首次请运行 ./install.sh 生成），适配器可能缺少必需 Key"
fi

# ---------- 工具：等到端口监听 ----------
wait_port() {
    local port="$1" name="$2"
    local i
    for i in $(seq 1 120); do
        # macOS 下 lsof -i :port 可以直接找到 LISTEN；curl -sf 同时兼顾服务真的在响应
        if { lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; } \
           || { curl -sf -o /dev/null "http://127.0.0.1:$port" 2>/dev/null; }; then
            echo "  [OK] $name 就绪 (:$port)"
            return 0
        fi
        sleep 1
    done
    echo "[错误] $name 启动超时，请查看 $LOGS/对应日志" >&2
    return 1
}

# ---------- 1. 适配器 ----------
echo
if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "[OK] 适配器已在运行 - :8000（跳过）"
else
    echo "[1/2] 启动适配器 - :8000, $RUNNER 模式 ..."
    (   cd "$(pwd)"
        export ADAPTER_RUNNER="$RUNNER"
        export PYTHONIOENCODING=utf-8
        export PYTHONUTF8=1
        nohup env/bin/python -m uvicorn adapter.app:app \
            --host 127.0.0.1 --port 8000 --log-level warning \
            >> "$LOGS/adapter.log" 2>&1 &
    )
    wait_port 8000 "适配器" || exit 1
fi

# ---------- 2. dsh Web UI ----------
echo
# 坑 #2：dsh 从"含 .env 的目录"启动会扫描到 DEEPSEEK_BASE_URL 并报错退出。
#        必须从一个没有 .env 的临时目录（$DSH_RUN）启动，用 --patch 指向插件 yml。
if curl -sf -o /dev/null http://127.0.0.1:3080 2>/dev/null; then
    echo "[NOTE] :3080 已有服务（可能是旧项目占用）— 未启动新的 dsh。"
    echo "       如需使用本项目的 dsh，请先运行 ./stop_all.sh 清理再启动。"
else
    echo "[2/2] 启动 dsh Web UI - :3080, plugin loaded ..."
    if ! command -v npx >/dev/null 2>&1; then
        echo "  [WARN] 未检测到 npx（Node.js 未装？）— 跳过 dsh Web UI 启动，适配器不受影响"
        echo "         安装 Node.js 18+ 后重跑即可。"
    else
        (   cd "$DSH_RUN"
            nohup npx @deepseek-ai/dsh web --patch "$PATCH" \
                >> "$LOGS/dsh.log" 2>&1 &
        )
        wait_port 3080 "dsh Web UI" || {
            echo "  [提示] dsh 首次运行需要 npx 拉取包（约需几分钟），若超时可稍后再测端口。"
        }
    fi
fi

# ---------- 自动打开浏览器（尽力而为） ----------
UI_URL="http://127.0.0.1:3080"
echo
case "$(uname -s)" in
    Darwin)
        if curl -sf -o /dev/null "$UI_URL" 2>/dev/null; then
            open "$UI_URL" 2>/dev/null || true
        fi
        ;;
    Linux)
        if command -v xdg-open >/dev/null 2>&1 && curl -sf -o /dev/null "$UI_URL" 2>/dev/null; then
            xdg-open "$UI_URL" >/dev/null 2>&1 || true
        fi
        ;;
esac

# ---------- 结束汇总 ----------
echo
echo "全部就绪！"
echo "  - dsh 对话页  : http://127.0.0.1:3080   （Settings-Models 里填 DeepSeek API Key）"
echo "  - 适配器健康  : http://127.0.0.1:8000/health"
echo "  - 日志目录    : $LOGS/adapter.log / $LOGS/dsh.log"
echo "  - 停止服务    : ./stop_all.sh"
echo "  - 验证服务    : ./verify.sh"
