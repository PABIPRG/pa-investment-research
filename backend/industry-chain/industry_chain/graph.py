# -*- coding: utf-8 -*-
"""产业链图谱数据层：懒加载种子数据 + 纯内存图谱查询（无 I/O 依赖）。

数据源自 IDUXGRAPH / iducsite（上市公司财报/研报自动抽取 + Neo4j 图内推断）：
  companies.json        1297 家上市公司列表 {code,name,industry,exchange,is_subject,...}
  view-data-all.json    每公司 {materials:[{...,suppliers:[...]}], products:[{...,customers:[...]}]}
  network-data.json     全局网络 {nodes:[{degree,macroId,init_x,init_y,color,...}], links, macro_communities, stats}
  market-caps.json      市值（按名称索引，少量核心公司）
  stats.json            图统计

懒加载：各数据集首次访问时读入模块级缓存（两个大文件 ~10-15MB JSON，内存放大数倍，
桌面工具可接受）。全部查询为纯函数，返回可 JSON 序列化的 dict/list。
"""

import json
import threading
from functools import lru_cache

from .config import settings
from . import merge, universe

_lock = threading.Lock()
_caches: dict[str, object] = {}


def _load(name: str):
    """读取一份种子数据（带锁懒加载 + 模块级缓存）。"""
    with _lock:
        if name not in _caches:
            path = settings.data_dir / name
            if not path.is_file():
                raise FileNotFoundError(
                    f"种子数据缺失: {path} —— 请先运行 init.sh 或 scripts/fetch_seed_data.py 下载"
                )
            with open(path, encoding="utf-8") as f:
                _caches[name] = json.load(f)
    return _caches[name]


def invalidate() -> None:
    """清空全部缓存（原始数据 + 派生索引 + overlay 叠加），供数据变更后让新数据生效。"""
    with _lock:
        _caches.clear()
        _view_name_index.cache_clear()
        _cap_index.cache_clear()
        _external_index.cache_clear()
        _view_merged.cache_clear()
        _overlay.cache_clear()


# ---- 数据访问 ------------------------------------------------------------


def companies() -> list:
    return _load("companies.json")


@lru_cache(maxsize=1)
def _overlay() -> dict:
    """研报 overlay 增量（data/reports/overlay.json）。运行期不变，重启后生效。"""
    return merge.load_overlay()


def _merge_named(lst: list, item: dict, child_key: str) -> None:
    """按 name 把 overlay 条目合并进列表（同名则 child_key 子项按 name 去重追加）。"""
    exist = next((x for x in lst if x.get("name") == item.get("name")), None)
    if exist is None:
        lst.append(item)
        return
    have = [c.get("name") for c in (exist.get(child_key) or [])]
    for c in item.get(child_key) or []:
        if c.get("name") and c["name"] not in have:
            exist.setdefault(child_key, []).append(c)
            have.append(c["name"])


def _apply_overlay(rec: dict, extra: dict) -> dict:
    """单公司记录叠加 overlay 增量（materials/products 合并 + related/metrics 字段）。"""
    materials = list(rec.get("materials") or [])
    products = list(rec.get("products") or [])
    for m in extra.get("materials") or []:
        if m.get("name"):
            _merge_named(materials, m, "suppliers")
    for p in extra.get("products") or []:
        if p.get("name"):
            _merge_named(products, p, "customers")
    out = dict(rec)
    out["materials"] = materials
    out["products"] = products
    if extra.get("related") is not None:
        out["related"] = extra["related"]
    if extra.get("metrics") is not None:
        out["metrics"] = extra["metrics"]
    return out


@lru_cache(maxsize=1)
def _view_merged() -> dict:
    """view-data-all 公司记录 + 研报 overlay 叠加。

    只对 overlay 命中的 code 做 record 级合并（外层浅拷贝），大文件本体不复制。
    view_companies / 各类索引（含 _external_index）都以本函数为源，研报增量自动生效。
    """
    base = _load("view-data-all.json")["companies"]
    ov = _overlay()
    if not ov:
        return base
    merged = dict(base)
    for code, extra in ov.items():
        rec = base.get(code)
        if rec is None:
            continue  # 图谱外公司（纯兜底 A 股）不走图谱叠加
        merged[code] = _apply_overlay(rec, extra)
    return merged


