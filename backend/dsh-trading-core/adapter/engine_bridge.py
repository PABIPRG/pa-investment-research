# -*- coding: utf-8 -*-
"""S2：真引擎接入 — 调用 TradingAgents-CN 的 propagate()，进度回调 → SSE。

关键点（集成方案 §2 已核实）：
  - propagate(company_name, trade_date, progress_callback=cb, task_id=task_id)
  - 传 progress_callback 时引擎自动切 stream_mode="updates"，回调收到中文进度文本
  - 引擎是同步阻塞的 → 由 TaskManager 放在 worker 线程执行（本文件只被线程调用）
"""

import logging
import os
from datetime import date

from tradingagents.dataflows.data_source_manager import get_china_stock_info_unified
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph

from .risk_profiles import calibrate_stock_decision, get_risk_profile

logger = logging.getLogger("adapter.engine")

# research_depth → 引擎配置（会话级覆盖优先于这些默认）
RESEARCH_DEPTH_MAP = {
    "quick":    {"max_debate_rounds": 1, "max_risk_discuss_rounds": 1, "online_news": False},
    "basic":    {"max_debate_rounds": 1, "max_risk_discuss_rounds": 1, "online_news": False},
    "standard": {"max_debate_rounds": 1, "max_risk_discuss_rounds": 1, "online_news": False},
    "deep":     {"max_debate_rounds": 2, "max_risk_discuss_rounds": 2, "online_news": False},
    "full":     {"max_debate_rounds": 3, "max_risk_discuss_rounds": 3, "online_news": True},
}


class EngineRunner:
    """真引擎运行器：与 FakeRunner 同接口（run(params, progress_cb) -> dict）。"""

    name = "tradingagents-cn"

    def __init__(self, base_config: dict | None = None):
        self.base_config = base_config or {}  # S5 外置化注入的全局覆盖

    def _build_config(self, params: dict) -> dict:
        config = DEFAULT_CONFIG.copy()
        config.update(self.base_config)
        # 引擎默认走 DeepSeek（.env 已配 DEEPSEEK_API_KEY / BASE_URL）
        config["llm_provider"] = "deepseek"
        config["deep_think_llm"] = "deepseek-chat"
        config["quick_think_llm"] = "deepseek-chat"
        # ⚠️ 必须显式覆盖 DEFAULT_CONFIG["backend_url"]（OpenAI 地址），否则引擎会把
        #    DeepSeek 请求发到 api.openai.com（环境变量 DEEPSEEK_BASE_URL 不会自动生效）
        config["backend_url"] = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        config["online_tools"] = True    # A 股走 akshare 数据源
        config["online_news"] = False    # A 股中文在线新闻源少，避免拖慢
        config["realtime_data"] = False
        config["use_memory"] = False     # 记忆归 dsh 会话，引擎不做跨次反思

        # research_depth 映射
        depth = params.get("research_depth", "standard")
        config.update(RESEARCH_DEPTH_MAP.get(depth, RESEARCH_DEPTH_MAP["standard"]))

        # 风险偏好：显式写入引擎 config（config_overrides 仍可覆盖，优先于这里）
        config["risk_profile"] = get_risk_profile(params)

        # 会话级覆盖优先（config_overrides 直接透传给引擎 config）
        for k, v in (params.get("config_overrides") or {}).items():
            config[k] = v
        return config

    def run(self, params: dict, progress_cb) -> dict:
        """在 worker 线程中调用：构建图 → propagate → 组装 Signal 结果。"""
        ticker = params["ticker"]
        trade_date = params.get("date") or date.today().isoformat()
        config = self._build_config(params)
        profile_key = get_risk_profile(params)

        logger.info("🚀 构建 TradingAgentsGraph（provider=deepseek, depth=%s, risk_profile=%s）…",
                    params.get("research_depth", "standard"), profile_key)
        # 每个任务独立建图：避免共享 self.ticker/self.curr_state 的并发污染（S5 再优化缓存）
        graph = TradingAgentsGraph(config=config, debug=False)

        state, decision = graph.propagate(
            ticker,
            trade_date,
            progress_callback=progress_cb,
            task_id=params.get("task_id"),
        )
        return build_signal_result(params, state, decision, profile_key)

    def pipeline_manifest(self, params: dict) -> dict:
        """返回管道清单（节点跟踪方案 §3），前端据此渲染步骤器。

        清单的 total_steps 与 TradingAgentsGraph._compute_total_steps() 公式一致，
        保证 manifest 声明的步数与 stage 事件里的 total_steps 字段对齐。
        """
        from tradingagents.graph.trading_graph import NODE_META

        config = self._build_config(params)
        max_debate = config.get("max_debate_rounds", 1)
        max_risk = config.get("max_risk_discuss_rounds", 1)

        # 分析师节点（默认全选，顺序与 graph 默认 selected_analysts 一致）
        _key_to_id = {
            "market": "Market Analyst",
            "social": "Social Analyst",
            "news": "News Analyst",
            "fundamentals": "Fundamentals Analyst",
        }
        analyst_nodes = [
            {"id": nid, "label": NODE_META[nid]["label"], "type": "analyst"}
            for nid in (_key_to_id[k] for k in ["market", "social", "news", "fundamentals"])
        ]

        n_analysts = len(analyst_nodes)
        total = n_analysts + max_debate * 2 + 1 + 1 + max_risk * 3 + 1

        def _node(nid, ntype, rounds=None):
            d = {"id": nid, "label": NODE_META[nid]["label"], "type": ntype}
            if rounds is not None:
                d["rounds"] = rounds
            return d

        return {
            "type": "pipeline",
            "ticker": params.get("ticker", ""),
            "phases": [
                {"phase": "analysts", "label": "数据采集与分析师团队", "nodes": analyst_nodes},
                {"phase": "research", "label": "多空辩论", "nodes": [
                    _node("Bull Researcher", "debater", max_debate),
                    _node("Bear Researcher", "debater", max_debate),
                    _node("Research Manager", "judge"),
                ]},
                {"phase": "trader", "label": "交易决策", "nodes": [
                    _node("Trader", "trader"),
                ]},
                {"phase": "risk", "label": "风险辩论", "nodes": [
                    _node("Risky Analyst", "debater", max_risk),
                    _node("Safe Analyst", "debater", max_risk),
                    _node("Neutral Analyst", "debater", max_risk),
                    _node("Risk Judge", "judge"),
                ]},
            ],
            "total_steps": total,
        }


