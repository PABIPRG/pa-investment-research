# -*- coding: utf-8 -*-
"""分析运行器。

Runner 接口（同步）：
    run(params: dict, progress_cb: Callable[[str], None]) -> dict

- S1 用 FakeRunner（sleep + 逐步 emit）验证 SSE 流式链路
- S2 用 EngineRunner 真正调用 TradingAgents-CN 的 propagate()

进度回调由引擎线程调用，适配器把它投递到事件循环队列 → SSE。
"""

import time
from typing import Callable


class FakeRunner:
    """S1 假任务：模拟多智能体各阶段，验证流式进度端到端链路。"""

    name = "fake"

    def run(self, params: dict, progress_cb: Callable[[str], None]) -> dict:
        stages = [
            ("market_analyst", "🔍 市场分析师：分析技术趋势（MA/MACD/RSI/BOLL）…"),
            ("fundamentals_analyst", "📊 基本面分析师：解读财报与估值…"),
            ("news_analyst", "📰 新闻分析师：扫描市场舆情…"),
            ("sentiment_analyst", "💬 情绪分析师：评估多空情绪…"),
            ("debate", "🤝 多空双方辩论中…"),
            ("risk", "🛡 风险三方辩论（激进/稳健/保守）…"),
            ("trader", "📈 交易员生成投资计划与信号…"),
        ]
        ticker = params.get("ticker", "600519")
        for node, msg in stages:
            progress_cb(f"{msg} (node={node})")
            time.sleep(0.4)
        # 返回与 EngineRunner 相同的统一载荷（signal/reports/performance_metrics）
        return {
            "signal": {
                "signal_type": "final",
                "ticker": ticker,
                "company_name": "贵州茅台（假数据）",
                "action": "买入",
                "target_price": 1560.0,
                "confidence": 0.75,
                "risk_score": 0.4,
                "reasoning": "S1 假任务示例信号，用于验证 SSE 流式链路。",
            },
            "reports": {"market": "# 示例报告\n\n假任务不产出真实报告。"},
            "performance_metrics": {},
        }


class FakeHoldingsRunner:
    """S 阶段 A：持仓分析假任务，验证 registry + SSE 闭环（无引擎自测）。"""

    name = "fake-holdings"

    def run(self, params: dict, progress_cb: Callable[[str], None]) -> dict:
        stages = [
            ("resolve", "📦 读取持仓（fake）…"),
            ("quant", "📐 计算定量风险：波动率/回撤/beta…"),
            ("aggregate", "🧮 聚合组合风险（集中度/行业暴露）…"),
        ]
        holdings = params.get("holdings") or []
        for node, msg in stages:
            progress_cb(f"{msg} (node={node})")
            time.sleep(0.3)
        return {
            "signal": {
                "signal_type": "portfolio",
                "holdings": holdings,
                "total_market_value": 200000.0,
                "total_cost": 180000.0,
                "floating_pnl": 20000.0,
                "weighted_risk_score": 0.45,
                "concentration_hhi": 0.33,
                "top_sector": "食品饮料",
                "n_positions": len(holdings),
            },
            "reports": {"portfolio": "# 组合风险报告（fake）\n\n假任务不产出真实报告。"},
            "performance_metrics": {},
        }


class FakeBriefRunner:
    """S 阶段 A：盘前/盘后简报假任务，验证 registry + SSE 闭环。"""

    name = "fake-brief"

    def run(self, params: dict, progress_cb: Callable[[str], None]) -> dict:
        stages = [
            ("market", "🌏 拉取指数与市场概况（fake）…"),
            ("sectors", "🧩 拉取板块行情（fake）…"),
            ("news", "📰 汇总资讯与机会点（fake）…"),
        ]
        period = params.get("period", "now")
        for node, msg in stages:
            progress_cb(f"{msg} (node={node})")
            time.sleep(0.3)
        return {
            "signal": {
                "signal_type": "brief",
                "period": period,
                "summary": f"# {period} 简报（fake）\n\n假任务不产出真实行情。",
                "opportunities": [{"kind": "fake", "title": "示例机会点"}],
            },
            "reports": {"brief": f"# {period} 简报\n\n假任务不产出真实行情。"},
            "performance_metrics": {},
        }


# 真引擎（S2）由 engine_bridge.py 提供，与 FakeRunner 同接口
from .engine_bridge import EngineRunner  # noqa: E402  # isort: skip
