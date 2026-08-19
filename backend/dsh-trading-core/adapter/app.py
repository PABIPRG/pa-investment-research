# -*- coding: utf-8 -*-
"""适配器服务 FastAPI 入口（集成方案 §3.1）。

运行：
  env/Scripts/python.exe -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000

API：
  POST /analyze/{id}/...（见各路由 docstring）
"""

import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from .analyzer import TaskManager
from .brief_engine import BriefRunner
from .holdings_runner import HoldingsRunner
from .risk_profiles import get_risk_profile, profile
from .runner import EngineRunner, FakeBriefRunner, FakeHoldingsRunner, FakeRunner
from .schemas import (
    AnalyzeRequest,
    BriefRequest,
    HoldingsRequest,
    RiskProfileRequest,
    WatchlistRequest,
)
from .scheduler import setup_scheduler
from .store import JsonStore

logger = logging.getLogger("adapter.app")


def _build_registry() -> dict:
    """task_type → runner。ADAPTER_RUNNER=fake|engine（默认 engine）。

    fake 用于链路自测（三个类型都走假任务）；engine 模式 stock 走真引擎，
    holdings 走 HoldingsRunner（L1 定量 + deep 逐股引擎），
    brief 阶段 D 替换为 BriefRunner（暂用 fake 占位保证可用）。
    """
    fake = os.getenv("ADAPTER_RUNNER", "engine").lower() == "fake"
    stock_runner = FakeRunner() if fake else EngineRunner()
    holdings_runner = FakeHoldingsRunner() if fake else HoldingsRunner()
    brief_runner = FakeBriefRunner() if fake else BriefRunner()
    return {
        "stock": stock_runner,
        "holdings": holdings_runner,
        "brief": brief_runner,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 功能4：定时盘前/盘后简报（BRIEF_SCHEDULE_ENABLED=false 时返回 None）
    sched = setup_scheduler()
    app.state.scheduler = sched
    logger.info("适配器启动完成（runners=%s）", {k: v.name for k, v in app.state.manager.registry.items()})
    yield
    if sched is not None:
        sched.shutdown(wait=False)


def create_app() -> FastAPI:
    manager = TaskManager(registry=_build_registry())

    app = FastAPI(title="TradingAgents-CN Adapter", version="0.1.0", lifespan=lifespan)
    app.state.manager = manager

    # dsh 插件（Node/TS）跨进程调用，放开跨域
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "runners": {k: v.name for k, v in manager.registry.items()},
        }

    @app.post("/analyze", response_model=dict)
    async def analyze(req: AnalyzeRequest):
        """启动股票分析任务（analyze_stock），返回 task_id。"""
        task_id = manager.start(req.model_dump(), task_type="stock")
        return {"task_id": task_id}

    # ---- 持仓 / 自选 / 简报（阶段 A 骨架，C/D 完善） ----------------------

    @app.post("/holdings/analyze", response_model=dict)
    async def holdings_analyze(req: HoldingsRequest):
        """启动持仓分析任务（analyze_holdings），返回 task_id。"""
        task_id = manager.start(req.model_dump(), task_type="holdings")
        return {"task_id": task_id}

    @app.post("/holdings/save", response_model=dict)
    async def holdings_save(req: HoldingsRequest):
        """保存持仓到本地 store（ManualProvider 数据源）。"""
        store = JsonStore()
        if req.holdings:
            store.set(
                "holdings", "default",
                [h.model_dump() for h in req.holdings],
            )
        return {"saved": len(req.holdings or []), "mode": req.mode}

    @app.get("/watchlist", response_model=dict)
    async def watchlist_get():
        """读取自选列表。"""
        store = JsonStore()
        return {"tickers": store.get("watchlist", "default", [])}

    @app.post("/watchlist", response_model=dict)
    async def watchlist_set(req: WatchlistRequest):
        """整体替换自选列表。"""
        store = JsonStore()
        store.set("watchlist", "default", req.tickers)
        return {"saved": len(req.tickers)}

    @app.get("/risk_profile", response_model=dict)
    async def risk_profile_get():
        """读取当前风险偏好画像（get_risk_profile 无参 = 读已保存偏好）。"""
        return {
            "risk_profile": get_risk_profile(),
            "label": profile(get_risk_profile())["label"],
        }

    @app.post("/risk_profile", response_model=dict)
    async def risk_profile_set(req: RiskProfileRequest):
        """持久化全局风险偏好画像（conservative/balanced/aggressive）。"""
        store = JsonStore()
        store.set("preferences", "risk_profile", req.risk_profile)
        return {
            "risk_profile": req.risk_profile,
            "label": profile(req.risk_profile)["label"],
        }

    @app.post("/brief", response_model=dict)
    async def brief(req: BriefRequest):
        """启动盘前/盘后简报生成任务（market_brief），返回 task_id。"""
        task_id = manager.start(req.model_dump(), task_type="brief")
        return {"task_id": task_id}

    @app.get("/brief/latest", response_model=dict)
    async def brief_latest():
        """最近一份简报（含 dsh_pushed 标记，供 dsh 对话内推送去重）。"""
        store = JsonStore()
        key = store.get("briefs", "latest")
        if not key:
            # 尚无简报：返回空记录（id=null），dsh 工具/播报轮询按「暂无简报」优雅处理
            return {"id": None, "period": None, "trade_date": None, "summary": None, "dsh_pushed": None}
        rec = store.get("briefs", key)
        if not rec:
            raise HTTPException(status_code=404, detail="简报记录缺失")
        return rec

    @app.post("/brief/{brief_id}/dsh-pushed", response_model=dict)
    async def brief_dsh_pushed(brief_id: str):
        """标记某份简报已在 dsh 对话内播报过（幂等，用于 brief-pusher 去重）。"""
        store = JsonStore()
        rec = store.get("briefs", brief_id)
        if not rec:
            raise HTTPException(status_code=404, detail="简报不存在")
        store.update("briefs", brief_id, dsh_pushed=True)
        return {"id": brief_id, "dsh_pushed": True}

    @app.get("/analyze/{task_id}/stream")
    async def stream(task_id: str):
        """SSE 进度流：stage/result/error/done 事件，15s 心跳保活。"""
        if not manager.exists(task_id):
            raise HTTPException(status_code=404, detail="任务不存在")
        return EventSourceResponse(
            _sse_gen(manager, task_id), ping=15
        )

    @app.get("/analyze/{task_id}/result")
    async def result(task_id: str):
        """最终结果（Signal + 分步报告）。任务未完成返回 409。"""
        if not manager.exists(task_id):
            raise HTTPException(status_code=404, detail="任务不存在")
        if manager._status.get(task_id) != "done":
            raise HTTPException(status_code=409, detail="任务尚未完成")
        return manager.result(task_id)

    @app.get("/analyze/{task_id}")
    async def status(task_id: str):
        """状态查询：pending/running/done/failed。"""
        if not manager.exists(task_id):
            raise HTTPException(status_code=404, detail="任务不存在")
        return manager.status(task_id)

    return app


async def _sse_gen(manager: TaskManager, task_id: str):
    """把内部事件 dict 转成 SSE 命名字段（event: stage / data: {...}）。"""
    async for ev in manager.stream_events(task_id):
        ev_type = ev.get("type", "stage")
        payload = {k: v for k, v in ev.items() if k != "type"}
        # 只发需要下发的字段
        if ev_type == "stage":
            data = {"node": payload.get("node"), "message": payload.get("message")}
        elif ev_type == "result":
            data = payload.get("data") or {}
        elif ev_type == "error":
            data = {"message": payload.get("message", "未知错误")}
        else:  # done / heartbeat
            data = {}
        yield {"event": ev_type, "data": json.dumps(data, ensure_ascii=False)}


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("adapter.app:app", host="127.0.0.1", port=8000, reload=False)