def view_companies() -> dict:
    return _view_merged()


def network() -> dict:
    return _load("network-data.json")


def market_caps() -> dict:
    return _load("market-caps.json")


def stats_raw() -> dict:
    return _load("stats.json")


@lru_cache(maxsize=1)
def _view_name_index() -> dict:
    """view_data 中 name → code（2594 实体，用于 name/供应商解析）。"""
    idx: dict[str, str] = {}
    for code, c in view_companies().items():
        n = c.get("name")
        if n:
            idx[n] = code
    return idx


@lru_cache(maxsize=1)
def _cap_index() -> dict:
    """code → market-caps.json 单条（市值/价格/展示文案）。"""
    idx: dict[str, dict] = {}
    for entry in market_caps().values():
        code = entry.get("code")
        if code:
            idx[code] = entry
    return idx


def _resolve_code(name_or_id: str) -> str | None:
    """实体名/ID → 核心公司 code（不在图谱内的实体返回 None，BFS 视为叶子）。"""
    v = view_companies()
    if name_or_id in v:
        return name_or_id
    return _view_name_index().get(name_or_id)


def _view(code: str) -> dict | None:
    return view_companies().get(code)


# ---- 非核心实体聚合索引 / 通用档案 -----------------------------------------


@lru_cache(maxsize=1)
def _external_index() -> dict:
    """非核心实体 key(id/name) → {id, name, as_supplier:[], as_customer:[]}

    只聚合并跳过核心公司自身（自环）。注意 view-data-all 里同一家公司
    同时以 code 和 name 两个 key 出现，故按真实 code 去重只处理一次。
    实体只以供应商/客户身份散落在其它公司的 materials/products 记录里，
    没有独立档案；本索引用于生成「全图关系档案」。"""
    idx: dict[str, dict] = {}
    seen: set[str] = set()
    for _k, c in view_companies().items():
        ccode = c.get("code") or c.get("id")
        if not ccode or ccode in seen:
            continue  # 同一家公司（code/name 双 key）只处理一次
        seen.add(ccode)
        cname = c.get("name")
        for m in c.get("materials") or []:
            for s in m.get("suppliers") or []:
                if s.get("name") in (cname, ccode) or s.get("id") in (cname, ccode):
                    continue  # 自环
                key = s.get("id") or s.get("name")
                if not key:
                    continue
                rec = idx.setdefault(key, {"id": s.get("id"), "name": s.get("name"), "as_supplier": [], "as_customer": []})
                if s.get("name") and s.get("name") != key:
                    idx.setdefault(s["name"], rec)  # name 别名 → 同一档案
                rec["as_supplier"].append(
                    {
                        "company_code": ccode,
                        "company_name": cname,
                        "item": m.get("name"),
                        "share": s.get("share"),
                        "type": s.get("type") or "direct",
                        "note": s.get("note"),
                    }
                )
        for p in c.get("products") or []:
            for cu in p.get("customers") or []:
                if cu.get("name") in (cname, ccode) or cu.get("id") in (cname, ccode):
                    continue
                key = cu.get("id") or cu.get("name")
                if not key:
                    continue
                rec = idx.setdefault(key, {"id": cu.get("id"), "name": cu.get("name"), "as_supplier": [], "as_customer": []})
                if cu.get("name") and cu.get("name") != key:
                    idx.setdefault(cu["name"], rec)  # name 别名 → 同一档案
                rec["as_customer"].append(
                    {
                        "company_code": ccode,
                        "company_name": cname,
                        "item": p.get("name"),
                        "share": cu.get("share"),
                        "type": cu.get("type") or "direct",
                        "note": cu.get("note"),
                    }
                )
    return idx


