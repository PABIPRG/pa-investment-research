#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""准备/验证 rc.10 隔离 market-watch 与 industry-chain 确定性输入。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


EVENT_ID = "demo-rc10-event-001"
COMPANY_CODE = "600000"
DEMO_MARKER = ".dsh-evolution-demo-state"
MARKER_CONTENT = "dsh-evolution-demo-state:v1\n"
SEED_FILES = (
    "stats.json",
    "companies.json",
    "market-caps.json",
    "view-data-all.json",
    "network-data.json",
)


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def require_demo_root(root: Path) -> Path:
    marker = root / DEMO_MARKER
    if (
        root == Path(root.anchor)
        or root == Path.home()
        or not marker.is_file()
        or marker.read_text(encoding="utf-8") != MARKER_CONTENT
    ):
        raise ValueError(f"拒绝操作未标记的状态目录: {root}")
    return root


def _fixtures() -> dict[str, object]:
    companies = [
        {"code": "600000", "name": "浦发银行", "industry": "银行", "exchange": "SH", "is_subject": True},
        {"code": "600036", "name": "招商银行", "industry": "银行", "exchange": "SH", "is_subject": True},
        {"code": "300033", "name": "同花顺", "industry": "金融科技", "exchange": "SZ", "is_subject": True},
    ]
    view = {
        "600000": {
            **companies[0],
            "materials": [{
                "name": "金融科技系统",
                "suppliers": [
                    {"id": "300033", "name": "同花顺", "share": 5, "type": "direct"},
                    {"id": "demo-default", "name": "清算服务商", "share": None, "type": "direct"},
                    {"id": "demo-inferred", "name": "AI 风控服务商", "share": None, "type": "inferred", "confidence": 0.82},
                ],
            }],
            "products": [{
                "name": "企业金融服务",
                "customers": [
                    {"id": "600036", "name": "招商银行", "share": 12, "type": "direct"},
                    {"id": "demo-customer", "name": "中小企业客户", "share": None, "type": "direct"},
                ],
            }],
        },
        "600036": {**companies[1], "materials": [], "products": []},
        "300033": {**companies[2], "materials": [], "products": []},
    }
    nodes = [
        {"id": item["code"], "name": item["name"], "industry": item["industry"], "degree": 1, "is_subject": True}
        for item in companies
    ]
    return {
        "stats.json": {"companies": 3, "links": 4, "fixture": "rc10"},
        "companies.json": companies,
        "market-caps.json": {
            item["code"]: {"code": item["code"], "name": item["name"], "market_cap": 1000}
            for item in companies
        },
        "view-data-all.json": {"companies": view},
        "network-data.json": {
            "nodes": nodes,
            "links": [
                {"source": "300033", "target": "600000", "kind": "supplier", "share": 5, "type": "direct"},
                {"source": "demo-inferred", "target": "600000", "kind": "supplier", "share": None, "type": "inferred", "confidence": 0.82},
                {"source": "600000", "target": "600036", "kind": "customer", "share": 12, "type": "direct"},
                {"source": "600000", "target": "demo-customer", "kind": "customer", "share": None, "type": "direct"},
            ],
            "macro_communities": [],
        },
    }


def prepare(root: Path) -> None:
    market_data = root / "services" / "market-watch" / "data"
    industry_seed = root / "services" / "industry-chain" / "data" / "seed"
    events = []
    for index in range(55):
        code = COMPANY_CODE if index == 0 else f"{index + 1:06d}"
        events.append({
            "id": EVENT_ID if index == 0 else f"demo-rc10-event-{index + 1:03d}",
            "item_id": f"demo-rc10-news-{index + 1:03d}",
            "type": "产业",
            "tickers": [{"name": "浦发银行" if index == 0 else f"演示公司 {index + 1:02d}", "code": code}],
            "industries": ["银行" if index == 0 else f"演示行业{index + 1:02d}"],
            "direction": "利好" if index % 2 == 0 else "中性",
            "summary": "金融科技投入提升银行产业链协同效率" if index == 0 else f"稳定事件 {index + 1:02d}：验证最多展示 50 条",
            "title": "演示事件：金融科技投入提升银行产业链协同效率" if index == 0 else f"演示事件 {index + 1:02d}",
            "time": f"2026-09-04 09:{index % 60:02d}:00",
            "source": "rc.10 确定性演示夹具",
            "url": "",
            "demo_provenance": {"kind": "demo_fixture", "fixture": "rc10"},
        })
    events.insert(2, {**events[0], "summary": "金融科技事件的重复副本"})
    _write(
        market_data / "events.json",
        {"seen_ids": [event["item_id"] for event in events], "latest": events},
    )
    for name, value in _fixtures().items():
        _write(industry_seed / name, value)


def verify(root: Path) -> dict[str, object]:
    market_path = root / "services" / "market-watch" / "data" / "events.json"
    industry_seed = root / "services" / "industry-chain" / "data" / "seed"
    market = json.loads(market_path.read_text(encoding="utf-8"))
    events = market.get("latest") if isinstance(market, dict) else None
    if not isinstance(events, list) or len(events) != 56:
        raise ValueError("market-watch 演示事件必须是 55 个唯一 ID 加 1 个重复副本")
    event = events[0]
    if (
        event.get("id") != EVENT_ID
        or ((event.get("tickers") or [{}])[0]).get("code") != COMPANY_CODE
        or event.get("demo_provenance") != {"kind": "demo_fixture", "fixture": "rc10"}
    ):
        raise ValueError("market-watch 演示事件合同不完整")
    loaded = {
        name: json.loads((industry_seed / name).read_text(encoding="utf-8"))
        for name in SEED_FILES
    }
    center = ((loaded["view-data-all.json"] or {}).get("companies") or {}).get(COMPANY_CODE)
    if not isinstance(center, dict):
        raise ValueError("industry-chain 演示中心公司缺失")
    suppliers = ((center.get("materials") or [{}])[0]).get("suppliers") or []
    customers = ((center.get("products") or [{}])[0]).get("customers") or []
    sources = {
        "inferred" if row.get("type") == "inferred" else "disclosed" if row.get("share") is not None else "default"
        for row in suppliers + customers
    }
    if sources != {"disclosed", "default", "inferred"}:
        raise ValueError(f"产业链权重来源场景不完整: {sorted(sources)}")
    if len({str(row.get("id") or "") for row in events}) != 55:
        raise ValueError("market-watch 演示事件稳定 ID 去重合同不完整")
    return {"events": 55, "companies": len(loaded["companies.json"]), "weight_sources": sorted(sources)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "verify"))
    parser.add_argument("--demo-root", required=True)
    args = parser.parse_args()
    root = Path(args.demo_root).expanduser().resolve()
    try:
        require_demo_root(root)
    except ValueError as exc:
        print(f"服务夹具校验失败：{exc}")
        return 2
    if args.action == "prepare":
        prepare(root)
    result = verify(root)
    print(
        "服务夹具校验通过："
        f"事件={result['events']}；公司={result['companies']}；"
        f"权重来源={','.join(result['weight_sources'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
