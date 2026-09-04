#!/usr/bin/env bash
# Script entry point: arrow-key TUI menu, dispatch to scripts under scripts/.
# Cross-platform: Linux/macOS native; on Windows use Git Bash.
# Usage:
#   bash scripts/main.sh                    # interactive menu
#   bash scripts/main.sh sync-upstream      # direct dispatch
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- 投研产品入口优先，手动常驻后台仅用于独立调试："name|description|script path"
SCRIPTS=(
  "init|初始化项目（前端依赖/构建 + 投研 Python 环境）|scripts/init.sh"
  "investment-web|构建并启动 Web 版投研（自动托管并清理后台）|scripts/run-investment-web.sh"
  "investment-electron|构建并启动 Electron 版投研（自动托管并清理后台）|scripts/run-investment-electron.sh"
  "backend-start|手动启动常驻投研后台（独立调试）|scripts/start-investment-backends.sh"
  "backend-stop|停止手动常驻投研后台|scripts/stop-investment-backends.sh"
  "sync-upstream|同步上游 deepseek-harness 到 frontend/|scripts/sync-upstream.sh"
  "demo-evolution-data|演示数据：准备最近历史5个交易日的影子验证数据，让自进化页面可以展示进化闭环|scripts/prepare-demo-evolution-data.sh"
  "demo-rc10-preflight|rc.10 演示前检查：状态隔离、开关、历史、权重来源、报告与 AI 边界|scripts/prepare-demo-evolution-data.sh preflight"
  "demo-rc10-runbook|rc.10 中文全链路彩排脚本|scripts/run-rc10-demo.sh"
)

# Colors (disabled if not a tty or terminal doesn't support)
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold); DIM=$(tput sgr0); REV=$(tput rev)
else
  BOLD=""; DIM=""; REV=""
fi

draw_menu() {
  local sel=$1
  # Move cursor up to redraw (first draw: move to top of menu block)
  if (( FIRST_DRAW == 0 )); then
    FIRST_DRAW=1
  else
    printf '\033[%dA' "$((${#SCRIPTS[@]} + 2))" 2>/dev/null || true
  fi
  echo "${BOLD}=== pa-investment-research 脚本菜单 ===${DIM}  (↑↓ 移动, 回车 运行, q 退出)${DIM}"
  local i=0
  for entry in "${SCRIPTS[@]}"; do
    local desc="${entry#*|}"; desc="${desc%%|*}"
    if (( i == sel )); then
      echo " ${REV} ▸ $((i + 1)). $desc ${DIM}"
    else
      echo "   $((i + 1)). $desc"
    fi
    i=$((i + 1))
  done
  echo "${DIM}──────────────────────────────${DIM}"
}

run_script() {
  local target="$1"; shift || true
  echo
  if [[ "$target" == *.sh ]]; then
    bash "$ROOT/$target" "$@"
  else
    bash -c "$target"
  fi
}

# Direct dispatch: bash scripts/main.sh <name> [args...]
if [[ $# -gt 0 ]]; then
  for entry in "${SCRIPTS[@]}"; do
    if [[ "$1" == "${entry%%|*}" ]]; then
      shift
      run_script "${entry##*|}" "$@"
      exit 0
    fi
  done
  echo "[错误] 未知命令: $1" >&2
  exit 1
fi

# Interactive arrow-key menu (falls back to number input if not a tty)
SEL=0
FIRST_DRAW=0
if [[ -t 0 ]]; then
  draw_menu "$SEL"
  # Hide cursor, restore on exit
  tput civis 2>/dev/null || true
  trap 'tput cnorm 2>/dev/null || true; echo' EXIT
  while true; do
    # Read one char; escape sequences arrive as 3 bytes (ESC [ A/B)
    IFS= read -rsn1 key
    case "$key" in
      $'\x1b')
        read -rsn2 -t 1 seq || seq=""
        case "$seq" in
          '[A'|'OA') SEL=$(( (SEL - 1 + ${#SCRIPTS[@]}) % ${#SCRIPTS[@]} )) ;;
          '[B'|'OB') SEL=$(( (SEL + 1) % ${#SCRIPTS[@]} )) ;;
        esac
        ;;
      j) SEL=$(( (SEL + 1) % ${#SCRIPTS[@]} )) ;;
      k) SEL=$(( (SEL - 1 + ${#SCRIPTS[@]}) % ${#SCRIPTS[@]} )) ;;
      '') break ;;  # Enter
      q|Q) exit 0 ;;
    esac
    draw_menu "$SEL"
  done
else
  # Fallback: plain numbered prompt (e.g. piped stdin)
  echo "${BOLD}=== pa-investment-research 脚本菜单 ===${DIM}"
  i=1
  for entry in "${SCRIPTS[@]}"; do
    desc="${entry#*|}"; desc="${desc%%|*}"
    echo "  $i) $desc"
    i=$((i + 1))
  done
  read -rp "请选择 (1-${#SCRIPTS[@]}): " choice
  [[ "$choice" =~ ^[0-9]+$ ]] || { echo "[错误] 无效的选择" >&2; exit 1; }
  (( choice >= 1 && choice <= ${#SCRIPTS[@]} )) || { echo "[错误] 无效的选择" >&2; exit 1; }
  SEL=$((choice - 1))
fi

ENTRY="${SCRIPTS[$SEL]}"
run_script "${ENTRY##*|}"