def entity_profile(key: str) -> dict | None:
    """通用实体档案：核心公司 → 完整档案；非核心实体 → 全图关系档案；A 股兜底 → 基础档案。

    判定顺序：图谱核心公司（code/name）→ 图谱非核心实体（key）→ 全 A 股兜底（6/8 位数字 code）。
    """
    code = _resolve_code(key)
    if code:
        p = company_profile(code)
        if p:
            p["is_subject"] = True
            return p
    rec = _external_index().get(key)
    if rec:
        # 研报 overlay：以实体 id（code）为 key 读取，补充经营指标/关联公司/自有业务
        ov = _overlay().get(rec.get("id")) or {}
        return {
            "id": rec.get("id"),
            "name": rec.get("name"),
            "is_subject": False,
            "appearance_count": len(rec["as_supplier"]) + len(rec["as_customer"]),
            "as_supplier": rec["as_supplier"],
            "as_customer": rec["as_customer"],
            "metrics": ov.get("metrics") or [],
            "related": ov.get("related") or [],
            "report_materials": ov.get("materials") or [],
            "report_products": ov.get("products") or [],
        }
    # 全 A 股兜底：图谱外的 A 股公司（6/8 位数字代码）给基础档案
    if key.isdigit() and len(key) in (6, 8):
        u = universe.universe_index().get(key)
        if u:
            ov = _overlay().get(key) or {}
            return {
                "code": u["code"],
                "name": u["name"],
                "industry": u.get("industry") or "",
                "market_cap": u.get("market_cap"),
                "board": u.get("board"),
                "is_subject": False,
                "source": "a_share_universe",
                "appearance_count": 0,
                "as_supplier": [],
                "as_customer": [],
                "metrics": ov.get("metrics") or [],
                "related": ov.get("related") or [],
                "note": "全 A 股基础档案：暂无关产业链数据（该股尚未被研报/图谱覆盖）",
            }
    return None


# ---- 公司搜索 / 档案 -----------------------------------------------------


def search_companies(keyword: str, limit: int = 20) -> list[dict]:
    q = (keyword or "").strip().lower()
    out: list[dict] = []
    for c in companies():
        name = (c.get("name") or "").lower()
        code = (c.get("code") or "").lower()
        industry = (c.get("industry") or "").lower()
        if q and q not in name and q not in code and q not in industry:
            continue
        out.append(
            {
                "code": c.get("code"),
                "name": c.get("name"),
                "industry": c.get("industry"),
                "exchange": c.get("exchange"),
                "is_subject": bool(c.get("is_subject")),
            }
        )
        if len(out) >= limit:
            break
    return out


def company_profile(code: str) -> dict | None:
    c = _view(code)
    if not c:
        return None
    cap = _cap_index().get(code) or {}
    ov = _overlay().get(code) or {}
    up = _direct_upstream_list(code)
    down = _direct_downstream_list(code)
    return {
        "id": c.get("id"),
        "code": c.get("code"),
        "name": c.get("name"),
        "industry": c.get("industry"),
        "desc": c.get("desc"),
        "is_subject": bool(c.get("is_subject")),
        "market_cap_cny": cap.get("market_cap_cny"),
        "market_cap_display": cap.get("market_cap_display") or "",
        "stock_price": cap.get("price"),
        "material_count": len(c.get("materials") or []),
        "product_count": len(c.get("products") or []),
        "supplier_count": len(up),
        "customer_count": len(down),
        "related": ov.get("related") or [],
        "metrics": ov.get("metrics") or [],
    }


# ---- 上下游获取（镜像 iducsite getDirectUpstream/Downstream 逻辑） -------


