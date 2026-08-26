#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""显式下载 industry-chain 种子数据（项目不重新分发数据文件）。

源：IDUXGRAPH / iducsite 公开静态托管（https://villadora.github.io/iducsite/data/）。
数据由上市公司财报/研报自动化抽取 + Neo4j 图谱推断而来，仅供产业链研究与参考，
不构成投资建议，请结合原始公告 Double Check 核验。

用法：
  python scripts/fetch_seed_data.py            # 下载到默认 data/seed/
  python scripts/fetch_seed_data.py --check    # 只校验 5 个文件是否齐全，不下载

下载 5 个文件（共约 25MB）：
  stats.json / companies.json / market-caps.json / view-data-all.json / network-data.json
"""

import argparse
import sys
from pathlib import Path

# 模块根（本文件在 scripts/ 下）
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from industry_chain.config import settings  # noqa: E402
from industry_chain.seed_data import SeedDataManager  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="下载/校验 industry-chain 种子数据")
    ap.add_argument("--check", action="store_true", help="只校验数据是否齐全")
    ap.add_argument("--dir", default=str(settings.data_dir), help="目标目录")
    args = ap.parse_args()
    data_dir = Path(args.dir)

    manager = SeedDataManager(data_dir, settings.seed_base_url)
    status = manager.status()
    if status["status"] == "ready":
        print(f"种子数据已就绪：{data_dir}")
        return
    if args.check:
        print(f"种子数据缺失（{data_dir}），请运行 scripts/fetch_seed_data.py 下载")
        raise SystemExit(1)
    print("开始下载并校验 5 个种子数据文件……")
    result = manager.bootstrap()
    if result["status"] != "ready":
        print(f"种子数据下载失败：{result['error'] or '未知错误'}")
        raise SystemExit(1)
    print(f"种子数据就绪：{data_dir}（{result['downloaded_bytes'] / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
