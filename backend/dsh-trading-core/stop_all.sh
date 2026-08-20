#!/usr/bin/env bash
# Manual Python-backend wrapper only; Phase 2 Runtime owns its own child handles.
set -euo pipefail

pids="$(lsof -t -i :8000 2>/dev/null || true)"
if [ -z "$pids" ]; then
    echo "[info] no listener on :8000"
    exit 0
fi
for pid in $pids; do
    kill "$pid" 2>/dev/null && echo "[ok] stopped :8000 pid $pid" || true
done
