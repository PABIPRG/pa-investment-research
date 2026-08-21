#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全 A 股孤立股 LLM 补边：分批调 DeepSeek 挖掘孤立 A 股的供应链关联。

全 A 股拓扑有 ~3692 家孤立股（无任何 A→A 供应链边）。本脚本按行业分批，
每批把孤立股 + 同行业已知有边 A 股对照名单交给 LLM，让它推断供应商/客户边，
按置信度分级落到 data/a_share_llm_links.json（graph.a_share_links 已接入）。

用法：
  python scripts/build_llm_links.py                        # 全量跑（断点续跑，跳过 done_batches）
  python scripts/build_llm_links.py --batches=医药,电子     # 只跑指定行业（精确匹配）
  python scripts/build_llm_links.py --limit-batch=10       # 每批孤立股上限（小批量调试）
  python scripts/build_llm_links.py --force                # 清空 links+done_batches 全量重跑
  python scripts/build_llm_links.py --list-industries      # 列出行业及孤立股数，不跑 LLM

Windows 下务必 PYTHONIOENCODING=utf-8 运行。
"""

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from industry_chain import extract, graph, universe  # noqa: E402

OUT_PATH = graph.LLM_LINKS_PATH          # data/a_share_llm_links.json（与 graph._llm_links 同路径）
_BATCH_SOLO_MAX = 35                     # 每批孤立股上限（大行业拆子批）
_BATCH_KNOWN_MAX = 20                    # 每批同行业已知有边 A 股对照上限
_MIN_CONF = 0.5                          # 置信度阈值：低于此丢弃
_BETWEEN_BATCH_SLEEP = 0.5               # 批间隔（DeepSeek 限速）

_SYSTEM = (
    "你是 A 股供应链研究助手。给定一批 A 股上市公司（代码+名称），判断彼此之间"
    "可能存在的供应商-客户上下游关系，输出严格 JSON：\n\n"
    '{"links": [{"source": "6位代码或公司名", "target": "6位代码或公司名", '
    '"kind": "supplier", "item": "交易的产品或原材料名", "confidence": 0.85}]}\n\n'
    "规则：\n"
    "1. 只输出【名单内】公司之间的边，禁止出现名单外的公司；不要自环。\n"
    "2. kind=supplier 表示 source 是 target 的上游供应商（target 向 source 采购）；\n"
    "   kind=customer 表示 source 是 target 的下游客户（target 向 source 供货）。\n"
    "3. item 填交易的主要产品或原材料名（如「玻尿酸原料」「锂电正极材料」），不确定留空字符串。\n"
    "4. confidence 0-1 表示把握度：有明确公开认知的给 0.7 以上；只有行业泛泛关联、"
    "无明确供需关系的不要输出，或给 0.5 以下。\n"
    "5. 宁可少而准，不要臆造。source/target 优先写 6 位数字代码；记不住代码就写公司名。\n"
    "6. 只输出 JSON 对象。"
)

_USER_TEMPLATE = """以下公司属于同一产业（行业：{industry}）：

孤立股（需判断供应链位置）：
{isolated}

已知供应链 A 股（已有上下游，供参考挂链）：
{known}

