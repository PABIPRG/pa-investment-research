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
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from . import kyc as kyc_mod
from .analyzer import TaskManager
from .backtest_engine import compute_summary
from .decision_recorder import load_evaluated_results
from .risk_profiles import get_risk_profile, profile
from .runner import FakeBriefRunner, FakeHoldingsRunner, FakeRunner
from .schemas import (
    AnalyzeRequest,
    BacktestRunRequest,
    BriefRequest,
    HoldingsRequest,
    KycAdjustRequest,
    KycParseRequest,
    KycQuestionnaireRequest,
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

    lazy import：engine 模式的 Runner 只在非 fake 时才导入，
    使 fake 模式不需要安装 langgraph/chromadb 等引擎依赖。
    """
    fake = os.getenv("ADAPTER_RUNNER", "engine").lower() == "fake"
    if fake:
        stock_runner = FakeRunner()
        holdings_runner = FakeHoldingsRunner()
        brief_runner = FakeBriefRunner()
    else:
        from .runner import EngineRunner
        from .holdings_runner import HoldingsRunner
        from .brief_engine import BriefRunner
        stock_runner = EngineRunner()
        holdings_runner = HoldingsRunner()
        brief_runner = BriefRunner()
    # 回测无 LLM（纯逻辑 + baostock），fake 模式也走真逻辑，便于链路自测；
    # lazy import 保持 fake 模式不加载引擎重依赖（langgraph/chromadb 等）
    from .backtest_runner import BacktestRunner
    return {
        "stock": stock_runner,
        "holdings": holdings_runner,
        "brief": brief_runner,
        "backtest": BacktestRunner(),
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

    app = FastAPI(title="TradingAgents Adapter", version="0.1.0", lifespan=lifespan)
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
            "service": "trading-core",
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
        # 只回显插件声明过的 saved 字段（set_holdings schema additionalProperties:false）
        return {"saved": len(req.holdings or [])}

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

    # ---- KYC：风险偏好问卷 / 滑块微调 / 语音文本解析 -----------------------

    @app.get("/kyc/profile", response_model=dict)
    async def kyc_profile_get():
        """KYC 现状 + 题组 schema + 阈值（前端以此为唯一事实源渲染）。"""
        return kyc_mod.build_kyc_view(JsonStore())

    @app.post("/kyc/questionnaire", response_model=dict)
    async def kyc_questionnaire(req: KycQuestionnaireRequest):
        """提交问卷 → 计分 → 写 preferences.kyc + risk_profile（推断即生效）。"""
        try:
            result = kyc_mod.score_questionnaire(
                [a.model_dump() for a in req.answers], req.tier
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        store = JsonStore()
        old_profile = store.get("preferences", "risk_profile")
        # 全新 KYC 记录：重做问卷 = 重新推断，清空此前的滑块微调
        #（微调是叠加在最近一次推断之上的覆盖层）
        kyc = {
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "method": req.method,
            "version": 1,
            "score": result["score"],
            "inferred_profile": result["profile"],
            "answers": [a.model_dump() for a in req.answers],
            "manual_adjust": None,
            "voice_source": req.voice_source,
        }
        store.set("preferences", "kyc", kyc)
        if old_profile:
            store.set("preferences", "last_profile", old_profile)
        store.set("preferences", "risk_profile", result["profile"])
        return {
            "profile": result["profile"],
            "label": profile(result["profile"])["label"],
            "score": result["score"],
            "inferred_profile": result["profile"],
            "mapping": result["mapping"],
        }

    @app.post("/kyc/adjust", response_model=dict)
    async def kyc_adjust(req: KycAdjustRequest):
        """滑块微调已推断画像：更新 risk_profile，保留 kyc.inferred_profile。"""
        store = JsonStore()
        kyc = store.get("preferences", "kyc") or {}
        if not kyc.get("inferred_profile"):
            raise HTTPException(
                status_code=409,
                detail="尚未完成风险问卷，请先提交问卷再微调",
            )
        adjust = req.model_dump()
        profile_key = kyc_mod.apply_manual_adjust(kyc, adjust)
        old_profile = store.get("preferences", "risk_profile")
        kyc["manual_adjust"] = adjust
        kyc["status"] = "adjusted"
        store.set("preferences", "kyc", kyc)
        if old_profile:
            store.set("preferences", "last_profile", old_profile)
        store.set("preferences", "risk_profile", profile_key)
        return {
            "profile": profile_key,
            "label": profile(profile_key)["label"],
            "manual_adjust": adjust,
        }

    @app.post("/kyc/parse", response_model=dict)
    async def kyc_parse(req: KycParseRequest):
        """整段自然语言（语音转写/手打）→ 结构化问卷答案（LLM + 关键词降级）。"""
        if not req.text or not req.text.strip():
            raise HTTPException(status_code=422, detail="文本不能为空")
        answers, source = kyc_mod.parse_preferences_to_answers(req.text)
        return {"answers": answers, "text": req.text, "source": source}

    @app.post("/brief", response_model=dict)
    async def brief(req: BriefRequest):
        """启动盘前/盘后简报生成任务（market_brief），返回 task_id。"""
        task_id = manager.start(req.model_dump(), task_type="brief")
        return {"task_id": task_id}

    @app.get("/brief/latest", response_model=dict)
    async def brief_latest():
        """最近一份简报（含 dsh_pushed 标记，供 dsh 对话内推送去重）。

        输出归一化为插件 get_latest_brief schema 声明的 5 个字段
        （additionalProperties:false 且非空类型）；无简报时返回空字符串 + False，
        避免 dsh 侧 schema 校验失败。"""
        store = JsonStore()
        key = store.get("briefs", "latest")
        if not key:
            return {"id": "", "period": "", "trade_date": "", "summary": "", "dsh_pushed": False}
        rec = store.get("briefs", key)
        if not rec:
            return {"id": "", "period": "", "trade_date": "", "summary": "", "dsh_pushed": False}
        return {
            "id": rec.get("id", ""),
            "period": rec.get("period", ""),
            "trade_date": rec.get("trade_date", ""),
            "summary": rec.get("summary", ""),
            "dsh_pushed": bool(rec.get("dsh_pushed", False)),
        }

    @app.post("/brief/{brief_id}/dsh-pushed", response_model=dict)
    async def brief_dsh_pushed(brief_id: str):
        """标记某份简报已在 dsh 对话内播报过（幂等，用于 brief-pusher 去重）。"""
        store = JsonStore()
        rec = store.get("briefs", brief_id)
        if not rec:
            raise HTTPException(status_code=404, detail="简报不存在")
        store.update("briefs", brief_id, dsh_pushed=True)
        return {"id": brief_id, "dsh_pushed": True}

    # ---- 策略回测（基于历史决策的前瞻评估） ----------------------------

    @app.post("/backtest/run", response_model=dict)
    async def backtest_run(req: BacktestRunRequest):
        """启动回测任务，返回 task_id（SSE/result 复用 /analyze/{id}/*）。"""
        task_id = manager.start(req.model_dump(), task_type="backtest")
        return {"task_id": task_id}

    @app.get("/backtest/results", response_model=dict)
    async def backtest_results(limit: int = 20):
        """最近的回测运行记录（created_at 倒序）。"""
        store = JsonStore()
        runs = store.all("backtests")
        recs = sorted(
            runs.values(), key=lambda r: r.get("created_at", ""), reverse=True
        )[: max(1, min(limit, 200))]
        return {"count": len(recs), "runs": recs}

    @app.get("/backtest/performance", response_model=dict)
    async def backtest_performance(code: Optional[str] = None):
        """从 decisions.eval_meta 重算整体表现（无需重跑行情）。"""
        return _performance_summary(code)

    @app.get("/backtest/performance/{code}", response_model=dict)
    async def backtest_performance_code(code: str):
        """别名：单只股票的整体表现。"""
        return _performance_summary(code)

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


def _performance_summary(code: Optional[str]) -> dict:
    """从 decisions.eval_meta.last_eval 重算整体表现 summary。"""
    items = load_evaluated_results(code=code)
    summary = compute_summary(
        items,
        source="persisted",
        n_decisions_total=len(items),
        n_candidates_evaluated=0,
    )
    return {"code": code or "all", "n_items": len(items), "summary": summary}


async def _sse_gen(manager: TaskManager, task_id: str):
    """把内部事件 dict 转成 SSE 命名字段（event: stage / data: {...}）。

    事件协议（节点跟踪方案 §4）：
      - pipeline:  任务启动时一次，下发管道清单（phases/total_steps）
      - stage:     节点完成，结构化字段（node_id/phase/status/step_index/elapsed_ms）
      - trace:     agent 产出内容摘要（content_preview/content_len）
      - progress:  进度条百分比（percent/phase）
      - result:    最终结果（signal/reports）
      - error:     异常
      - done:      流结束

    向后兼容：旧 str-based stage 事件（node/message）仍然透传。
    """
    async for ev in manager.stream_events(task_id):
        ev_type = ev.get("type", "stage")
        payload = {k: v for k, v in ev.items() if k != "type"}

        if ev_type == "stage":
            # 结构化 stage：透传全部字段；旧 str 事件只有 node/message 也会透传
            data = payload
        elif ev_type == "result":
            data = payload.get("data") or {}
        elif ev_type == "error":
            data = {"message": payload.get("message", "未知错误"),
                    **({"node_id": payload["node_id"]} if "node_id" in payload else {})}
        elif ev_type in ("pipeline", "trace", "progress"):
            # 新增事件类型：全量透传
            data = payload
        else:  # done / heartbeat
            data = {}
        yield {"event": ev_type, "data": json.dumps(data, ensure_ascii=False)}


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("adapter.app:app", host="127.0.0.1", port=8000, reload=False)
