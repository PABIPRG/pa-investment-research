#!/usr/bin/env bash
# Initialize only the Python backend environment.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    echo "[error] Python 3.10 or newer is required" >&2
    exit 1
fi

if [ ! -d env ]; then
    echo "[1/3] creating Python virtual environment..."
    "$PYTHON" -m venv env
else
    echo "[1/3] Python virtual environment already exists"
fi

echo "[2/3] installing Python requirements..."
env/bin/python -m pip install --upgrade pip -q
env/bin/python -m pip install -r requirements.txt "$@"

echo "[3/3] verifying Python imports..."
env/bin/python -c "import fastapi, uvicorn; from adapter.app import app; print('Python imports OK')"

echo "Initialization complete. Product users manage keys in the existing Models page; .env is only for standalone Python or compatibility development."
