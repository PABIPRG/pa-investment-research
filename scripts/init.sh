#!/usr/bin/env bash
# Project initialization: install deps and build. Run once after clone.
# Cross-platform: Linux/macOS native; on Windows use Git Bash.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/2] 前端：安装依赖并构建..."
cd frontend
# electron 的 postinstall 在 Windows 上依赖损坏的 @electron-internal/extract-zip，跳过它，
# 二进制由 scripts/ensure-electron.sh 负责下载解压。
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
pnpm run build
cd "$ROOT"

bash "$ROOT/scripts/ensure-electron.sh"

# TODO: 后端初始化（依赖安装/环境准备），后续在此追加

bash "$ROOT/scripts/prepare-macos-native-modules.sh"

echo "[done] 初始化完成。"