def _direct_upstream_list(code: str, limit: int | None = None) -> list[dict]:
    c = _view(code)
    if not c:
        return []
    comp_name, comp_code = c.get("name"), c.get("code")
    rows: list[dict] = []
    for m in c.get("materials") or []:
        mname = m.get("name")
        for s in m.get("suppliers") or []:
            if s.get("name") in (comp_name, comp_code) or s.get("id") in (comp_name, comp_code):
                continue  # 自环：复合型企业自身不作为自身外部供应商
            rows.append(
                {
                    "id": s.get("id"),
                    "name": s.get("name"),
                    "share": s.get("share") if s.get("share") not in (None, 0) else 20,
                    "type": s.get("type") or "direct",
                    "via": mname,
                    "note": s.get("note"),
                }
            )
    rows.sort(key=lambda r: r["share"] or 0, reverse=True)
    return rows[:limit] if limit else rows


def _direct_downstream_list(code: str, limit: int | None = None) -> list[dict]:
    c = _view(code)
    if not c:
        return []
    comp_name, comp_code = c.get("name"), c.get("code")
    rows: list[dict] = []
    for p in c.get("products") or []:
        pname = p.get("name")
        for cu in p.get("customers") or []:
            if cu.get("name") in (comp_name, comp_code) or cu.get("id") in (comp_name, comp_code):
                continue  # 自环
            rows.append(
                {
                    "id": cu.get("id"),
                    "name": cu.get("name"),
                    "share": cu.get("share") if cu.get("share") not in (None, 0) else 10,
                    "type": cu.get("type") or "direct",
                    "via": pname,
                    "note": cu.get("note"),
                }
            )
    rows.sort(key=lambda r: r["share"] or 0, reverse=True)
    return rows[:limit] if limit else rows


# ---- 单公司 5 列视图 ------------------------------------------------------


def graph_single(code: str) -> dict | None:
    """供应商 → 原材料 → 核心公司 → 主营产品 → 下游客户（列式数据，前端画 SVG 边）。

    suppliers/customers 去重：同一实体经多材料/多产品出现时合并 via 列表。
    """
    c = _view(code)
    if not c:
        return None
    materials = [
        {"id": m.get("id"), "name": m.get("name"), "share": m.get("share"), "confidence": m.get("confidence")}
        for m in (c.get("materials") or [])
    ]
    products = [
        {"id": p.get("id"), "name": p.get("name"), "share": p.get("share"), "confidence": p.get("confidence")}
        for p in (c.get("products") or [])
    ]

    suppliers: dict[str, dict] = {}
    for m in c.get("materials") or []:
        mname = m.get("name")
        for s in m.get("suppliers") or []:
            if s.get("name") in (c.get("name"), c.get("code")) or s.get("id") in (c.get("name"), c.get("code")):
                continue
            key = s.get("id") or s.get("name")
            if not key:
                continue
            node = suppliers.setdefault(
                key,
                {
                    "id": s.get("id"),
                    "name": s.get("name"),
                    "type": s.get("type") or "direct",
                    "share": s.get("share") if s.get("share") not in (None, 0) else 20,
                    "note": s.get("note"),
                    "vias": [],
                },
            )
            if mname and mname not in node["vias"]:
                node["vias"].append(mname)

    customers: dict[str, dict] = {}
    for p in c.get("products") or []:
        pname = p.get("name")
        for cu in p.get("customers") or []:
            if cu.get("name") in (c.get("name"), c.get("code")) or cu.get("id") in (c.get("name"), c.get("code")):
                continue
            key = cu.get("id") or cu.get("name")
            if not key:
                continue
            node = customers.setdefault(
                key,
                {
                    "id": cu.get("id"),
                    "name": cu.get("name"),
                    "type": cu.get("type") or "direct",
                    "share": cu.get("share") if cu.get("share") not in (None, 0) else 10,
                    "note": cu.get("note"),
                    "vias": [],
                },
            )
            if pname and pname not in node["vias"]:
                node["vias"].append(pname)

    return {
        "company": company_profile(code),
        "materials": materials,
        "suppliers": list(suppliers.values()),
        "products": products,
        "customers": list(customers.values()),
    }


# ---- 产业链多层展开（镜像 iducsite renderChain BFS） ---------------------


