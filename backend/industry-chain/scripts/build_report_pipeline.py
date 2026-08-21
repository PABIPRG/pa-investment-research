#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""研报管线入口：东财研报抓取 → DeepSeek 抽取 → overlay 增量并入图谱。

用法：
  python scripts/build_report_pipeline.py --codes=600315,688363     # 试点 2 家（默认全流程）
  python scripts/build_report_pipeline.py --industry=化妆品         # 按行业匹配 companies.json
  python scripts/build_report_pipeline.py --codes=600315 --force    # 强制重抓重抽
  python scripts/build_report_pipeline.py --codes=600315 --report-only   # 只抓不抽不合并
  python scripts/build_report_pipeline.py --codes=600315 --extract-only  # 抓+抽，不合并
  python scripts/build_report_pipeline.py --codes=600315 --merge-only    # 只合并已有 extracted.json

默认（无 flag）：已抓过/已抽过的阶段跳过，只补合并（幂等）。
Windows 下务必 PYTHONIOENCODING=utf-8 运行。
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from industry_chain import extract, graph, merge, reports, universe  # noqa: E402


def resolve_codes(codes: str | None, industry: str | None) -> list[str]:
    if codes:
        return [c.strip() for c in codes.split(",") if c.strip()]
    if industry:
        hits = [c.get("code") for c in graph.companies() if (c.get("industry") or "") == industry]
        if not hits:
            raise SystemExit(f"companies.json 未找到行业「{industry}」的公司")
        return [c for c in hits if c]
    raise SystemExit("需指定 --codes=600315,688363 或 --industry=化妆品")


def resolve_name(code: str) -> str:
    for c in graph.companies():
        if c.get("code") == code:
            return c.get("name") or code
    u = universe.universe_index().get(code)
    return (u or {}).get("name") or code


def has_html(code: str) -> bool:
    d = reports.REPORTS_DIR / code
    return d.is_dir() and (d / "meta.json").is_file()


def has_extracted(code: str) -> bool:
    return (reports.REPORTS_DIR / code / "extracted.json").is_file()


def step_report(code: str, force: bool) -> list[dict]:
    if not force and has_html(code):
        lst = reports.load_company_reports(code)
        print(f"{code}: 研报已抓取 {len(lst)} 篇（--force 重抓）")
        return lst
    lst = reports.download_company_reports(code)
    print(f"{code}: 抓取研报 {len(lst)} 篇 -> data/reports/{code}/")
    return lst


def step_extract(code: str, force: bool) -> dict | None:
    out_path = reports.REPORTS_DIR / code / "extracted.json"
    if not force and out_path.is_file():
        print(f"{code}: 抽取结果已存在（--force 重抽）")
        return json.loads(out_path.read_text(encoding="utf-8"))
    lst = reports.load_company_reports(code)
    texts = [p for r in lst for p in (r.get("_body") or [])]  # 展平多篇正文段落
    if not texts:
        print(f"{code}: 无研报正文可抽取")
        return None
    name = resolve_name(code)
    print(f"{code}: DeepSeek 抽取中（{sum(len(t) for t in texts)} 段正文）...")
    extracted = extract.extract_relations(code, name, texts)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(extracted, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{code}: 抽取完成 materials={len(extracted.get('materials') or [])} "
          f"products={len(extracted.get('products') or [])} "
          f"related={len(extracted.get('related') or [])} "
          f"metrics={len(extracted.get('metrics') or [])}")
    return extracted


def step_merge(code: str) -> None:
    out_path = reports.REPORTS_DIR / code / "extracted.json"
    if not out_path.is_file():
        print(f"{code}: 无 extracted.json，先跑抓取+抽取（--extract-only 或默认全流程）")
        return
    extracted = json.loads(out_path.read_text(encoding="utf-8"))
    cur = merge.merge_into_graph(code, extracted)
    print(f"{code}: 已合并入 overlay（materials={len(cur.get('materials') or [])} "
          f"products={len(cur.get('products') or [])} "
          f"related={len(cur.get('related') or [])} metrics={len(cur.get('metrics') or [])}）")


def main() -> None:
    ap = argparse.ArgumentParser(description="东财研报 → DeepSeek 抽取 → overlay 增量合并")
    ap.add_argument("--codes", help="逗号分隔的公司代码，如 600315,688363")
    ap.add_argument("--industry", help="按 companies.json 行业匹配公司（如 化妆品）")
    ap.add_argument("--force", action="store_true", help="强制重抓重抽")
    ap.add_argument("--report-only", action="store_true", help="只抓研报，不抽不合并")
    ap.add_argument("--extract-only", action="store_true", help="抓+抽，不合并")
    ap.add_argument("--merge-only", action="store_true", help="只合并已有 extracted.json")
    args = ap.parse_args()

    flags = [f for f in (args.report_only, args.extract_only, args.merge_only) if f]
    if len(flags) > 1:
        raise SystemExit("--report-only / --extract-only / --merge-only 互斥")
    mode = "report" if args.report_only else ("extract" if args.extract_only else ("merge" if args.merge_only else "all"))

    for code in resolve_codes(args.codes, args.industry):
        print(f"\n===== {code} =====")
        if mode in ("all", "report", "extract"):
            step_report(code, args.force)
        if mode in ("all", "extract"):
            step_extract(code, args.force)
        if mode in ("all", "merge"):
            step_merge(code)
    print("\n完成。重启 industry-chain 适配器后，/graph/entity / graph/single 即包含研报增量。")


if __name__ == "__main__":
    main()