def build_signal_result(params: dict, state: dict, decision: dict, profile_key: str = "balanced") -> dict:
    """把引擎的 final_state + decision 组装成统一的 Signal 载荷（集成方案 §3.4）。"""
    reports = {}
    mapping = [
        ("market", "market_report"),
        ("fundamentals", "fundamentals_report"),
        ("news", "news_report"),
        ("sentiment", "sentiment_report"),
        ("debate", "investment_plan"),          # 多空辩论 → 研究经理综合
        ("trader", "final_trade_decision"),
    ]
    for key, field in mapping:
        val = state.get(field)
        if isinstance(val, str) and val.strip():
            reports[key] = val

    risk_state = state.get("risk_debate_state") or {}
    risk_history = risk_state.get("history")
    if isinstance(risk_history, str) and risk_history.strip():
        reports["risk"] = risk_history

    signal = {
        "signal_type": "final",
        "ticker": params["ticker"],
        "company_name": resolve_company_name(params["ticker"]),
        "action": decision.get("action"),
        "target_price": decision.get("target_price"),
        "confidence": decision.get("confidence"),
        "risk_score": decision.get("risk_score"),
        "reasoning": decision.get("reasoning"),
        "model_info": decision.get("model_info"),
        "risk_profile": profile_key,
    }
    # 风险偏好护栏：引擎决策基础上按画像做确定性修正（仅明确冲突时覆盖）
    signal, calibrated, note = calibrate_stock_decision(signal, profile_key)
    signal["calibration"] = calibrated
    signal["calibration_note"] = note

    return {
        "signal": signal,
        "reports": reports,
        "performance_metrics": state.get("performance_metrics") or {},
    }


def resolve_company_name(ticker: str) -> str:
    """A 股代码 → 名称（600519 → 贵州茅台）；失败时回退为代码。"""
    try:
        info = get_china_stock_info_unified(ticker)
        name = info.get("name")
        if name and name != f"股票{ticker}":
            return name
    except Exception as e:
        logger.warning("⚠️ 股票名称解析失败 %s: %s", ticker, e)
    return ticker
