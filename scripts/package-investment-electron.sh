#!/usr/bin/env bash
# Build the current platform's standalone investment application and ZIP.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -gt 0 ]]; then
  if [[ $# -eq 1 && "$1" == "--help" ]]; then
    echo "用法：bash start.sh investment-package"
    echo "构建当前平台的桌面应用及 ZIP，内置 Python 和投研依赖。"
    echo "输出：frontend/apps/electron/out（应用）与 out/make（ZIP）。"
    echo "仅构建，不启动应用，也不发布 GitHub Release。"
    exit 0
  fi
  echo "[错误] 不支持的参数；使用 --help 查看用法。" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "[错误] 请先安装 Node.js。" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "[错误] 请先安装 pnpm。" >&2; exit 1; }
TARGET="$(node -p "process.platform+'-'+process.arch")"
case "$TARGET" in
  darwin-arm64|darwin-x64|win32-x64) ;;
  *) echo "[错误] 暂不支持本机打包目标：$TARGET" >&2; exit 1 ;;
esac
# Honor the configured proxy for Node downloads (supported Node versions).
export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"
cd "$ROOT/frontend"
echo "正在构建 $TARGET 桌面包（首次会下载独立 Python 及依赖，请保持联网）…"
pnpm run constraints
# Keep deploy metadata from causing an automatic production-only reinstall.
pnpm_config_verify_deps_before_run=warn pnpm run make:electron
echo "构建成功。应用目录：$ROOT/frontend/apps/electron/out"
echo "可分发 ZIP：$ROOT/frontend/apps/electron/out/make"
echo "macOS 当前采用临时签名；对外稳定分发前需要正式签名与公证。"
