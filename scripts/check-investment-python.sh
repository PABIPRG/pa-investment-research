#!/usr/bin/env bash
# Fail fast when this checkout has not initialized its investment Python runtimes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_LOCK="$ROOT/frontend/config/investment-python-runtime-lock.json"
MISSING=()

while IFS= read -r relative_directory; do
  directory="$ROOT/$relative_directory"
  if [[ ! -x "$directory/env/bin/python" && ! -x "$directory/env/Scripts/python.exe" ]]; then
    MISSING+=("$relative_directory")
  fi
done < <(node -e '
  const fs = require("node:fs")
  const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  for (const file of Object.keys(lock.requirements)) {
    process.stdout.write(`${file.replace(/\/requirements\.txt$/, "")}\n`)
  }
' "$RUNTIME_LOCK")

if (( ${#MISSING[@]} > 0 )); then
  echo "[错误] 当前工作区的投研 Python 环境尚未初始化：" >&2
  for directory in "${MISSING[@]}"; do
    echo "  - $directory" >&2
  done
  echo >&2
  echo "请先在当前工作区运行：" >&2
  echo "  ./start.sh init" >&2
  exit 1
fi

cd "$ROOT/frontend"
if ! pnpm run investment:python:verify; then
  echo >&2
  echo "[提示] 如需初始化或修复当前工作区环境，请运行：" >&2
  echo "  ./start.sh init" >&2
  exit 1
fi
