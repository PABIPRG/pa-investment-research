# -*- coding: utf-8 -*-
"""把量化任务结果渲染成统一报告库可持久化的 Markdown 正文。"""

from collections.abc import Mapping, Sequence
from typing import Any


_SEMANTIC_LABELS = {
    "participation": {
        "candidate": "候选",
        "active": "正常运行",
        "retired": "已淘汰",
        "rejected": "已拒绝",
    },
    "verification": {
        "passed": "已验证通过",
        "not_passed": "验证未通过",
        "insufficient": "样本不足",
    },
    "source": {
        "evolution": "变异来源",
        "manual": "人工",
        "event": "事件生成",
        "demo_fixture": "演示数据",
        "initial_auto": "自动首测",
        "periodic_retest": "自动复测",
    },
    "task": {
        "pending": "排队中",
        "running": "运行中",
        "completed": "已完成",
        "partial": "部分完成",
        "failed": "失败",
        "cancelled": "已取消",
        "interrupted": "已中断",
    },
}


def strategy_semantic_labels(
    participation_status: object,
    verification_status: object,
    confidence_tier: object,
    source: object,
    task_status: object,
) -> dict[str, str]:
    """统一五维确定性文案；未知值保留原值，缺失值不补造业务状态。"""
    def label(group: str, value: object, fallback: str) -> str:
        key = str(value or "").strip()
        return _SEMANTIC_LABELS[group].get(key, key or fallback)

    try:
        tier = int(confidence_tier or 1)
    except (TypeError, ValueError):
        tier = 1
    return {
        "participation": label("participation", participation_status, "未知"),
        "verification": label("verification", verification_status, "样本不足"),
        "confidence": "已升级" if tier >= 2 else "基础层级",
        "source": label("source", source, "未标注"),
        "task": label("task", task_status, "暂无任务"),
    }


def _text(value: Any, fallback: str = "—") -> str:
    if value is None:
        return fallback
    rendered = str(value).strip().replace("\r", " ").replace("\n", " ")
    return rendered or fallback


def _cell(value: Any, fallback: str = "—") -> str:
    return _text(value, fallback).replace("|", "\\|")


def _number(value: Any, suffix: str = "", digits: int = 2) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "—"
    return f"{value:.{digits}f}{suffix}"


