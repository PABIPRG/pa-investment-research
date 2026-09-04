#!/usr/bin/env bash
# rc.10 演示工具统一入口；主菜单只保留一个产品演示项。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_action() {
  case "$1" in
    prepare|verify|preflight|clean)
      bash "$ROOT/scripts/prepare-demo-evolution-data.sh" "$1"
      ;;
    runbook)
      bash "$ROOT/scripts/run-rc10-demo.sh"
      ;;
    *)
      echo "[错误] 未知演示动作: $1" >&2
      exit 2
      ;;
  esac
}

if [[ $# -gt 0 ]]; then
  run_action "$1"
  exit 0
fi

echo "=== rc.10 演示工具 ==="
echo "  1) 准备 5 个交易日演示数据"
echo "  2) 演示前完整检查"
echo "  3) 中文全链路彩排"
echo "  4) 验证演示数据"
echo "  5) 清理演示数据"
read -rp "请选择 (1-5): " choice
case "$choice" in
  1) run_action prepare ;;
  2) run_action preflight ;;
  3) run_action runbook ;;
  4) run_action verify ;;
  5) run_action clean ;;
  *) echo "[错误] 无效的选择" >&2; exit 1 ;;
esac
