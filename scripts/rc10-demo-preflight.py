#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rc.10 演示前静态合同与隔离状态检查。"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


MARKER = ".dsh-evolution-demo-state"
MARKER_CONTENT = "dsh-evolution-demo-state:v1\n"


def _contains(path: Path, needles: tuple[str, ...]) -> bool:
    if not path.is_file():
        return False
    body = path.read_text(encoding="utf-8")
    return all(needle in body for needle in needles)


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 rc.10 演示环境和产品入口")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--state-root", required=True)
    args = parser.parse_args()

    repo = Path(args.repo_root).expanduser().resolve()
    state = Path(args.state_root).expanduser().resolve()
    sys.path.insert(0, str(repo / "backend/dsh-trading-core"))
    from adapter.config import settings

    authoritative = os.getenv("DSH_INVESTMENT_STATE_DIR", "").strip()
    compatible = os.getenv("DSH_DEMO_STATE_DIR", "").strip()
    checks: list[tuple[str, bool, str]] = [
        (
            "演示状态变量一致",
            bool(authoritative)
            and Path(authoritative).expanduser().resolve() == state
            and (not compatible or Path(compatible).expanduser().resolve() == state),
            "设置 DSH_INVESTMENT_STATE_DIR 为演示后端使用的绝对目录；兼容变量如存在必须相同",
        ),
        (
            "演示 marker",
            (state / MARKER).is_file()
            and (state / MARKER).read_text(encoding="utf-8") == MARKER_CONTENT,
            "先运行 prepare，且不要把日常状态目录伪装成演示目录",
        ),
        (
            "浅色主题入口",
            _contains(
                repo / "frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx",
                ("当前浅色模式，切换为深色模式", "当前深色模式，切换为浅色模式"),
            ),
            "恢复 InvestmentShell 的明暗主题切换可访问名称",
        ),
        (
            "实时盯盘 AI 让位",
            _contains(
                repo / "frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx",
                ('data-assistant-layout={assistantLayout}', 'newsRail.setAttribute(\'inert\', \'\')'),
            ),
            "恢复实时盯盘 docked 布局和资讯栏 inert 让位合同",
        ),
        (
            "AI 非事实源",
            _contains(
                repo / "frontend/packages/client/ui-investment-research/src/client/assistant-intent.ts",
                ("这些字段是产品事实，不由模型推断", "investment_context"),
            ),
            "恢复确定性事实提示和 investment_context 受控读取",
        ),
        (
            f"自动闭环开关可观测（当前 {'开启' if settings.closed_loop_enabled else '关闭'}）",
            _contains(
                repo / "backend/dsh-trading-core/adapter/config.py",
                ("closed_loop_enabled", "CLOSED_LOOP_ENABLED"),
            ),
            "恢复 CLOSED_LOOP_ENABLED 配置读取与状态接口投影",
        ),
        (
            f"自动复测开关可观测（当前 {'开启' if settings.auto_retest_enabled else '关闭'}）",
            _contains(
                repo / "backend/dsh-trading-core/adapter/config.py",
                ("auto_retest_enabled", "AUTO_RETEST_ENABLED"),
            ),
            "恢复 AUTO_RETEST_ENABLED 配置读取与调度门禁",
        ),
        (
            "演示数据门槛为 5 日",
            settings.evolve_min_days == 5,
            "为演示后端设置 EVOLVE_MIN_DAYS=5，避免页面与固定夹具不一致",
        ),
        (
            "回测与影子历史入口",
            _contains(
                repo / "frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx",
                ("暂无回测任务历史", "影子验证历史", "全部策略运行记录"),
            ),
            "恢复策略回测历史和影子任务历史入口",
        ),
        (
            "产业链权重来源",
            _contains(
                repo / "frontend/packages/client/ui-investment-research/src/client/ProductPages.tsx",
                ("默认关系权重", "非披露占比", "关系权重未披露"),
            )
            and _contains(
                repo / "backend/industry-chain/dsh-plugin/src/render.ts",
                ("share_source", "默认关系权重", "披露关系占比"),
            ),
            "恢复前后端 share_source 与披露/默认/未披露文案合同",
        ),
        (
            "投研报告入口",
            _contains(
                repo / "frontend/packages/client/ui-investment-research/src/client/InvestmentShell.tsx",
                ('aria-label="投研报告"', 'title="投研报告"'),
            ),
            "恢复唯一投研报告入口",
        ),
    ]

    failed = False
    for name, ok, action in checks:
        if ok:
            print(f"[通过] {name}")
        else:
            failed = True
            print(f"[失败] {name}：{action}")
    if failed:
        print("[结论] 演示前检查未通过；修复以上项目后重新运行 preflight")
        return 1
    print("[结论] rc.10 演示前检查通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
