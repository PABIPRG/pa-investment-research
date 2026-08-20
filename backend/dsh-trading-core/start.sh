#!/usr/bin/env bash
# Start only the Python trading-core API. ADAPTER_RUNNER may be fake or engine.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x env/bin/python ]; then
    echo "[error] Python virtual environment missing; run ./init.sh first" >&2
    exit 1
fi

RUNNER="${ADAPTER_RUNNER:-engine}"
if [ "$#" -gt 0 ]; then
    RUNNER="$1"
fi
case "$RUNNER" in
    fake|engine) ;;
    *) echo "[error] ADAPTER_RUNNER must be fake or engine" >&2; exit 1 ;;
esac

LOGS="$(pwd)/logs"
mkdir -p "$LOGS"
if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "[ok] trading-core API already running on :8000"
    exit 0
fi

echo "Starting trading-core API on :8000 (ADAPTER_RUNNER=$RUNNER)..."
ADAPTER_RUNNER="$RUNNER" PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
    nohup env/bin/python -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000 --log-level warning \
    >> "$LOGS/adapter.log" 2>&1 &

for _ in $(seq 1 120); do
    curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1 && break
    sleep 1
done
if ! curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "[error] trading-core API startup timed out; see $LOGS/adapter.log" >&2
    exit 1
fi
echo "[ok] trading-core API ready on :8000"
