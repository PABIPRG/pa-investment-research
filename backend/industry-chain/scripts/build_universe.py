#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拉取全 A 股兜底清单（东财行情列表接口），写 data/a_share_universe.json。

用法：
  python scripts/build_universe.py            # 已存在则跳过
  python scripts/build_universe.py --force    # 强制重拉覆盖
  python scripts/build_universe.py --count    # 只显示本地条数
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from industry_chain import universe  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="拉取全 A 股兜底清单")
    ap.add_argument("--force", action="store_true", help="强制重新拉取覆盖")
    ap.add_argument("--count", action="store_true", help="只显示本地清单条数")
    args = ap.parse_args()

    if args.count:
        rows = universe.load_rows()
        print(f"全 A 股兜底清单：{len(rows)} 条（{universe.UNIVERSE_PATH}）")
        return

    rows = universe.fetch_universe(force=args.force)
    print(f"全 A 股兜底清单：{len(rows)} 条 -> {universe.UNIVERSE_PATH}")


if __name__ == "__main__":
    main()
