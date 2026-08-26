# -*- coding: utf-8 -*-
"""industry-chain 产业链图谱适配器：同步 FastAPI，端口 8200。

图谱查询为秒级只读操作；种子数据只在用户显式请求后下载，不在启动时联网。
端点在 dsh-plugin 的 4 个只读工具一一对应（chain_search/chain_profile/chain_graph/chain_expand）。
"""

import time

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import graph
from .config import settings
from .seed_data import SeedDataManager

app = FastAPI(title="Industry Chain Adapter", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
seed_data_manager = SeedDataManager(settings.data_dir, settings.seed_base_url)


def _data_or_503(exc: Exception) -> HTTPException:
    return HTTPException(status_code=503, detail=str(exc))


def _company_or_404(code: str, result):
    if result is None:
        raise HTTPException(404, f"未找到公司 {code}（代码需为图谱内核心公司 code）")
    return result


@app.get("/health")
def health():
    return {"ok": True, "service": "industry-chain", "port": 8200, "ts": int(time.time())}


@app.get("/data/status")
def data_status():
    """读取本地种子数据状态；不触发任何网络请求。"""
    return seed_data_manager.status()


@app.post("/data/bootstrap")
def data_bootstrap():
    """用户显式触发固定五文件下载；并发请求复用同一个任务。"""
    result = seed_data_manager.bootstrap()
    if result["status"] == "ready":
        graph.invalidate()
    return result


@app.get("/stats")
def stats():
    try:
        return graph.stats_view()
    except FileNotFoundError as exc:
        raise _data_or_503(exc)


@app.get("/companies")
def companies_search(
    keyword: str = Query("", description="名称/代码/行业模糊搜索"),
    limit: int = Query(20, ge=1, le=100, description="返回条数上限"),
):
    try:
        items = graph.search_companies(keyword, limit)
    except FileNotFoundError as exc:
        raise _data_or_503(exc)
    return {"items": items, "count": len(items)}


@app.get("/companies/{code}")
def company_detail(code: str):
    try:
        p = graph.company_profile(code)
    except FileNotFoundError as exc:
        raise _data_or_503(exc)
    return _company_or_404(code, p)


@app.get("/graph/entity/{key}")
def graph_entity(key: str):
    """通用实体档案：核心公司返回完整档案；非核心实体返回全图关系档案。"""
    try:
        e = graph.entity_profile(key)
    except FileNotFoundError as exc:
        raise _data_or_503(exc)
    return _company_or_404(key, e)


@app.get("/graph/single/{code}")
def graph_single(code: str):
    """单公司 5 列产业链：供应商 → 原材料 → 核心公司 → 主营产品 → 下游客户。"""
    try:
        g = graph.graph_single(code)
    except FileNotFoundError as exc:
        raise _data_or_503(exc)
    return _company_or_404(code, g)


@app.get("/graph/chain/{code}")
def graph_chain(
    code: str,
    depth_up: int = Query(2, ge=1, le=3, description="向上展开层数"),
    depth_down: int = Query(2, ge=1, le=3, description="向下展开层数"),
    top_up: int = Query(3, ge=1, le=5, description="上游每层 TOP-N"),
    top_down: int = Query(2, ge=1, le=5, description="下游每层 TOP-N"),
):
    """产业链多层展开：中心公司上下游按层 BFS，环回去重。"""
    try:
        g = graph.graph_chain(code, depth_up, depth_down, top_up, top_down)
    except FileNotFoundError as exc:
        raise _data_or_503(exc)
    return _company_or_404(code, g)


@app.get("/graph/network")
def graph_network(
    min_degree: int = Query(3, ge=0, le=500, description="最低度数（连线数）"),
    min_market_cap: float = Query(0, ge=0, description="最低市值（亿元，0=不限）"),
    min_share: float = Query(10, ge=0, le=100, description="连线最低权重 %（0=不限）"),
    subject_only: int = Query(0, ge=0, le=1, description="只保留核心公司（is_subject），滤掉供应商/原材料等外部实体"),
    include_universe: int = Query(0, ge=0, le=1, description="全 A 股模式：输出全部 5901 家 A 股 + A→A 供应链真实边"),
):
    """全局网络切片：服务端过滤后返回渲染子集（浏览器不拉 14.8MB 全量）。"""
    try:
        return graph.graph_network(min_degree, min_market_cap, min_share, bool(subject_only), bool(include_universe))
    except FileNotFoundError as exc:
        raise _data_or_503(exc)
