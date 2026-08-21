#!/usr/bin/env bash
# Start only the Python market-watch API.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x env/bin/python ]; then
    echo "[error] Python virtual environment missing; run ./init.sh first" >&2
    exit 1
fi

LOGS="$(pwd)/logs"
mkdir -p "$LOGS"
if curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1; then
    echo "[ok] market-watch API already running on :8100"
    exit 0
fi

echo "Starting market-watch API on :8100..."
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
    nohup env/bin/python -m uvicorn market_watch.app:app --host 127.0.0.1 --port 8100 --log-level warning \
    >> "$LOGS/adapter.log" 2>&1 &

for _ in $(seq 1 120); do
    curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1 && break
    sleep 1
done
if ! curl -sf http://127.0.0.1:8100/health >/dev/null 2>&1; then
    echo "[error] market-watch API startup timed out; see $LOGS/adapter.log" >&2
    exit 1
fi
echo "[ok] market-watch API ready on :8100"
