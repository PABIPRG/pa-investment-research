#!/usr/bin/env bash
# Sync upstream deepseek-harness into frontend/ via git subtree.
# Cross-platform: works on Linux/macOS natively; on Windows use Git Bash.
# Usage: bash scripts/sync-upstream.sh [branch]   # default: master
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_URL="git@github.com:deepseek-ai/deepseek-harness.git"
UPSTREAM_NAME="upstream"
PREFIX="frontend"
BRANCH="${1:-master}"

cd "$ROOT"

# 0. Require no tracked changes (untracked files are fine)
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "[abort] tracked changes exist, commit or stash first:" >&2
  git status --porcelain --untracked-files=no >&2
  exit 1
fi

# 1. Ensure upstream remote
if ! git remote | grep -qx "$UPSTREAM_NAME"; then
  echo "[setup] adding remote $UPSTREAM_NAME -> $UPSTREAM_URL"
  git remote add "$UPSTREAM_NAME" "$UPSTREAM_URL"
fi

# 2. Fetch
echo "[fetch] $UPSTREAM_NAME/$BRANCH"
git fetch "$UPSTREAM_NAME" "$BRANCH"

# 3. Show what's incoming
if [[ "$(git rev-parse "FETCH_HEAD")" == "$(git merge-base HEAD FETCH_HEAD)" ]]; then
  echo "[done] already up to date"
  exit 0
fi
INCOMING=$(git log --oneline HEAD..FETCH_HEAD)
echo "[incoming] $(echo "$INCOMING" | wc -l | tr -d ' ') commits:"
echo "$INCOMING"
echo

# 4. Subtree pull
echo "[sync] subtree pull --prefix=$PREFIX $UPSTREAM_NAME/$BRANCH --squash"
git subtree pull --prefix="$PREFIX" "$UPSTREAM_NAME" "$BRANCH" --squash

echo "[done] sync complete. Resolve any conflicts (esp. dsh-trading-core under frontend/packages/), then commit."