def graph_chain(
    code: str,
    depth_up: int = 2,
    depth_down: int = 2,
    top_up: int = 3,
    top_down: int = 2,
) -> dict | None:
    center = company_profile(code)
    if not center:
        return None

    def bfs(upward: bool) -> list[dict]:
        depth = depth_up if upward else depth_down
        top = top_up if upward else top_down
        fn = _direct_upstream_list if upward else _direct_downstream_list
        levels: list[dict] = []
        current: list[str] = [code]
        visited: set[str] = {code}
        for d in range(1, depth + 1):
            nxt: list[dict] = []
            for pid in current:
                for node in fn(pid, top):
                    key = node.get("id") or node.get("name")
                    if key in visited:
                        continue
                    visited.add(key)
                    node["parent_id"] = pid
                    node["depth"] = d
                    nxt.append(node)
            if not nxt:
                break
            levels.append({"level": -d if upward else d, "nodes": nxt})
            # 下一层标识：能解析为核心公司则用 code（可继续展开），否则 name（叶子）
            current = []
            for n in nxt:
                rc = _resolve_code(n.get("id") or n.get("name"))
                current.append(rc if rc else (n.get("name") or ""))
            current = [x for x in current if x]
        return levels

    up_levels = bfs(upward=True)
    down_levels = bfs(upward=False)
    return {"center": center, "up_levels": up_levels, "down_levels": down_levels}


# ---- 全局网络切片（服务端过滤，浏览器不拉 14.8MB） -----------------------


def _slim_node(n: dict) -> dict:
    keep = (
        "id", "code", "name", "industry", "is_subject", "role", "tier",
        "radius", "color", "glowColor", "market_cap_cny", "badge", "degree",
        "upCount", "downCount", "macroId", "macroName", "init_x", "init_y",
        "subId", "subName", "scaleText",
    )
    return {k: n.get(k) for k in keep}


def graph_network(
    min_degree: int = 3,
    min_market_cap: float = 0,
    min_share: float = 10,
    subject_only: bool = False,
) -> dict:
    net = network()
    raw_nodes = net["nodes"]
    raw_links = net["links"]

    filtered_nodes = []
    for n in raw_nodes:
        if subject_only and not n.get("is_subject"):
            continue  # 只要核心公司，滤掉供应商/原材料等外部实体
        deg = n.get("degree") if n.get("degree") is not None else 0
        if deg < min_degree:
            continue
        mc = n.get("market_cap_cny")
        if min_market_cap > 0 and (mc is None or mc < min_market_cap):
            continue
        filtered_nodes.append(_slim_node(n))

    valid = {n["id"] for n in filtered_nodes}
    filtered_links = []
    for l in raw_links:
        if l["source"] not in valid or l["target"] not in valid:
            continue
        if min_share > 0 and l.get("share") is not None and l["share"] < min_share:
            continue
        filtered_links.append(
            {
                "source": l["source"],
                "target": l["target"],
                "kind": l.get("kind"),
                "type": l.get("type"),
                "share": l.get("share"),
                "item": l.get("item"),
            }
        )

    communities = [
        {
            "macroId": cm.get("macroId"),
            "name": cm.get("name"),
            "palette": cm.get("palette"),
            "size": cm.get("size"),
        }
        for cm in (net.get("macro_communities") or [])
    ]

    return {
        "nodes": filtered_nodes,
        "links": filtered_links,
        "macro_communities": communities,
        "stats": net.get("stats") or {},
    }


# ---- 图统计 --------------------------------------------------------------


def stats_view() -> dict:
    s = stats_raw()
    return {
        "total_nodes": s.get("total_nodes"),
        "total_edges": s.get("total_edges"),
        "companies": s.get("companies"),
        "items": s.get("items"),
        "relationships": s.get("relationships"),
        "macro_communities": s.get("macro_communities"),
        "subject_count": s.get("companies"),  # 1297 家核心研报公司
    }