def _integer(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "—"
    return str(int(value))


def render_backtest_report(
    summary: Mapping[str, Any],
    results: Sequence[Mapping[str, Any]],
    params: Mapping[str, Any],
) -> str:
    """渲染历史决策回测摘要，并保留可审计的关键口径。"""
    ticker = _text(params.get("code"), "全部历史决策")
    return "\n".join(
        [
            "# 历史决策回测报告",
            "",
            f"- 回测对象：{ticker}",
            f"- 评估窗口：{_integer(summary.get('eval_window_days'))} 个交易日",
            f"- 结果明细：{len(results)} 条",
            "",
            "| 指标 | 结果 |",
            "| --- | ---: |",
            f"| 已评估决策 | {_integer(summary.get('n_evaluated'))} |",
            f"| 行情拉取失败 | {_integer(summary.get('n_fetch_failed'))} |",
            f"| 方向准确率 | {_number(summary.get('direction_accuracy_pct'), '%')} |",
            f"| 胜率 | {_number(summary.get('win_rate_pct'), '%')} |",
            f"| 平均模拟收益 | {_number(summary.get('avg_simulated_return_pct'), '%')} |",
            f"| 年化 Sharpe | {_number(summary.get('sharpe_annualized'))} |",
            f"| 最大回撤 | {_number(summary.get('max_drawdown_pct'), '%')} |",
            "",
            "> 本报告只描述历史回测结果，不构成收益承诺或实盘交易指令。",
        ]
    )


def render_strategy_report(
    strategy: Mapping[str, Any],
    status: str,
    backtest: Mapping[str, Any],
    *,
    task_status: str | None = None,
) -> str:
    """渲染候选策略的样本内/样本外证据及独立生命周期、验证分类。"""
    in_sample = backtest.get("in_sample")
    out_sample = backtest.get("out_of_sample")
    in_sample = in_sample if isinstance(in_sample, Mapping) else {}
    out_sample = out_sample if isinstance(out_sample, Mapping) else {}
    symbols = strategy.get("symbols")
    symbol_text = "、".join(_text(item) for item in symbols) if isinstance(symbols, list) else "—"
    reason = _text(backtest.get("reason"), "未返回阈值结论")
    verification_status = _text(backtest.get("verification_status"), "")
    if verification_status == "":
        if backtest.get("thresholds_pass") is True:
            verification_status = "passed"
        elif "成交不足" in reason or "样本不足" in reason:
            verification_status = "insufficient"
        else:
            verification_status = "not_passed"
    if verification_status == "pending":
        verification_status = "insufficient"
    elif verification_status == "failed":
        verification_status = "not_passed"
    labels = strategy_semantic_labels(
        status,
        verification_status,
        (strategy.get("evolve") or {}).get("tier")
        if isinstance(strategy.get("evolve"), Mapping)
        else 1,
        strategy.get("source"),
        task_status,
    )
    verification_label = labels["verification"]
    return "\n".join(
        [
            "# 策略样本外回测报告",
            "",
            f"- 策略：{_text(strategy.get('name'), _text(strategy.get('id')))}",
            f"- 策略标识：{_text(strategy.get('id'))}",
            f"- 规则类型：{_text(strategy.get('kind'))}",
            f"- 研究方向：{_text(strategy.get('direction'))}",
            f"- 标的：{symbol_text or '—'}",
            f"- 生命周期状态：{_text(status)}",
            f"- 参与状态：{labels['participation']}",
            f"- 验证分类：{verification_label}",
            f"- 置信层级：{labels['confidence']}",
            f"- 来源：{labels['source']}",
            f"- 任务状态：{labels['task']}",
            "",
            "| 指标 | 样本内 | 样本外 |",
            "| --- | ---: | ---: |",
            f"| 交易数 | {_integer(in_sample.get('n_evaluated'))} | {_integer(out_sample.get('n_evaluated'))} |",
            f"| 胜率 | {_number(in_sample.get('win_rate_pct'), '%')} | {_number(out_sample.get('win_rate_pct'), '%')} |",
            f"| 平均模拟收益 | {_number(in_sample.get('avg_simulated_return_pct'), '%')} | {_number(out_sample.get('avg_simulated_return_pct'), '%')} |",
            f"| 年化 Sharpe | {_number(in_sample.get('sharpe_annualized'))} | {_number(out_sample.get('sharpe_annualized'))} |",
            f"| 最大回撤 | {_number(in_sample.get('max_drawdown_pct'), '%')} | {_number(out_sample.get('max_drawdown_pct'), '%')} |",
            "",
            "## 验证结论",
            "",
            f"- 阈值判定：{verification_label}",
            f"- 结论原因：{reason}",
            "",
            "> 样本外验证分类与策略生命周期相互独立；生命周期变化必须由显式业务动作完成。",
        ]
    )


def render_shadow_report(
    trade_date: str,
    strategies: Mapping[str, Mapping[str, Any]],
    overall_nav: Any,
    strategy_errors: Mapping[str, Any],
) -> str:
    """渲染一次真实行情纸面记账的组合与分策略证据。"""
    rows = [
        "# 影子验证报告",
        "",
        f"- 交易日：{_text(trade_date)}",
        f"- 验证策略：{len(strategies)} 个",
        f"- 组合净值：{_number(overall_nav, digits=6)}",
        "",
        "| 策略 | 标的 | 净值 | 权益 | 平仓数 |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    for strategy_id, record in strategies.items():
        symbols = record.get("symbols")
        symbol_text = "、".join(_cell(item) for item in symbols) if isinstance(symbols, list) else "—"
        rows.append(
            "| "
            + " | ".join(
                [
                    _cell(record.get("name"), strategy_id),
                    symbol_text or "—",
                    _number(record.get("nav"), digits=6),
                    _number(record.get("equity")),
                    _integer(record.get("closed_count")),
                ]
            )
            + " |"
        )
    if not strategies:
        rows.append("| — | — | — | — | — |")
    if strategy_errors:
        rows.extend(["", "## 未完成项", ""])
        rows.extend(
            f"- `{_text(strategy_id)}`：{_text(reason)}"
            for strategy_id, reason in strategy_errors.items()
        )
    rows.extend(
        [
            "",
            "> 本次运行只更新纸面账户，不会向任何券商或交易系统发送订单。",
        ]
    )
    return "\n".join(rows)
