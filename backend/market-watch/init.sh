#!/usr/bin/env bash
# ============================================================
#  market-watch 初始化脚本（macOS / Linux）
#   1. 定位 Python 3.10+ 并创建 venv
#   2. 安装 Python 依赖（国内可传 -i 镜像，如:
#      ./init.sh -i https://pypi.tuna.tsinghua.edu.cn/simple）
#   3. 从 .env.example 生成 .env
#   4. 安装 dsh-plugin npm 依赖 + 验证关键导入
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

echo "================================================================"
echo "  market-watch 初始化"
echo "================================================================"
echo

# ---------- 1. Python >= 3.10 ----------
if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    echo "[错误] 需要 Python >= 3.10，当前: $(command -v "$PYTHON" || echo "未找到 $PYTHON")" >&2
    exit 1
fi
echo "[OK] Python: $("$PYTHON" --version 2>&1)"

# ---------- 2. 创建 venv ----------
if [ ! -d env ]; then
    echo "[1/4] 创建虚拟环境 env ..."
    "$PYTHON" -m venv env
else
    echo "[1/4] venv 已存在，跳过创建"
fi

# ---------- 3. 安装 Python 依赖 ----------
echo "[2/4] 安装 Python 依赖（首次约需几分钟）..."
env/bin/python -m pip install --upgrade pip -q
env/bin/python -m pip install -r requirements.txt "$@"

# ---------- 4. 生成 .env ----------
echo "[3/4] 检查 .env ..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "  [提示] 已从 .env.example 生成 .env，请编辑填入 DEEPSEEK_API_KEY"
else
    echo "  .env 已存在，跳过"
fi
if grep -q 'sk-你的key' .env 2>/dev/null; then
    echo "  [警告] DEEPSEEK_API_KEY 仍是占位符，请编辑 .env 填入真实 Key"
fi

# ---------- 5. dsh-plugin npm 依赖（可选） ----------
echo "[4/4] 安装 dsh-plugin npm 依赖（可选）..."
if [ -d dsh-plugin ]; then
    ( cd dsh-plugin && npm install >/dev/null 2>&1 ) || echo "  [警告] npm install 未成功，插件冒烟测试可能失败（不影响适配器运行）"
else
    echo "  dsh-plugin 目录不存在，跳过"
fi

# ---------- 6. 验证关键导入 ----------
echo "[验证] 关键依赖导入检查 ..."
env/bin/python -c "import fastapi, uvicorn, akshare, baostock, pandas, openai, apscheduler, tzdata, dotenv; print('  imports OK')"

echo
echo "================================================================"
echo "  初始化完成！"
echo "    - 启动: ./start.sh"
echo "    - 停止: ./stop_all.sh"
echo "    - 验证: ./verify.sh"
echo "  .env 里务必确认 DEEPSEEK_API_KEY 已填入真实 Key"
echo "================================================================"
