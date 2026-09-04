# -*- coding: utf-8 -*-
"""为自进化演示准备可重复、与日常状态隔离的数据。"""

import shutil
import threading
from datetime import date, timedelta
from pathlib import Path

from .evolution import evolve_auto
from .config import settings
from . import backtest_tasks, shadow_tasks, strategies as strategy_service
from .report_store import ReportStore
from .store import JsonStore
from .task_report_render import render_shadow_report


DEMO_MARKER = ".dsh-evolution-demo-state"
_MARKER_CONTENT = "dsh-evolution-demo-state:v1\n"
RC10_TRADE_DATES = (
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
)
_DEMO_EVOLUTION_LOCK = threading.Lock()
DEMO_BACKTEST_TASK_ID = "a" * 32
DEMO_SHADOW_TASK_ID = "b" * 32
DEMO_PROVENANCE = {"kind": "demo_fixture", "fixture": "rc10"}
_DEMO_POLICY = {
    "evolve_min_days": 5,
    "evolve_promote_nav": 1.03,
    "evolve_demote_nav": 0.95,
    "evolve_retire_nav": 0.90,
    "evolve_retire_closed_win": 0.35,
    "evolve_mutate_branches": 2,
    "evolve_mutate_cooldown_days": 0,
}


def prepare_demo_state(root: Path) -> Path:
    """创建演示状态目录并写入清理护栏标记。"""
    root = root.expanduser().resolve()
    if root == Path(root.anchor) or root == Path.home():
        raise ValueError("演示状态目录必须是独立的绝对路径")
    marker = root / DEMO_MARKER
    if root.exists() and not marker.is_file():
        raise ValueError(f"拒绝接管已存在且未标记的目录: {root}")
    root.mkdir(parents=True, exist_ok=True)
    if marker.exists() and marker.read_text(encoding="utf-8") != _MARKER_CONTENT:
        raise ValueError(f"演示状态标记内容不匹配: {marker}")
    marker.write_text(_MARKER_CONTENT, encoding="utf-8")
    return root


def require_demo_state(root: Path) -> Path:
    root = root.expanduser().resolve()
    marker = root / DEMO_MARKER
    if (
        root == Path(root.anchor)
        or root == Path.home()
        or not marker.is_file()
        or marker.read_text(encoding="utf-8") != _MARKER_CONTENT
    ):
        raise ValueError(f"拒绝操作未标记的状态目录: {root}")
    return root


def clean_demo_state(root: Path) -> None:
    """只删除由本模块标记的独立演示状态目录。"""
    shutil.rmtree(require_demo_state(root))


def _dates(today: date | None = None) -> list[str]:
    """返回 rc.10 固定交易日；传 today 只供边界测试生成近期工作日。"""
    if today is None:
        return list(RC10_TRADE_DATES)
    cursor = today or date.today()
    days: list[str] = []
    while len(days) < 5:
        if cursor.weekday() < 5:
            days.append(cursor.isoformat())
        cursor -= timedelta(days=1)
    return list(reversed(days))


def _strategy(sid: str, name: str, scenario: str, kind: str = "momentum") -> dict:
    return {
        "id": sid,
        "name": name,
        "kind": kind,
        "direction": "利好",
        "symbols": ["600000"],
        "params": (
            {"n": 10}
            if kind == "momentum"
            else {"n": 14, "oversold": 30, "overbought": 70}
        ),
        "status": "active",
        "verification_status": "passed",
        "source": "demo_fixture",
        "demo_scenario": scenario,
        "backtest": {"out_of_sample": {"win_rate_pct": 60.0}},
        "evolve": {"state": "active", "tier": 1},
    }


