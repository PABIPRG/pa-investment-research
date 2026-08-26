#!/usr/bin/env bash
# Project initialization: install deps and build. Run once after clone.
# Cross-platform: Linux/macOS native; on Windows use Git Bash.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/3] 前端：安装依赖..."
cd frontend
# electron 的 postinstall 在 Windows 上依赖损坏的 @electron-internal/extract-zip，跳过它，
# 二进制由 scripts/ensure-electron.sh 负责下载解压。
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install

echo "[2/3] 投研后台：初始化 Python 环境..."
pnpm run investment:python:init

echo "[3/3] 前端：构建并准备 Electron 运行时..."
pnpm run build
cd "$ROOT"
bash "$ROOT/scripts/ensure-electron.sh"

bash "$ROOT/scripts/prepare-macos-native-modules.sh"

echo "[done] 初始化完成。"
