# -*- coding: utf-8 -*-
"""分析运行器。

Runner 接口（同步）：
    run(params: dict, progress_cb: Callable) -> dict
    pipeline_manifest(params: dict) -> dict  （可选，节点跟踪方案 §3）

progress_cb 既接受旧 str（向后兼容），也接受新 dict 结构化事件：
    - {"type": "stage",   "node_id": ..., "status": "done", ...}
    - {"type": "trace",   "node_id": ..., "content_preview": ..., ...}
    - {"type": "progress","percent": ..., "phase": ..., ...}

- S1 用 FakeRunner（sleep + 逐步 emit）验证 SSE 流式链路
- S2 用 EngineRunner 真正调用 TradingAgents-CN 的 propagate()
"""

import time
from typing import Callable


# FakeRunner 模拟的 12 步管道（与 standard 深度真引擎步数一致）
_FAKE_STAGES = [
    # (node_id, label, phase, content_type, sample_content)
    ("Market Analyst",       "📊 市场分析师",  "analysts", "report",   "# 市场分析报告（示例）\n\nMACD 金叉形成，RSI 62.3 偏强，成交量温和放大。"),
    ("Fundamentals Analyst", "💼 基本面分析师", "analysts", "report",   "# 基本面报告（示例）\n\nPE 25.3 处于历史中位，ROE 30%+，现金流稳健。"),
    ("News Analyst",         "📰 新闻分析师",  "analysts", "report",   "# 新闻分析报告（示例）\n\n近期利好消息偏多，无重大负面事件。"),
    ("Social Analyst",       "💬 情绪分析师",  "analysts", "report",   "# 情绪分析报告（示例）\n\n社交媒体看涨情绪占比 65%。"),
    ("Bull Researcher",      "🐂 看涨研究员",  "research", "debate",   "Bull Analyst: 技术面金叉 + 基本面稳健，建议逢低布局。"),
    ("Bear Researcher",      "🐻 看跌研究员",  "research", "debate",   "Bear Analyst: 估值已处中位偏上，短期涨幅过大需警惕回调。"),
    ("Research Manager",     "👔 研究经理",    "research", "decision", "综合多空辩论，建议持有，目标价 1560，止损 1480。"),
    ("Trader",               "📈 交易员",      "trader",   "decision", "交易计划：维持现仓位，等待回踩 1520 附近加仓。"),
    ("Risky Analyst",        "🔥 激进风险",    "risk",     "debate",   "激进视角：趋势确立可加仓至 8 成，止损 1480。"),
    ("Safe Analyst",         "🛡️ 保守风险",   "risk",     "debate",   "保守视角：仓位不超 5 成，严格止损，反弹至 1600 减仓。"),
    ("Neutral Analyst",      "⚖️ 中性风险",    "risk",     "debate",   "中性视角：维持 6 成仓位，均衡配置。"),
    ("Risk Judge",           "🎯 风险经理",    "risk",     "decision", "最终决策：持有，仓位维持 6 成，止损 1480，目标 1560。"),
]


class FakeRunner:
    """S1 假任务：模拟多智能体各阶段，验证流式进度端到端链路。

    发送结构化 dict 事件（stage/trace/progress），与真引擎事件协议一致，
    使 fake 模式可完整自测节点跟踪链路。
    """

    name = "fake"

    def pipeline_manifest(self, params: dict) -> dict:
        """返回与真引擎同构的管道清单（12 步 = 4 分析师 + 3 研究 + 1 交易 + 4 风险）。"""
        return {
            "type": "pipeline",
            "ticker": params.get("ticker", ""),
            "phases": [
                {"phase": "analysts", "label": "数据采集与分析师团队", "nodes": [
                    {"id": s[0], "label": s[1], "type": "analyst"}
                    for s in _FAKE_STAGES[:4]
                ]},
                {"phase": "research", "label": "多空辩论", "nodes": [
                    {"id": s[0], "label": s[1], "type": "debater" if s[3] == "debate" else "judge"}
                    for s in _FAKE_STAGES[4:7]
                ]},
                {"phase": "trader", "label": "交易决策", "nodes": [
                    {"id": s[0], "label": s[1], "type": "trader"}
                    for s in _FAKE_STAGES[7:8]
                ]},
                {"phase": "risk", "label": "风险辩论", "nodes": [
                    {"id": s[0], "label": s[1], "type": "debater" if s[3] == "debate" else "judge"}
                    for s in _FAKE_STAGES[8:12]
                ]},
            ],
            "total_steps": len(_FAKE_STAGES),
        }

    def run(self, params: dict, progress_cb: Callable) -> dict:
        ticker = params.get("ticker", "600519")
        total = len(_FAKE_STAGES)
        for step, (node_id, label, phase, ctype, content) in enumerate(_FAKE_STAGES, 1):
            now = time.time()
            # stage 事件
            progress_cb({
                "type": "stage",
                "node_id": node_id,
                "node_label": label,
                "phase": phase,
                "status": "done",
                "step_index": step,
                "total_steps": total,
                "elapsed_ms": 400,
                "message": label,
                "ts": now,
            })
            # trace 事件
            progress_cb({
                "type": "trace",
                "node_id": node_id,
                "node_label": label,
                "content_type": ctype,
                "content_preview": content[:200],
                "content_len": len(content),
                "ts": now,
            })
            # progress 事件
            progress_cb({
                "type": "progress",
                "percent": int(step / total * 100),
                "phase": phase,
                "message": label,
                "step_index": step,
                "total_steps": total,
                "ts": now,
            })
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

    def pipeline_manifest(self, params: dict) -> dict:
        return {
            "type": "pipeline",
            "phases": [
                {"phase": "resolve", "label": "读取持仓", "nodes": [
                    {"id": "resolve", "label": "📦 读取持仓", "type": "data"}]},
                {"phase": "quant", "label": "定量风险", "nodes": [
                    {"id": "quant", "label": "📐 定量风险", "type": "analyst"}]},
                {"phase": "aggregate", "label": "组合聚合", "nodes": [
                    {"id": "aggregate", "label": "🧮 组合聚合", "type": "judge"}]},
            ],
            "total_steps": 3,
        }

    def run(self, params: dict, progress_cb: Callable) -> dict:
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

    def pipeline_manifest(self, params: dict) -> dict:
        return {
            "type": "pipeline",
            "phases": [
                {"phase": "market", "label": "市场概况", "nodes": [
                    {"id": "market", "label": "🌏 市场概况", "type": "data"}]},
                {"phase": "sectors", "label": "板块行情", "nodes": [
                    {"id": "sectors", "label": "🧩 板块行情", "type": "analyst"}]},
                {"phase": "news", "label": "资讯汇总", "nodes": [
                    {"id": "news", "label": "📰 资讯汇总", "type": "analyst"}]},
            ],
            "total_steps": 3,
        }

    def run(self, params: dict, progress_cb: Callable) -> dict:
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


# 真引擎（S2）由 engine_bridge.py 提供，与 FakeRunner 同接口。
# lazy import：fake 模式（ADAPTER_RUNNER=fake）不需要安装 langgraph/chromadb
# 等引擎依赖，只有真正用到 EngineRunner 时才触发 engine_bridge 导入链。
def __getattr__(name):
    if name == "EngineRunner":
        from .engine_bridge import EngineRunner
        return EngineRunner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
