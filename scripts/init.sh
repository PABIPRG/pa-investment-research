#!/usr/bin/env bash
# Project initialization: install deps and build. Run once after clone.
# Cross-platform: Linux/macOS native; on Windows use Git Bash.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/2] 前端：安装依赖并构建..."
cd frontend
pnpm install
pnpm run build
cd "$ROOT"

# TODO: 后端初始化（依赖安装/环境准备），后续在此追加

# macOS: 移除 native 模块的 quarantine 标记（Sourcetree 等工具同步 node_modules 会触发 Gatekeeper 拦截）
if [[ "$(uname -s)" == "Darwin" ]]; then
  find frontend/node_modules -name '*.node' -exec xattr -d com.apple.quarantine {} \; 2>/dev/null || true
fi

echo "[done] 初始化完成。"
