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


# ---- 数据访问 ------------------------------------------------------------


def companies() -> list:
    return _load("companies.json")


def view_companies() -> dict:
    return _load("view-data-all.json")["companies"]


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
) -> dict:
    net = network()
    raw_nodes = net["nodes"]
    raw_links = net["links"]

    filtered_nodes = []
    for n in raw_nodes:
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
