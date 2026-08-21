# -*- coding: utf-8 -*-
"""研报抽取结果合并层：增量写入 data/reports/overlay.json。

overlay 是独立于 iducsite 数据的增量文件（view-data-all.json 永不改动），
由 graph.py 加载时叠加到图谱记录上。天然可逆（删文件即还原）、幂等（重跑不重复）。

结构：{code: {"materials":[...], "products":[...], "related":[...], "metrics":[...]}}
  materials[].suppliers[] / products[].customers[] 与 view-data-all 对齐；
  related[]/metrics[] 是研报新增字段（现有 schema 无，先留数据）。
"""

import json

from .config import settings

OVERLAY_PATH = settings.root / "data" / "reports" / "overlay.json"


def load_overlay() -> dict:
    if not OVERLAY_PATH.is_file():
        return {}
    with open(OVERLAY_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_overlay(ov: dict) -> None:
    OVERLAY_PATH.parent.mkdir(parents=True, exist_ok=True)
    OVERLAY_PATH.write_text(
        json.dumps(ov, ensure_ascii=False, indent=1), encoding="utf-8"
    )


def merge_into_graph(code: str, extracted: dict) -> dict:
    """把一次 LLM 抽取结果幂等合并进 overlay[code]，返回该 code 的 overlay 记录。"""
    ov = load_overlay()
    cur = ov.get(code, {"materials": [], "products": [], "related": [], "metrics": []})

    # materials：按 name 合并，suppliers 按 name 去重追加
    for m in extracted.get("materials") or []:
        if not m.get("name"):
            continue
        exist = next((x for x in cur["materials"] if x.get("name") == m["name"]), None)
        if exist is None:
            cur["materials"].append({"name": m["name"], "suppliers": list(m.get("suppliers") or [])})
        else:
            have = [s.get("name") for s in (exist.get("suppliers") or [])]
            for s in m.get("suppliers") or []:
                if s.get("name") and s["name"] not in have:
                    exist.setdefault("suppliers", []).append(s)
                    have.append(s["name"])

    # products：同上
    for p in extracted.get("products") or []:
        if not p.get("name"):
            continue
        exist = next((x for x in cur["products"] if x.get("name") == p["name"]), None)
        if exist is None:
            cur["products"].append({"name": p["name"], "customers": list(p.get("customers") or [])})
        else:
            have = [cu.get("name") for cu in (exist.get("customers") or [])]
            for cu in p.get("customers") or []:
                if cu.get("name") and cu["name"] not in have:
                    exist.setdefault("customers", []).append(cu)
                    have.append(cu["name"])

    # related：按 name 去重追加
    have_r = {r.get("name") for r in cur["related"]}
    for r in extracted.get("related") or []:
        if r.get("name") and r["name"] not in have_r:
            cur["related"].append(r)
            have_r.add(r["name"])

    # metrics：按 metric 名去重追加
    have_m = {mt.get("metric") for mt in cur["metrics"]}
    for mt in extracted.get("metrics") or []:
        if mt.get("metric") and mt["metric"] not in have_m:
            cur["metrics"].append(mt)
            have_m.add(mt["metric"])

    ov[code] = cur
    save_overlay(ov)
    return cur
