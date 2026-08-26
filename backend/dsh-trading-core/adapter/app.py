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
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Path as ApiPath, Query
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from . import kyc as kyc_mod
from .analyzer import TaskManager
from .backtest_engine import compute_summary
from .decision_recorder import load_evaluated_results
from .report_store import ReportStore, ReportValidationError
from .risk_profiles import get_risk_profile, profile
from .runner import FakeBriefRunner, FakeHoldingsRunner, FakeRunner
from .schemas import (
    AnalyzeRequest,
    BacktestRunRequest,
    BriefRequest,
    HoldingsRequest,
    HypothesizeRequest,
    KycAdjustRequest,
    KycParseRequest,
    KycQuestionnaireRequest,
    PersonalizedFeedbackRequest,
    PersonalizedInteractionRequest,
    EvolutionRunRequest,
    RiskProfileRequest,
    ShadowRunRequest,
    StrategyRunRequest,
    WatchlistRequest,
)
from .scheduler import setup_scheduler
from .store import JsonStore

logger = logging.getLogger("adapter.app")

_REPORT_SECTION_TITLES = {
    "market": "市场分析",
    "fundamentals": "基本面分析",
    "news": "新闻分析",
    "sentiment": "市场情绪",
    "debate": "多空研究",
    "trader": "交易决策",
    "risk": "风险判断",
    "portfolio": "持仓风险",
    "brief": "市场简报",
    "backtest": "历史决策回测",
    "strategy": "策略样本外回测",
    "shadow": "影子验证证据",
}


def _report_list_projection(report: dict) -> dict:
    """磁盘报告记录 → 前端稳定列表 DTO。"""
    return {
        "id": report["id"],
        "title": report["title"],
        "kind": report["task_type"],
        "created_at": report["created_at"],
        "summary": report["subject"],
        "task_id": report["id"],
    }