请输出上述 JSON（只在名单内公司之间建边）。"""


def _load() -> dict:
    if OUT_PATH.is_file():
        return json.loads(OUT_PATH.read_text(encoding="utf-8"))
    return {"links": [], "done_batches": []}


def _resolve(v) -> str | None:
    """LLM 输出的公司名/code → universe code（复用 graph._resolve_a_share，剥公司后缀再试一次）。"""
    if not v:
        return None
    v = str(v).strip()
    c = graph._resolve_a_share({"id": v, "name": v})
    if c:
        return c
    for suf in ("股份有限公司", "有限公司", "集团公司", "公司", "集团", "股份"):
        if v.endswith(suf):
            c = graph._resolve_a_share({"id": None, "name": v[: -len(suf)]})
            if c:
                return c
    return None


def build_batches(industries: list[str] | None, limit_batch: int) -> list[dict]:
    """按行业分批：孤立股（≤limit_batch/批）+ 同行业已知有边 A 股对照（≤20/批）。"""
    u = universe.universe_index()
    degrees = graph.a_share_links()["degrees"]
    isolated: dict[str, list[str]] = {}
    known: dict[str, list[str]] = {}
    for code, rec in u.items():
        ind = rec.get("industry") or "其他"
        d = degrees.get(code)
        if d and (d.get("up") or d.get("down")):
            known.setdefault(ind, []).append(code)
        else:
            isolated.setdefault(ind, []).append(code)
    if industries:
        miss = [i for i in industries if i not in isolated]
        if miss:
            print(f"警告：未找到这些行业的孤立股：{','.join(miss)}（有效行业可用 --list-industries 查看）")
        isolated = {i: c for i, c in isolated.items() if i in industries}
        known = {i: c for i, c in known.items() if i in isolated}
    batches: list[dict] = []
    for ind in sorted(isolated):
        solo = isolated[ind]
        known_codes = known.get(ind, [])[:_BATCH_KNOWN_MAX]
        for i in range(0, len(solo), limit_batch):
            batches.append({
                "key": f"{ind}#{i // limit_batch}",
                "industry": ind,
                "solo": solo[i:i + limit_batch],
                "known": known_codes,
            })
    return batches


def run_batch(b: dict) -> list[dict]:
    """调 LLM 挖掘本批边；解析到 universe code 并过滤后返回。"""
    u = universe.universe_index()

    def fmt(codes: list[str]) -> str:
        return "\n".join(f"{c} {u[c].get('name') or ''}" for c in codes)

    prompt = _USER_TEMPLATE.format(
        industry=b["industry"], isolated=fmt(b["solo"]), known=fmt(b["known"])
    )
    parsed = extract.chat_json(_SYSTEM, prompt, raw=True)
    allow = set(b["solo"]) | set(b["known"])
    new_links: list[dict] = []
    for l in parsed.get("links") or []:
        if not isinstance(l, dict):
            continue
        src, tgt = _resolve(l.get("source")), _resolve(l.get("target"))
        if not src or not tgt or src == tgt or src not in allow or tgt not in allow:
            continue
        try:
            conf = float(l.get("confidence"))
        except (TypeError, ValueError):
            continue
        if conf < _MIN_CONF:
            continue
        kind = l.get("kind") if l.get("kind") in ("supplier", "customer") else "supplier"
        new_links.append({
            "source": src, "target": tgt, "kind": kind,
            "item": (l.get("item") or "")[:30],
            "confidence": round(conf, 2),
            "note": b["industry"],
        })
    return new_links


def list_industries() -> None:
    u = universe.universe_index()
    degrees = graph.a_share_links()["degrees"]
    counts: Counter = Counter()
    for code, rec in u.items():
        d = degrees.get(code)
        if not (d and (d.get("up") or d.get("down"))):
            counts[rec.get("industry") or "其他"] += 1
    print("行业\t孤立股数")
    for ind, n in counts.most_common():
        print(f"{ind}\t{n}")
    print(f"\n合计孤立股 {sum(counts.values())} 家")


def main() -> None:
    ap = argparse.ArgumentParser(description="全 A 股孤立股 LLM 补边（分批挖掘供应链边）")
    ap.add_argument("--batches", help="只跑指定行业，逗号分隔（精确匹配，如 医药,电子）")
    ap.add_argument("--limit-batch", type=int, default=_BATCH_SOLO_MAX, help=f"每批孤立股上限（默认 {_BATCH_SOLO_MAX}）")
    ap.add_argument("--force", action="store_true", help="清空 links+done_batches 全量重跑")
    ap.add_argument("--list-industries", action="store_true", help="列出行业及孤立股数后退出")
    args = ap.parse_args()

    if args.list_industries:
        list_industries()
        return

    industries = [s.strip() for s in (args.batches or "").split(",") if s.strip()] or None
    batches = build_batches(industries, args.limit_batch)
    if not batches:
        print("没有可跑的批次（全部孤立股已补边？用 --force 重跑）")
        return
    print(f"共 {len(batches)} 批（行业 {len({b['industry'] for b in batches})} 个）")

    data = _load() if not args.force else {"links": [], "done_batches": []}
    done = set(data["done_batches"])
    todo = [b for b in batches if b["key"] not in done] if not args.force else batches
    if not todo:
        print("所有批次已跑完（--force 重跑全量）")
        return
    print(f"待跑 {len(todo)} 批，已跳过 {len(batches) - len(todo)} 批")

    total_new = 0
    for i, b in enumerate(todo, 1):
        try:
            new_links = run_batch(b)
        except Exception as exc:  # noqa: BLE001 —— 单批失败不阻塞后续，断点续跑时重试
            print(f"[{i}/{len(todo)}] {b['key']} 失败: {exc}")
            continue
        data["links"].extend(new_links)
        data["done_batches"].append(b["key"])
        total_new += len(new_links)
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[{i}/{len(todo)}] {b['key']} 新增 {len(new_links)} 条（累计 {total_new}，已落盘）")
        time.sleep(_BETWEEN_BATCH_SLEEP)

    print(f"\n完成。新增 {total_new} 条 LLM 推断边，总边数 {len(data['links'])}，"
          f"已完成批次 {len(data['done_batches'])}/{len(batches)}。"
          "\n重启 8200 适配器后 /graph/network?include_universe=1 即含推断边。")


if __name__ == "__main__":
    main()
