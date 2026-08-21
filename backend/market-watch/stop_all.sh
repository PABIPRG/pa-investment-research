#!/usr/bin/env bash
# Manual Python-backend wrapper only; Phase 2 Runtime owns its own child handles.
set -euo pipefail

pids="$(lsof -t -i :8100 2>/dev/null || true)"
if [ -z "$pids" ]; then
    echo "[info] no listener on :8100"
    exit 0
fi
for pid in $pids; do
    kill "$pid" 2>/dev/null && echo "[ok] stopped :8100 pid $pid" || true
done
