#!/usr/bin/env bash
# Entry point: dispatch to the interactive script menu.
# Cross-platform: Linux/macOS native; on Windows use Git Bash.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/scripts/main.sh" "$@"
