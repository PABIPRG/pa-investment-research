#!/usr/bin/env bash
# ============================================================
#  dsh-trading-core 安装脚本（macOS / Linux）
#    一次性准备：Python 检测 → venv → pip 依赖 → .env → dsh-plugin → 验证
#    与 Windows 下的 install.bat 语义完全一致。
#
#  用法:
#    ./install.sh                  官方 PyPI 源完整安装
#    ./install.sh --mirror         国内网络：走清华镜像（推荐）
#    ./install.sh -i <URL>         自定义 PyPI 镜像地址
#    ./install.sh --check          只检查环境，不改动任何文件 / 不装包
#    ./install.sh --mirror --check 检查 + 显示将使用的镜像源
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# ---------- 参数解析 ----------
MIRROR=0
CHECK_ONLY=0
INDEX_URL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --mirror)     MIRROR=1 ;;
        -i)           shift; INDEX_URL="${1:-}" ;;
        --check)      CHECK_ONLY=1 ;;
        -h|--help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *)
            echo "[WARN] 未知参数 '$1'，忽略。支持：--mirror / -i <URL> / --check" >&2
            ;;
    esac
    shift
done

# -i 优先，其次 --mirror
if [ -n "$INDEX_URL" ]; then
    MIRROR=1
elif [ "$MIRROR" = "1" ]; then
    INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
fi

PYTHON="${PYTHON:-python3}"

echo "================================================================"
echo "  dsh-trading-core 安装（macOS / Linux）"
[ "$CHECK_ONLY" = "1" ] && echo "    模式：CHECK（仅检查环境，不做改动）"
[ -n "$INDEX_URL" ]   && echo "    PyPI：$INDEX_URL"
echo "================================================================"
echo

# ================================================================
#  [1/5] Python 检测（>= 3.10）
# ================================================================
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "[错误] 未检测到 $PYTHON，请安装 Python 3.10+ 并加入 PATH。" >&2
    exit 1
fi
if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    echo "[错误] 需要 Python >= 3.10，当前: $("$PYTHON" --version 2>&1)" >&2
    exit 1
fi
echo "[OK] Python: $("$PYTHON" --version 2>&1)"

# ================================================================
#  [2/5] venv
# ================================================================
echo
VENV_PY="env/bin/python"
if [ -x "$VENV_PY" ]; then
    echo "[OK] venv: $VENV_PY （已存在）"
else
    if [ "$CHECK_ONLY" = "1" ]; then
        echo "[WARN] venv 不存在：$VENV_PY （请运行 ./install.sh 进行完整安装）"
    else
        echo "[2/5] 创建虚拟环境 env ..."
        "$PYTHON" -m venv env
        echo "[OK] venv 创建完成"
    fi
fi

# ================================================================
#  [3/5] 安装 Python 依赖
# ================================================================
echo
if [ ! -x "$VENV_PY" ]; then
    echo "[SKIP] venv 未就绪，跳过 pip 安装"
else
    if [ "$CHECK_ONLY" = "1" ]; then
        echo "[CHECK] 将检查关键 Python 包是否已在 env 中安装 ..."
        if "$VENV_PY" -c "
import importlib.util, sys
pkgs=['fastapi','uvicorn','akshare','langgraph','chromadb','sse_starlette','pydantic','pandas','numpy','requests','beautifulsoup4','python_dotenv']
def has(name):
    return importlib.util.find_spec(name) is not None
missing=[p for p in pkgs if not has(p.replace('_','-')) and not has(p.replace('-','_')) and not has(p)]
print('  缺失包:', missing if missing else '无')
sys.exit(1 if missing else 0)
"; then
            echo "[OK] 关键 Python 包均已安装"
        else
            echo "[WARN] 有缺失包，完整安装时会自动补齐" || true
        fi
    else
        echo "[3/5] 安装 Python 依赖（首次运行需几分钟，使用清华镜像可加速）..."
        "$VENV_PY" -m pip install --upgrade pip -q
        PIP_ARGS=(install -r requirements.txt --retries 10 --timeout 120)
        if [ -n "$INDEX_URL" ]; then
            echo "        使用镜像: $INDEX_URL"
            "$VENV_PY" -m pip "${PIP_ARGS[@]}" -i "$INDEX_URL"
        else
            "$VENV_PY" -m pip "${PIP_ARGS[@]}"
        fi
        echo "[OK] Python 依赖安装完成"
    fi
fi

# ================================================================
#  [4/5] .env 生成
# ================================================================
echo
echo "[4/5] 检查 .env ..."
if [ ! -f .env ]; then
    if [ "$CHECK_ONLY" = "1" ]; then
        echo "[WARN] .env 不存在（完整安装时将从 .env.example 自动生成，请记得填入 DEEPSEEK_API_KEY）"
    else
        cp .env.example .env
        echo "[OK] 已生成 .env（复制自 .env.example）"
    fi
else
    echo "[OK] .env 已存在"
fi
if [ -f .env ]; then
    if grep -q '^DEEPSEEK_API_KEY=sk-' .env 2>/dev/null; then
        echo "  [OK] DEEPSEEK_API_KEY 已设置"
    else
        echo "  [WARN] .env 中 DEEPSEEK_API_KEY 仍是占位符或未设置，请编辑 .env 填入真实 Key"
    fi
fi

# ================================================================
#  [5/5] dsh-plugin npm 依赖（可选）
# ================================================================
echo
if [ -d dsh-plugin ] && [ -f dsh-plugin/package.json ]; then
    echo "[5/5] dsh-plugin npm 依赖（可选，仅 dsh Web UI 需要）..."
    if [ "$CHECK_ONLY" = "1" ]; then
        if [ -d dsh-plugin/node_modules ]; then
            echo "[OK] dsh-plugin/node_modules 已存在"
        else
            echo "[WARN] dsh-plugin/node_modules 不存在，完整安装时会自动 npm install"
        fi
    else
        if ( cd dsh-plugin && npm install >/dev/null 2>&1 ); then
            echo "  [OK] dsh-plugin npm 依赖就绪"
        else
            echo "  [WARN] npm install 未成功 —— dsh Web UI / 插件冒烟测试可能失败，适配器运行不受影响"
        fi
    fi
else
    echo "[SKIP] dsh-plugin 目录不存在，跳过 npm 依赖"
fi

# ================================================================
#  关键导入验证（完整安装必过）
# ================================================================
echo
if [ -x "$VENV_PY" ]; then
    if [ "$CHECK_ONLY" = "1" ]; then
        echo "[CHECK] 关键模块导入（环境验证用） ..."
    else
        echo "[VERIFY] 关键模块导入验证 ..."
    fi
    "$VENV_PY" -c "import fastapi, uvicorn, akshare, langgraph, chromadb, sse_starlette, pydantic, pandas, numpy, bs4, dotenv; print('  imports OK')"
    echo
fi

# ================================================================
#  结束
# ================================================================
echo "================================================================"
if [ "$CHECK_ONLY" = "1" ]; then
    echo "  检查完成！通过后可直接："
    echo "    启动服务： ./start_all.sh [fake|engine]"
    echo "    停止服务： ./stop_all.sh"
    echo "    健康检查： ./verify.sh"
else
    echo "  安装完成！"
    echo "    启动服务： ./start_all.sh [fake|engine]"
    echo "    停止服务： ./stop_all.sh"
    echo "    健康检查： ./verify.sh"
    echo "  请务必确认 .env 中 DEEPSEEK_API_KEY 已填入真实 Key"
fi
echo "================================================================"