def seed_deterministic_demo(store: JsonStore) -> dict:
    """在已标记隔离目录重建固定场景，并执行一次真实进化规则。"""
    require_demo_state(store.base_dir.parent)
    if store.base_dir.exists():
        shutil.rmtree(store.base_dir)
    store.base_dir.mkdir(parents=True, exist_ok=True)

    strategies = {
        "demo-normal": _strategy("demo-normal", "演示·正常运行", "normal"),
        "demo-promote": _strategy(
            "demo-promote", "演示·升级与变异", "promote_mutate", "rsi_reversal"
        ),
        "demo-watch": _strategy("demo-watch", "演示·降级观察", "watch"),
        "demo-retire": _strategy("demo-retire", "演示·淘汰", "retire"),
    }
    store.mutate_document("strategies", lambda _current: strategies)

    dates = _dates()
    navs = {
        "demo-normal": [1.000, 1.004, 1.006, 1.009, 1.010],
        "demo-promote": [1.000, 1.015, 1.030, 1.045, 1.060],
        "demo-watch": [1.000, 0.985, 0.970, 0.955, 0.940],
        "demo-retire": [1.000, 0.970, 0.940, 0.910, 0.880],
    }
    snapshots = {}
    for index, day in enumerate(dates):
        values = {sid: {"nav": series[index]} for sid, series in navs.items()}
        snapshots[day] = {
            "as_of": f"{day} 15:00:00",
            "overall_nav": round(sum(v["nav"] for v in values.values()) / len(values), 4),
            "strategies": values,
        }
    store.mutate_document("shadow_equity", lambda _current: snapshots)
    # 演示规则是固定产品夹具，不继承操作者机器上的生产阈值；该函数仅允许
    # 已标记的独立 demo state，且脚本进程内串行执行，结束后恢复原设置。
    with _DEMO_EVOLUTION_LOCK:
        original = {key: getattr(settings, key) for key in _DEMO_POLICY}
        try:
            for key, value in _DEMO_POLICY.items():
                setattr(settings, key, value)
            evolution = evolve_auto(store)
        finally:
            for key, value in original.items():
                setattr(settings, key, value)
    _seed_task_and_report_history(store, strategies, snapshots)
    return {
        "dates": dates,
        "evolution": evolution,
        "backtest_task_id": DEMO_BACKTEST_TASK_ID,
        "shadow_task_id": DEMO_SHADOW_TASK_ID,
    }


def _seed_task_and_report_history(
    store: JsonStore,
    base_strategies: dict[str, dict],
    snapshots: dict[str, dict],
) -> None:
    """经生产账本与报告 renderer 写入可由真实 API/UI 查询的固定历史。"""
    strategy = dict(store.get("strategies", "demo-promote") or base_strategies["demo-promote"])
    backtest = {
        "in_sample": {
            "n_evaluated": 12,
            "win_rate_pct": 58.33,
            "avg_simulated_return_pct": 1.8,
            "sharpe_annualized": 1.12,
            "max_drawdown_pct": -3.1,
        },
        "out_of_sample": {
            "n_evaluated": 6,
            "win_rate_pct": 66.67,
            "avg_simulated_return_pct": 2.4,
            "sharpe_annualized": 1.35,
            "max_drawdown_pct": -2.2,
        },
        "verification_status": "passed",
        "thresholds_pass": True,
        "reason": "rc.10 确定性演示夹具：样本外交易数、胜率与平均模拟收益均达标",
        "ran_at": f"{RC10_TRADE_DATES[-1]} 15:05:00",
        "per_symbol": {"600000": {"n_evaluated": 6, "win_rate_pct": 66.67}},
        "symbol_errors": {},
        "provenance": dict(DEMO_PROVENANCE),
    }
    backtest_tasks.create_pending_task(
        store,
        task_id=DEMO_BACKTEST_TASK_ID,
        strategy_id="demo-promote",
        source="initial_auto",
        window_start="2025-09-01",
        window_end=RC10_TRADE_DATES[-1],
        lookback_years=1.0,
        initial_capital=100000.0,
        request_params={
            "strategy_id": "demo-promote",
            "source": "initial_auto",
            "demo_provenance": dict(DEMO_PROVENANCE),
        },
        dedupe_key="demo:rc10:initial:demo-promote",
    )
    if not backtest_tasks.claim_task(store, DEMO_BACKTEST_TASK_ID):
        raise RuntimeError("无法认领 rc.10 演示回测任务")
    if not backtest_tasks.complete_task(
        store,
        DEMO_BACKTEST_TASK_ID,
        verification_status="passed",
        thresholds_pass=True,
        result=backtest,
    ):
        raise RuntimeError("无法完成 rc.10 演示回测任务")
    strategy_service.finalize_completed_backtest(store, DEMO_BACKTEST_TASK_ID, strategy)
    report_store = ReportStore(store)
    if backtest_tasks.get_task(store, DEMO_BACKTEST_TASK_ID).get("report_id") != DEMO_BACKTEST_TASK_ID:
        raise RuntimeError("无法关联 rc.10 演示回测报告")

    strategy_ids = list(base_strategies)
    shadow_tasks.create_pending_task(
        store,
        task_id=DEMO_SHADOW_TASK_ID,
        source="scheduled",
        scope="batch",
        strategy_ids=strategy_ids,
        trade_date=RC10_TRADE_DATES[-1],
        force=False,
        request_params={
            "trade_date": RC10_TRADE_DATES[-1],
            "demo_provenance": dict(DEMO_PROVENANCE),
        },
        dedupe_key=f"demo:rc10:shadow:{RC10_TRADE_DATES[-1]}",
    )
    if not shadow_tasks.claim_task(store, DEMO_SHADOW_TASK_ID):
        raise RuntimeError("无法认领 rc.10 演示影子任务")
    latest = snapshots[RC10_TRADE_DATES[-1]]
    rendered_strategies: dict[str, dict] = {}
    for sid in strategy_ids:
        base = base_strategies[sid]
        nav = latest["strategies"][sid]["nav"]
        snapshot = {
            "name": base["name"],
            "kind": base["kind"],
            "symbols": list(base["symbols"]),
            "nav": nav,
            "equity": round(nav * 100000, 2),
            "closed_count": 2,
            "provenance": dict(DEMO_PROVENANCE),
        }
        rendered_strategies[sid] = snapshot
        shadow_tasks.save_strategy_result(
            store,
            task_id=DEMO_SHADOW_TASK_ID,
            strategy_id=sid,
            status="success",
            reason="rc.10 确定性演示夹具完成纸面记账",
            snapshot=snapshot,
            trade_date=RC10_TRADE_DATES[-1],
        )
    shadow_result = {
        "task_id": DEMO_SHADOW_TASK_ID,
        "task_status": "completed",
        "skipped": False,
        "trade_date": RC10_TRADE_DATES[-1],
        "strategies": rendered_strategies,
        "overall_nav": latest["overall_nav"],
        "strategy_errors": {},
        "signal": {
            "signal_type": "shadow_validation",
            "strategy_id": None,
            "strategy_name": None,
            "strategy_count": len(rendered_strategies),
            "trade_date": RC10_TRADE_DATES[-1],
            "overall_nav": latest["overall_nav"],
            "demo_provenance": dict(DEMO_PROVENANCE),
        },
        "provenance": dict(DEMO_PROVENANCE),
    }
    shadow_report = render_shadow_report(
        RC10_TRADE_DATES[-1],
        rendered_strategies,
        latest["overall_nav"],
        {},
    )
    shadow_result["reports"] = {"shadow": shadow_report}
    store.mutate(
        "shadow_equity",
        RC10_TRADE_DATES[-1],
        lambda current: {
            **dict(current or {}),
            "runs": {
                **dict((current or {}).get("runs") or {}),
                DEMO_SHADOW_TASK_ID: {
                    **dict(current or {}),
                    "task_id": DEMO_SHADOW_TASK_ID,
                },
            },
            "latest_task_id": DEMO_SHADOW_TASK_ID,
        },
        {},
    )
    if not shadow_tasks.finalize_task(
        store,
        DEMO_SHADOW_TASK_ID,
        overall_nav=latest["overall_nav"],
        result=shadow_result,
    ):
        raise RuntimeError("无法完成 rc.10 演示影子任务")
    if report_store.save_task_result(
        DEMO_SHADOW_TASK_ID,
        "shadow",
        {},
        {
            **shadow_result,
        },
    ) is None or not shadow_tasks.attach_report(
        store, DEMO_SHADOW_TASK_ID, DEMO_SHADOW_TASK_ID
    ):
        raise RuntimeError("无法关联 rc.10 演示影子报告")


