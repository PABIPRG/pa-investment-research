#!/usr/bin/env bash
# ============================================================
#  industry-chain 验证脚本（macOS / Linux）
#   1. 适配器健康检查 + 只读数据状态
#   2. 插件冒烟测试（4 工具注册即通过）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--environment" ]]; then
    if [[ ! -x env/bin/python ]]; then
        echo "[错误] Python 虚拟环境不存在，请先运行 init.sh" >&2
        exit 1
    fi
    env/bin/python -c "from industry_chain.app import app; print('industry-chain Python imports OK')"
    exit 0
fi

echo "== industry-chain 验证 =="
echo
echo "[1/2] 适配器健康检查 ..."
if ! curl -sf http://127.0.0.1:8200/health; then
    echo
    echo "  [错误] 适配器未运行，请先 ./start.sh" >&2
    exit 1
fi
echo
echo "  /data/status 返回（不会下载数据）:"
curl -sf http://127.0.0.1:8200/data/status
echo

echo "[2/2] 插件冒烟测试 ..."
if [ -d dsh-plugin ]; then
    ( cd dsh-plugin && npx tsx test/plugin-load.smoke.ts ) || echo "  [警告] 插件冒烟测试失败"
else
    echo "  dsh-plugin 目录不存在，跳过"
fi
echo
echo "== 验证完成 =="
