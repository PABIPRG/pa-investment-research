#!/usr/bin/env bash
# rc.10 演示数据：在独立状态目录中准备可重复的 5 日自进化场景。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/backend/dsh-trading-core"
cd "$CORE"

usage() {
  cat <<'EOF'
用法: scripts/prepare-demo-evolution-data.sh [prepare|verify|preflight|clean|help]

状态目录：
  DSH_INVESTMENT_STATE_DIR  演示后端与脚本的权威状态目录。
  DSH_DEMO_STATE_DIR        兼容旧调用；与权威变量同时设置时必须指向同一目录。
  两者均未设置时使用仓库内明确的 demo root：.demo-state/rc10-evolution。

动作：
  prepare    安全重建固定 5 个有效交易日的 rc.10 演示夹具。
  verify     验证 marker、5 日数据、四类场景和母子关系。
  preflight  验证数据与演示前产品门禁；任何缺项返回非零。
  clean      只清理带正确 marker 的演示目录。
EOF
}

ACTION="${1:-prepare}"
case "$ACTION" in
  prepare|verify|preflight|clean) ;;
  help|-h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

AUTHORITATIVE_STATE="${DSH_INVESTMENT_STATE_DIR:-}"
COMPAT_STATE="${DSH_DEMO_STATE_DIR:-}"
if [[ -n "$AUTHORITATIVE_STATE" && -n "$COMPAT_STATE" ]]; then
  AUTHORITATIVE_REAL="${AUTHORITATIVE_STATE%/}"
  COMPAT_REAL="${COMPAT_STATE%/}"
  if [[ "$AUTHORITATIVE_REAL" != "$COMPAT_REAL" ]]; then
    echo "[error] DSH_INVESTMENT_STATE_DIR 与 DSH_DEMO_STATE_DIR 指向不同目录；请只保留权威变量或将两者设为同一路径" >&2
    exit 2
  fi
fi

DEMO_STATE="${AUTHORITATIVE_STATE:-${COMPAT_STATE:-$ROOT/.demo-state/rc10-evolution}}"
if [[ "$DEMO_STATE" != /* ]]; then
  echo "[error] DSH_INVESTMENT_STATE_DIR 必须是绝对路径；当前值: $DEMO_STATE" >&2
  exit 2
fi
export DSH_INVESTMENT_STATE_DIR="$DEMO_STATE"
export DSH_DEMO_STATE_DIR="$DEMO_STATE"

# venv 双布局：Windows Git Bash 用 Scripts/，Unix 用 bin/（同 product/start.sh pick_py）
PY="${DSH_DEMO_PYTHON:-$CORE/env/Scripts/python.exe}"
if [ ! -x "$PY" ] && [ -z "${DSH_DEMO_PYTHON:-}" ]; then
  PY="$CORE/env/bin/python"
fi
if [ ! -x "$PY" ]; then
  echo "[error] Python 虚拟环境缺失；请先运行 init，或用 DSH_DEMO_PYTHON 指定解释器" >&2
  exit 1
fi

echo "[演示数据] 使用 $PY"
echo "[演示数据] 独立状态目录 $DSH_INVESTMENT_STATE_DIR"
if [[ "$ACTION" == "preflight" ]]; then
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$CORE/_demo_evolution_backfill.py" verify
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$ROOT/scripts/prepare-rc10-demo-service-data.py" \
    verify --demo-root "$DSH_INVESTMENT_STATE_DIR"
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$ROOT/scripts/rc10-demo-preflight.py" \
    --repo-root "$ROOT" --state-root "$DSH_INVESTMENT_STATE_DIR"
elif [[ "$ACTION" == "prepare" ]]; then
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$CORE/_demo_evolution_backfill.py" prepare
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$ROOT/scripts/prepare-rc10-demo-service-data.py" \
    prepare --demo-root "$DSH_INVESTMENT_STATE_DIR"
elif [[ "$ACTION" == "verify" ]]; then
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$CORE/_demo_evolution_backfill.py" verify
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$ROOT/scripts/prepare-rc10-demo-service-data.py" \
    verify --demo-root "$DSH_INVESTMENT_STATE_DIR"
else
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" "$CORE/_demo_evolution_backfill.py" "$ACTION"
fi
