#!/usr/bin/env bash
# ============================================================
#  历史兼容入口（保留旧文件名 start.sh 以便 README/ 老用户指引仍然可用）
#  新的统一入口是 ./start_all.sh（与 Windows 版 start_all.bat 同名、语义对齐）。
# ============================================================
set -euo pipefail
exec "$(dirname "$0")/start_all.sh" "$@"
