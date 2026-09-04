# -*- coding: utf-8 -*-
"""管理隔离的自进化演示状态。"""

import argparse
import os
from pathlib import Path

from adapter.config import settings
from adapter.demo_evolution import (
    clean_demo_state,
    prepare_demo_state,
    require_demo_state,
    seed_deterministic_demo,
    verify_demo_state,
)
from adapter.store import JsonStore


def _root() -> Path:
    raw = os.getenv("DSH_INVESTMENT_STATE_DIR", "").strip()
    if not raw or settings.state_root is None:
        raise ValueError("必须通过 DSH_INVESTMENT_STATE_DIR 指定独立演示状态目录")
    return Path(raw).expanduser().resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description="准备、验证或清理隔离的自进化演示状态")
    parser.add_argument(
        "action", choices=("prepare", "verify", "clean"), nargs="?", default="prepare"
    )
    args = parser.parse_args()
    root = _root()

    if args.action == "clean":
        clean_demo_state(root)
        print(f"已清理演示状态：{root}")
        return 0

    if args.action == "prepare":
        prepare_demo_state(root)
    else:
        require_demo_state(root)
    store = JsonStore()

    if args.action == "prepare":
        result = seed_deterministic_demo(store)
        print(f"已重建 5 日确定性演示数据：{result['dates'][0]} → {result['dates'][-1]}")
    verified = verify_demo_state(store)
    print(
        f"校验通过：{verified['days']} 个有效交易日 "
        f"({verified['dates'][0]} → {verified['dates'][-1]})；"
        f"场景={','.join(verified['scenarios'])}；"
        f"变异子策略={verified['children']}；"
        f"动作={','.join(verified['action_types'])}；"
        f"回测任务={verified['backtest_task_id']}；"
        f"影子任务={verified['shadow_task_id']}；报告={verified['reports']}"
    )
    print(f"查看演示时请保持 DSH_INVESTMENT_STATE_DIR={root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
