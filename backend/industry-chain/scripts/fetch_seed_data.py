#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载 industry-chain 种子数据（打包自托管）。

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

import requests

# 模块根（本文件在 scripts/ 下）
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from industry_chain.config import settings  # noqa: E402

SEED_FILES = (
    "stats.json",
    "companies.json",
    "market-caps.json",
    "view-data-all.json",
    "network-data.json",
)

TIMEOUT = 60


def _files_ok(data_dir: Path) -> bool:
    if not data_dir.is_dir():
        return False
    return all((data_dir / f).is_file() and (data_dir / f).stat().st_size > 0 for f in SEED_FILES)


def fetch(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    base = settings.seed_base_url.rstrip("/")
    for name in SEED_FILES:
        url = f"{base}/{name}"
        dest = data_dir / name
        print(f"downloading {name} <- {url} ...", end=" ", flush=True)
        try:
            with requests.get(url, timeout=TIMEOUT, stream=True) as r:
                r.raise_for_status()
                size = 0
                with open(dest, "wb") as f:
                    for chunk in r.iter_content(1 << 16):
                        f.write(chunk)
                        size += len(chunk)
            print(f"{size / 1e6:.1f} MB OK")
        except Exception as exc:  # noqa: BLE001
            print(f"FAILED: {exc}")
            raise SystemExit(1)
    print(f"\n种子数据就绪：{data_dir}")


def main() -> None:
    ap = argparse.ArgumentParser(description="下载/校验 industry-chain 种子数据")
    ap.add_argument("--check", action="store_true", help="只校验数据是否齐全")
    ap.add_argument("--dir", default=str(settings.data_dir), help="目标目录")
    args = ap.parse_args()
    data_dir = Path(args.dir)

    if _files_ok(data_dir):
        print(f"种子数据已就绪：{data_dir}")
        return
    if args.check:
        print(f"种子数据缺失（{data_dir}），请运行 scripts/fetch_seed_data.py 下载")
        raise SystemExit(1)
    fetch(data_dir)


if __name__ == "__main__":
    main()
