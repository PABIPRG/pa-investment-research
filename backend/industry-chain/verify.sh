#!/usr/bin/env bash
# ============================================================
#  industry-chain 验证脚本（macOS / Linux）
#   1. 适配器健康检查 + 关键端点冒烟
#   2. 插件冒烟测试（4 工具注册即通过）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "== industry-chain 验证 =="
echo
echo "[1/2] 适配器健康检查 ..."
if ! curl -sf http://127.0.0.1:8200/health; then
    echo
    echo "  [错误] 适配器未运行，请先 ./start.sh" >&2
    exit 1
fi
echo
echo "  /stats 返回:"
curl -sf http://127.0.0.1:8200/stats
echo
echo "  /graph/chain/600315 返回:"
curl -sf "http://127.0.0.1:8200/graph/chain/600315?depth_up=1&depth_down=2&top_up=3&top_down=2" | head -c 300
echo

echo "[2/2] 插件冒烟测试 ..."
if [ -d dsh-plugin ]; then
    ( cd dsh-plugin && npx tsx test/plugin-load.smoke.ts ) || echo "  [警告] 插件冒烟测试失败"
else
    echo "  dsh-plugin 目录不存在，跳过"
fi
echo
echo "== 验证完成 =="
