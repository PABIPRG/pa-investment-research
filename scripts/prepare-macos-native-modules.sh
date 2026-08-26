#!/usr/bin/env bash
# Remove quarantine propagated by GUI checkout tools from trusted, installed
# native Node addons and their executable helpers before a local development launch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

NATIVE_ROOT="$ROOT/frontend/node_modules"
if [[ ! -d "$NATIVE_ROOT" ]]; then
  exit 0
fi

removed=0
while IFS= read -r -d '' native_file; do
  if xattr -p com.apple.quarantine "$native_file" >/dev/null 2>&1; then
    if ! xattr -d com.apple.quarantine "$native_file"; then
      echo "[native-modules] 无法移除 quarantine 标记：$native_file" >&2
      exit 1
    fi
    removed=$((removed + 1))
  fi
done < <(find "$NATIVE_ROOT" -type f \( -name '*.node' -o -name 'spawn-helper' \) -print0)

if (( removed > 0 )); then
  echo "[native-modules] 已移除 $removed 个 native 文件的 macOS quarantine 标记。"
fi