def verify_demo_state(store: JsonStore) -> dict:
    """验证演示数据覆盖正常、升级变异、观察和淘汰四类结果。"""
    snapshots = store.all("shadow_equity") or {}
    strategies = store.all("strategies") or {}
    parent = strategies.get("demo-promote") or {}
    children = [
        row
        for row in strategies.values()
        if isinstance(row, dict) and row.get("mutated_from") == "demo-promote"
    ]
    scenarios = []
    normal = strategies.get("demo-normal") or {}
    if normal.get("status") == "active" and (normal.get("evolve") or {}).get("tier") == 1:
        scenarios.append("normal")
    if (parent.get("evolve") or {}).get("tier") == 2 and children:
        scenarios.append("promote_mutate")
    watch = strategies.get("demo-watch") or {}
    if watch.get("status") == "active" and (watch.get("evolve") or {}).get("state") == "watch":
        scenarios.append("watch")
    retired = strategies.get("demo-retire") or {}
    if retired.get("status") == "retired" and (retired.get("evolve") or {}).get("state") == "retired":
        scenarios.append("retire")

    expected = {"normal", "promote_mutate", "watch", "retire"}
    missing = expected.difference(scenarios)
    snapshot_dates = sorted(snapshots)
    invalid_dates = [
        day
        for day in snapshot_dates
        if date.fromisoformat(day).weekday() >= 5
    ]
    expected_strategies = {"demo-normal", "demo-promote", "demo-watch", "demo-retire"}
    nav_gaps = {
        sid: [
            day
            for day in snapshot_dates
            if not isinstance(((snapshots.get(day) or {}).get("strategies") or {}).get(sid), dict)
            or not isinstance(
                (((snapshots.get(day) or {}).get("strategies") or {}).get(sid) or {}).get("nav"),
                (int, float),
            )
            or (((snapshots.get(day) or {}).get("strategies") or {}).get(sid) or {}).get("nav") <= 0
        ]
        for sid in expected_strategies
    }
    nav_gaps = {sid: days for sid, days in nav_gaps.items() if days}

    applied = [
        row
        for row in (store.all("evolution_previews") or {}).values()
        if isinstance(row, dict) and row.get("preview_status") == "applied"
    ]
    applied_actions = [
        action
        for row in applied
        for action in row.get("actions") or []
        if isinstance(action, dict)
    ]
    action_types = {str(action.get("type") or "") for action in applied_actions}
    expected_action_types = {"promote", "mutate", "demote", "retire"}
    actions_valid = expected_action_types.issubset(action_types) and all(
        isinstance(action.get("reason"), str) and action["reason"].strip()
        for action in applied_actions
    )
    children_valid = len(children) == 2 and all(
        child.get("status") == "candidate"
        and child.get("verification_status") == "insufficient"
        and child.get("source") == "evolution"
        and child.get("mutated_from") == "demo-promote"
        and isinstance(child.get("params"), dict)
        and bool(child.get("params"))
        and bool(child.get("created_at"))
        for child in children
    )
    reports = ReportStore(store)
    backtest_task = backtest_tasks.get_task(store, DEMO_BACKTEST_TASK_ID) or {}
    backtest_report = reports.get_report(DEMO_BACKTEST_TASK_ID)
    backtest_valid = (
        backtest_task.get("status") == "completed"
        and backtest_task.get("source") == "initial_auto"
        and backtest_task.get("strategy_id") == "demo-promote"
        and backtest_task.get("verification_status") == "passed"
        and backtest_task.get("report_id") == DEMO_BACKTEST_TASK_ID
        and (backtest_task.get("result") or {}).get("provenance") == DEMO_PROVENANCE
        and isinstance(backtest_report, dict)
        and (backtest_report.get("reference") or {}).get("strategy_id") == "demo-promote"
        and "参与状态：正常运行" in str((backtest_report.get("reports") or {}).get("strategy") or "")
        and "任务状态：已完成" in str((backtest_report.get("reports") or {}).get("strategy") or "")
    )
    shadow_task = shadow_tasks.get_task_with_results(store, DEMO_SHADOW_TASK_ID) or {}
    shadow_report = reports.get_report(DEMO_SHADOW_TASK_ID)
    shadow_results = shadow_task.get("results") or []
    latest_strategy_snapshots = (
        (snapshots.get(RC10_TRADE_DATES[-1]) or {}).get("strategies") or {}
    )
    shadow_valid = (
        shadow_task.get("status") == "completed"
        and shadow_task.get("source") == "scheduled"
        and shadow_task.get("scope") == "batch"
        and shadow_task.get("report_id") == DEMO_SHADOW_TASK_ID
        and (shadow_task.get("result") or {}).get("provenance") == DEMO_PROVENANCE
        and len(shadow_results) == len(expected_strategies)
        and isinstance(shadow_report, dict)
        and (latest_strategy_snapshots is not None)
        and (
            ((snapshots.get(RC10_TRADE_DATES[-1]) or {}).get("runs") or {}).get(DEMO_SHADOW_TASK_ID)
            or {}
        ).get("task_id") == DEMO_SHADOW_TASK_ID
        and (snapshots.get(RC10_TRADE_DATES[-1]) or {}).get("latest_task_id") == DEMO_SHADOW_TASK_ID
        and all(
            result.get("status") == "success"
            and result.get("report_id") == DEMO_SHADOW_TASK_ID
            and (result.get("equity_ref") or {}).get("collection") == "shadow_equity"
            and (result.get("equity_ref") or {}).get("key") == RC10_TRADE_DATES[-1]
            and (result.get("equity_ref") or {}).get("task_id") == DEMO_SHADOW_TASK_ID
            and result.get("strategy_id") in expected_strategies
            and result.get("strategy_id") in latest_strategy_snapshots
            for result in shadow_results
        )
    )
    if (
        snapshot_dates != list(RC10_TRADE_DATES)
        or missing
        or invalid_dates
        or nav_gaps
        or not actions_valid
        or not children_valid
        or not backtest_valid
        or not shadow_valid
    ):
        raise ValueError(
            "演示数据校验失败: "
            f"days={len(snapshots)}, missing={sorted(missing)}, "
            f"invalid_trade_dates={invalid_dates}, nav_gaps={nav_gaps}, "
            f"action_types={sorted(action_types)}, children_valid={children_valid}, "
            f"backtest_valid={backtest_valid}, shadow_valid={shadow_valid}"
        )
    return {
        "days": len(snapshots),
        "dates": snapshot_dates,
        "scenarios": sorted(scenarios),
        "children": len(children),
        "action_types": sorted(action_types),
        "backtest_task_id": DEMO_BACKTEST_TASK_ID,
        "shadow_task_id": DEMO_SHADOW_TASK_ID,
        "reports": 2,
    }