def _report_detail_projection(report: dict) -> dict:
    """磁盘报告记录 → 前端稳定详情 DTO，正文只经 sections 暴露。"""
    projected = _report_list_projection(report)
    projected["sections"] = [
        {
            "key": key,
            "title": _REPORT_SECTION_TITLES.get(key, key),
            "content": report["reports"][key],
        }
        for key in report["section_keys"]
    ]
    return projected


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
    from .shadow import ShadowRunner
    from .strategies import StrategyBacktestRunner
    return {
        "stock": stock_runner,
        "holdings": holdings_runner,
        "brief": brief_runner,
        "backtest": BacktestRunner(),
        "strategy": StrategyBacktestRunner(),
        "shadow": ShadowRunner(),
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


def create_app(report_store: ReportStore | None = None) -> FastAPI:
    manager = TaskManager(registry=_build_registry(), report_store=report_store)

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

    # ---- 统一报告库 ------------------------------------------------------

    @app.get("/reports", response_model=dict)
    async def reports_list(
        limit: int = Query(default=20, ge=1, le=200),
        task_type: Optional[
            Literal["stock", "holdings", "brief", "backtest", "strategy", "shadow"]
        ] = Query(default=None),
    ):
        """持久化报告摘要，按创建时间倒序并投影为前端稳定 DTO。"""
        try:
            reports = manager.report_store.list_reports(
                limit=limit, task_type=task_type
            )
        except ReportValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        items = [_report_list_projection(report) for report in reports]
        return {"count": len(items), "items": items}

    @app.get("/reports/{report_id}", response_model=dict)
    async def report_detail(
        report_id: str = ApiPath(
            min_length=32,
            max_length=32,
            pattern=r"^[0-9a-f]{32}$",
        ),
    ):
        """读取投影为有序 Markdown 分节的完整持久化报告。"""
        try:
            report = manager.report_store.get_report(report_id)
        except ReportValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if report is None:
            raise HTTPException(status_code=404, detail="报告不存在")
        return _report_detail_projection(report)

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
        if req.holdings is not None:
            store.set(
                "holdings", "default",
                [h.model_dump() for h in req.holdings],
            )
        # 只回显插件声明过的 saved 字段（set_holdings schema additionalProperties:false）
        return {"saved": len(req.holdings or [])}

    @app.get("/holdings", response_model=dict)
    async def holdings_get():
        """读取持仓列表，供盯盘/事件模块做命中预警。name 留空，消费方自行补（避免逐票打外部接口）。"""
        store = JsonStore()
        items = [
            {
                "ticker": h.get("ticker", ""),
                "name": "",
                "quantity": h.get("quantity"),
                "cost_price": h.get("cost_price"),
            }
            for h in (store.get("holdings", "default", []) or [])
        ]
        return {"items": items}

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
        adjust = req.model_dump()
        profile_key = ""

        def apply_adjust(current):
            nonlocal profile_key
            kyc = dict(current or {})
            if not kyc.get("inferred_profile"):
                raise HTTPException(
                    status_code=409,
                    detail="尚未完成风险问卷，请先提交问卷再微调",
                )
            profile_key = kyc_mod.apply_manual_adjust(kyc, adjust)
            kyc["manual_adjust"] = adjust
            kyc["status"] = "adjusted"
            return kyc

        store.mutate("preferences", "kyc", apply_adjust)
        old_profile = store.get("preferences", "risk_profile")
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

        def mark_pushed(current):
            if not current:
                raise HTTPException(status_code=404, detail="简报不存在")
            return {**dict(current), "dsh_pushed": True}

        store.mutate("briefs", brief_id, mark_pushed)
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

    # ---- 策略研究：事件→假设→回测→候选池（架构图 E→G→H） -------------

    @app.post("/strategies/hypothesize", response_model=dict)
    def strategies_hypothesize(req: HypothesizeRequest):
        """事件 → 投资假设 → 候选入库。LLM 阻塞 10-30s，用普通 def 走线程池避免卡事件循环。"""
        from .strategies import create_candidates, fetch_events, generate_hypotheses

        events = fetch_events(limit=req.limit)
        if not events:
            return {"candidates": [], "hypotheses": [],
                    "note": "事件源暂无事件（market-watch 未开 / 无新事件）"}
        hypotheses = generate_hypotheses(events)
        ids = create_candidates(events, hypotheses) if not req.dry_run else []
        return {"n_events": len(events), "hypotheses": hypotheses, "candidates": ids}

    @app.post("/strategies/run", response_model=dict)
    async def strategies_run(req: StrategyRunRequest):
        """启动候选策略历史+样本外回测任务，返回 task_id（SSE 复用 /analyze/{id}/*）。"""
        payload = req.model_dump()
        if not payload.get("initial_capital"):
            payload.pop("initial_capital", None)  # 0 → runner 用 SHADOW_INITIAL_CAPITAL 默认
        task_id = manager.start(payload, task_type="strategy")
        return {"task_id": task_id}

    @app.get("/strategies", response_model=dict)
    async def strategies_list(limit: int = 50):
        """策略池列表（created_at 倒序）。"""
        from .strategies import project_strategy_verification

        store = JsonStore()
        rows = [
            project_strategy_verification(item)
            for item in (store.all("strategies") or {}).values()
        ]
        rows.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        return {"count": len(rows), "items": rows[: max(1, min(limit, 200))]}

    @app.get("/strategies/{sid}", response_model=dict)
    async def strategies_get(sid: str):
        """单条策略详情（含 backtest）。"""
        from .strategies import project_strategy_verification

        store = JsonStore()
        s = store.get("strategies", sid)
        if not s:
            raise HTTPException(status_code=404, detail="策略不存在")
        return project_strategy_verification(s)

    @app.post("/strategies/{sid}/{action}", response_model=dict)
    async def strategies_transition(sid: str, action: Literal["activate", "reject", "retire"]):
        """手动迁移生命周期；验证分类由最新回测证据独立维护。"""
        from .strategies import transition_strategy

        store = JsonStore()
        try:
            updated = transition_strategy(store, sid, action)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="策略不存在") from exc
        return {
            "id": sid,
            "status": updated["status"],
            "verification_status": updated["verification_status"],
        }

    # ---- 实时影子策略验证（架构图 I） ----------------------------------

    @app.post("/shadow/run", response_model=dict)
    async def shadow_run(req: ShadowRunRequest):
        """启动影子策略验证任务（paper trading 记账），返回 task_id。"""
        task_id = manager.start(req.model_dump(), task_type="shadow")
        return {"task_id": task_id}

    @app.get("/shadow/status", response_model=dict)
    async def shadow_status():
        """最近一次影子运行汇总。"""
        return JsonStore().get("shadows", "latest") or {"note": "尚未运行影子验证"}

    @app.get("/shadow/positions", response_model=dict)
    async def shadow_positions(strategy_id: Optional[str] = None):
        """影子账户当前持仓（shadows/pos:*，按策略+代码排序）。"""
        store = JsonStore()
        rows = []
        for key, val in (store.all("shadows") or {}).items():
            if not key.startswith("pos:"):
                continue
            if strategy_id and val.get("strategy_id") != strategy_id:
                continue
            rows.append(val)
        rows.sort(key=lambda r: (r.get("strategy_id", ""), r.get("symbol", "")))
        return {"count": len(rows), "items": rows}

    @app.get("/shadow/equity", response_model=dict)
    async def shadow_equity(strategy_id: Optional[str] = None, limit: int = 30):
        """影子净值历史（shadow_equity/{date}，日期倒序）。"""
        store = JsonStore()
        keys = sorted((store.all("shadow_equity") or {}).keys(), reverse=True)
        recs = []
        for k in keys[: max(1, min(limit, 100))]:
            snap = store.get("shadow_equity", k) or {}
            if strategy_id:
                s = (snap.get("strategies") or {}).get(strategy_id)
                # A portfolio snapshot is not evidence for a strategy that did
                # not participate on that date. Omit the row instead of
                # returning a null strategy beside an unrelated overall NAV.
                if s is not None:
                    recs.append({"date": k, "strategy": s})
            else:
                recs.append({"date": k, "overall_nav": snap.get("overall_nav"),
                             "strategy_count": len(snap.get("strategies") or {})})
        return {"count": len(recs), "items": recs}

    # ---- 个性化右链（O 策略匹配 + D/P 资讯卡片 + R 行为捕获） ----------------

    @app.get("/personalized/matches", response_model=dict)
    def personalized_matches():
        """O：active 策略 × 用户画像 → 确定性推荐排序（可解释）。"""
        from . import personalize

        return personalize.match_strategies()

    @app.get("/personalized/cards", response_model=dict)
    def personalized_cards(
        limit: int = 30,
        bucket: str = "all",
        match: int = 0,
        comment: int = 0,
        strategy_id: Optional[str] = None,
    ):
        """D+P：个性化资讯卡片 feed（桶优先级 + relevance 排序）。

        bucket=all|holdings|watchlist|strategy|fresh；match=1 仅命中关注；
        comment=1 附加 LLM 一句话点评（可降级为 null）。
        """
        from . import personalize

        return personalize.build_cards(
            limit=limit, bucket=bucket, match_only=bool(match),
            strategy_id=strategy_id, comment=bool(comment),
        )

    @app.post("/personalized/interactions", response_model=dict)
    def personalized_interactions_post(req: PersonalizedInteractionRequest):
        """R：view/click 阅读行为埋点（环形缓冲落 behavior.json）。"""
        from . import personalize

        return personalize.record_interaction(
            JsonStore(), req.card_id, req.action, req.ts, req.meta,
        )

    @app.post("/personalized/feedback", response_model=dict)
    def personalized_feedback_post(req: PersonalizedFeedbackRequest):
        """R 显式反馈（P→R 决策信号）：卡片/预警 有用/没用。

        落行为库 action=feedback，供 R→U→K 画像修正与 R→V 效果归因
        （卡片排序 boost / 事件预警灵敏度校准）。
        """
        from . import personalize

        return personalize.record_feedback(
            JsonStore(), req.card_id, req.sentiment, req.ts, req.meta,
        )

    @app.get("/personalized/profile", response_model=dict)
    def personalized_profile():
        """K 画像增强 L→K：基础画像 + 行为推断（effective_aggression + 关注/方向/策略亲和）。"""
        from . import behavior_profile

        return behavior_profile.profile_view()

    @app.get("/personalized/impact", response_model=dict)
    def personalized_impact(limit: int = 5):
        """C 调试：事件影响图谱扩展结果（带 impact_codes / impact_by）。

        :8200 不可达时事件保持原样（impact 为空），用于验证优雅降级。
        """
        from .strategies import fetch_events

        # fetch_events 命中 TTL 缓存时忽略 limit（返回缓存整表），这里按本端点 limit 截断
        want = max(1, min(int(limit), 50))
        events = (fetch_events(limit=want, timeout=15.0) or [])[:want]
        return {
            "as_of": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "count": len(events),
            "events": [{
                "id": e.get("id"), "tickers": e.get("tickers"),
                "industries": e.get("industries"), "direction": e.get("direction"),
                "summary": (e.get("summary") or "")[:60],
                "impact_codes": e.get("impact_codes") or [],
                "impact_industries": e.get("impact_industries") or [],
                "impact_by": e.get("impact_by") or [],
            } for e in events],
        }

    @app.get("/personalized/interactions", response_model=dict)
    def personalized_interactions_get(limit: int = 50):
        """R：最近行为记录（时间倒序）。"""
        from . import personalize

        return personalize.list_interactions(JsonStore(), limit=limit)

    # ---- 风险预警中心（架构图 N 组合风险 + Q 四源预警）------------------------

    @app.get("/risk/portfolio", response_model=dict)
    def risk_portfolio():
        """N：组合风险模型（等权确定性估算，无实时行情，同步 def 不阻塞）。"""
        from . import risk_engine

        return risk_engine.portfolio_risk()

    @app.get("/risk/alerts", response_model=dict)
    def risk_alerts():
        """Q：风险预警中心（组合+影子+事件+画像四源聚合，按严重度高>中>低排序）。"""
        from . import risk_engine

        return risk_engine.risk_alerts()

    # ---- 自进化闭环（S_shadow→T→W→H + R→S→U→K outcome 版）-----------------

    @app.get("/evolution/status", response_model=dict)
    def evolution_status():
        """自进化闭环状态：影子数据是否就绪 + 策略生命周期统计。"""
        from . import evolution

        return evolution.status()

    @app.get("/evolution/attribution", response_model=dict)
    def evolution_attribution():
        """T 归因（S_shadow→T）：影子组合整体 + 每策略 收益/回撤/平仓胜率（只读）。"""
        from . import evolution

        return evolution.attribution()

    @app.get("/evolution/preview", response_model=dict)
    def evolution_preview():
        """当前待确认进化预案，供产品页与模型以同一上下文复核。"""
        from . import evolution

        return evolution.current_preview()

    @app.post("/evolution/run", response_model=dict)
    def evolution_run(req: EvolutionRunRequest):
        """T→W→H 进化：先生成绑定预案，再用令牌应用精确动作。

        数据不足（< EVOLVE_MIN_DAYS）时返回 waiting_data + 空 actions，不动作。
        """
        from . import evolution

        try:
            return evolution.evolve(apply=req.apply, preview_token=req.preview_token)
        except evolution.EvolutionPreviewConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

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
