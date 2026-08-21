#!/usr/bin/env bash
# Verify the Python health contract and imports only.
set -euo pipefail
cd "$(dirname "$0")"

env/bin/python -m unittest tests/test_health_contract.py
env/bin/python -c "import fastapi, uvicorn; from market_watch.app import app; print('Python imports OK')"
