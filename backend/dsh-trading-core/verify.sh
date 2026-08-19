#!/usr/bin/env bash
# ============================================================
#  dsh-trading-core 验证脚本（macOS / Linux）
#   1. 适配器健康检查
#   2. 插件冒烟测试（9 工具注册即通过）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "== dsh-trading-core 验证 =="
echo
echo "[1/2] 适配器健康检查 ..."
if ! curl -sf http://127.0.0.1:8000/health; then
    echo
    echo "  [错误] 适配器未运行，请先 ./start.sh" >&2
    exit 1
fi
echo

echo "[2/2] 插件冒烟测试 ..."
if [ -d dsh-plugin ]; then
    ( cd dsh-plugin && npx tsx test/plugin-load.smoke.ts ) || echo "  [警告] 插件冒烟测试失败"
else
    echo "  dsh-plugin 目录不存在，跳过"
fi
echo
echo "== 验证完成 =="
