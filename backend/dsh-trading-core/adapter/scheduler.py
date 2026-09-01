# -*- coding: utf-8 -*-
"""定时盘前/盘后简报（功能4 调度侧）。

- APScheduler 后台调度 08:50 / 15:30（可配 BRIEF_PRE_MARKET_TIME / BRIEF_POST_MARKET_TIME）
- job 内先 `tool_trade_date_hist_sina()` 判交易日（官方日历，**不能用 get_market_status 启发式**）
- (period, trade_date) 幂等：已存在则跳过，避免重启/重复触发重复生成与重复推送
- 生成后经 PusherManager 推送（企业微信 + Server酱），单通道失败不影响其它
- 另有 shadow_daily 影子验证，与 closed_loop_daily 全自动闭环
  （拉事件→生成候选 → 影子 → 自动进化 → 候选回测激活 → 推送）

挂载：adapter/app.py lifespan 里 setup_scheduler()，退出时 shutdown()。
"""

import logging
import os
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import settings
from .push import PusherManager
from .store import JsonStore

logger = logging.getLogger("adapter.scheduler")

_TIMEZONE = os.getenv("TIMEZONE", "Asia/Shanghai")


def _run_brief_job(period: str) -> None:
    """一次定时简报：判交易日 → 幂等 → 生成 → 推送。"""
    from .brief_engine import BriefRunner, _is_trading_day  # lazy: fake 模式不需要 openai
    store = JsonStore()
    today = datetime.now().strftime("%Y-%m-%d")

    if not _is_trading_day(today):
        logger.info("非交易日 %s，跳过 %s 简报", today, period)
        return

    key = f"{period}:{today}"
    if store.get("briefs", key):
        logger.info("简报已存在，跳过（幂等）: %s", key)
        return

    logger.info("⏰ 生成 %s 简报（%s）…", period, today)
    try:
        res = BriefRunner().run({"period": period, "scope": "all"}, lambda m: None)
    except Exception as exc:  # noqa: BLE001
        logger.error("简报生成失败: %s", exc)
        return

    md = (res.get("signal") or {}).get("summary") or ""
    label = {"pre_market": "盘前", "post_market": "盘后"}.get(period, period)
    title = f"📊 A股{label}简报 · {today}"
    results = PusherManager().push(title, md)
    logger.info("推送完成: %s", results)


def _parse_hhmm(s: str) -> tuple[int, int]:
    h, m = (s.split(":") + ["0"])[:2]
    return int(h), int(m)


def _run_shadow_job() -> None:
    """每日影子验证：判交易日 → 记账（幂等，已运行自动跳过）。"""
    from .brief_engine import _is_trading_day  # lazy
    today = datetime.now().strftime("%Y-%m-%d")

    if not _is_trading_day(today):
        logger.info("非交易日 %s，跳过影子验证", today)
        return

    logger.info("⏰ 定时影子验证（%s）…", today)
    try:
        from .shadow import ShadowRunner
        res = ShadowRunner().run({"force": False}, lambda m: None)
        if res.get("skipped"):
            logger.info("影子验证跳过: %s", res.get("reason"))
        else:
            logger.info("影子验证完成: overall_nav=%s, strategies=%d",
                        res.get("overall_nav"), len(res.get("strategies") or {}))
    except Exception as exc:  # noqa: BLE001 — 定时任务异常不拖垮服务
        logger.error("影子验证失败: %s", exc)


def _run_event_generation(store: JsonStore) -> dict:
    """Step 0：拉市场事件 → 假设 → 候选落池（EVENT_GENERATION_ENABLED 控制）。

    幂等天然成立：create_candidates 按 md5(事件id+kind+排序symbols) 去重，
    同事件同策略不重复生成，每天只产生新事件候选。事件源失败 fail-open 返回空。
    """
    from .strategies import create_candidates, fetch_events, generate_hypotheses
    events = fetch_events(limit=settings.event_generation_limit, timeout=20.0)
    if not events:
        return {"n_events": 0, "candidates": [], "note": "事件源暂无事件"}
    hypotheses = generate_hypotheses(events)
    ids = create_candidates(events, hypotheses)
    return {"n_events": len(events), "n_hypotheses": len(hypotheses), "candidates": ids}


def _run_closed_loop_job() -> None:
    """全自动自进化闭环：拉事件生成候选 → shadow → 自动进化 → 候选回测激活 → 推送。

    每个交易日跑一次；任一环节异常不拖垮整轮，进度由日志 + 推送日报留痕。
    候选回测只用 verification_status 仍为 pending 的（passed/failed 天然跳过），
    同步调用 StrategyBacktestRunner（baostock 串行，无 LLM），通过→激活、失败→淘汰。
    """
    from .brief_engine import _is_trading_day  # lazy
    today = datetime.now().strftime("%Y-%m-%d")

    if not _is_trading_day(today):
        logger.info("非交易日 %s，跳过自进化闭环", today)
        return

    logger.info("🔁 自进化闭环（%s）…", today)
    store = JsonStore()
    lines: list[str] = []
    # Step 0：拉事件 → 生成新策略候选（并入闭环，EVENT_GENERATION_ENABLED 控制）
    try:
        if settings.event_generation_enabled:
            gen = _run_event_generation(store)
            ids = gen.get("candidates") or []
            lines.append(
                f"事件生成：{gen.get('n_events')} 事件 → 新增 {len(ids)} 候选"
                + (f"（{gen.get('note')}）" if gen.get("note") else "")
            )
    except Exception as exc:  # noqa: BLE001
        logger.error("闭环事件生成失败: %s", exc)
        lines.append(f"事件生成：失败 {exc}")
    try:
        # Step A：影子验证（幂等，同日已跑自动 skipped）
        from .shadow import ShadowRunner
        shadow = ShadowRunner(store).run({"force": False}, lambda m: None)
        if shadow.get("skipped"):
            lines.append(f"影子验证：{shadow.get('reason')}")
        else:
            lines.append(
                f"影子验证：ok，overall_nav={shadow.get('overall_nav')}，"
                f"策略 {len(shadow.get('strategies') or {})} 个"
            )
    except Exception as exc:  # noqa: BLE001
        logger.error("闭环影子验证失败: %s", exc)
        lines.append(f"影子验证：失败 {exc}")

    # Step B：自动进化（数据就绪才写库）
    evolve_report = {"status": "waiting_data", "count": 0, "actions": []}
    try:
        from . import evolution
        evolve_report = evolution.evolve_auto(store)
    except Exception as exc:  # noqa: BLE001
        logger.error("闭环自动进化失败: %s", exc)
        lines.append(f"自动进化：失败 {exc}")
    actions = evolve_report.get("actions") or []
    if actions:
        labels = {"promote": "升级", "demote": "降级", "retire": "淘汰", "mutate": "变异"}
        lines.append(f"自动进化：应用 {len(actions)} 项动作")
        for a in actions:
            label = labels.get(a.get("type"), a.get("type"))
            lines.append(f"  · {label} {a.get('sid')}：{a.get('reason', '')}")
    else:
        lines.append(
            f"自动进化：{evolve_report.get('status', 'none')}"
            + (f"（{evolve_report.get('data_note', '')}）" if evolve_report.get("data_note") else "")
        )

    # Step C：衍生候选自动回测 → 激活/淘汰
    activated: list[str] = []
    rejected: list[str] = []
    try:
        from .strategies import StrategyBacktestRunner, transition_strategy
        runner = StrategyBacktestRunner(store)
        candidates = [
            sid for sid, s in (store.all("strategies") or {}).items()
            if isinstance(s, dict) and s.get("status") == "candidate"
            and s.get("verification_status") not in ("passed", "failed", "archived")
        ]
        for sid in candidates:
            try:
                res = runner.run(
                    {"strategy_id": sid, "lookback_years": 2.0, "oos_frac": 0.3,
                     "min_oos_trades": 4},
                    lambda m: None,
                )
                vstatus = res.get("verification_status")
                if vstatus == "passed":
                    transition_strategy(store, sid, "activate")
                    activated.append(sid)
                    logger.info("候选 %s 回测通过 → 激活进入影子", sid)
                elif vstatus == "failed" and settings.candidate_auto_reject:
                    transition_strategy(store, sid, "reject")
                    rejected.append(sid)
                    logger.info("候选 %s 回测未达标 → 淘汰", sid)
            except Exception as exc:  # noqa: BLE001 — 单候选失败不拖垮整轮
                logger.warning("候选 %s 自动回测失败: %s", sid, exc)
        lines.append(
            f"候选验证：回测 {len(candidates)} 条，激活 {len(activated)}，淘汰 {len(rejected)}"
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("闭环候选验证失败: %s", exc)
        lines.append(f"候选验证：失败 {exc}")

    # Step D：推送闭环日报（通道未配则 no-op，不影响闭环）
    try:
        from .push import PusherManager
        md = "\n".join(lines) or "（本轮无记录）"
        results = PusherManager().push(f"📈 自进化闭环日报 · {today}", md)
        logger.info("闭环日报推送完成: %s", results)
    except Exception as exc:  # noqa: BLE001
        logger.error("闭环日报推送失败: %s", exc)


def setup_scheduler() -> BackgroundScheduler | None:
    """按 BRIEF_SCHEDULE_ENABLED / SHADOW_SCHEDULE_ENABLED / CLOSED_LOOP_ENABLED 决定是否挂载；全关返回 None。"""
    if not settings.schedule_enabled and not settings.shadow_schedule_enabled and not settings.closed_loop_enabled:
        logger.info("简报/影子/闭环调度全关，跳过定时调度")
        return None

    sched = BackgroundScheduler(timezone=_TIMEZONE)

    if settings.schedule_enabled:
        pre_h, pre_m = _parse_hhmm(settings.pre_market_time)
        post_h, post_m = _parse_hhmm(settings.post_market_time)
        sched.add_job(
            _run_brief_job, CronTrigger(hour=pre_h, minute=pre_m),
            args=["pre_market"], id="brief_pre_market", replace_existing=True,
        )
        sched.add_job(
            _run_brief_job, CronTrigger(hour=post_h, minute=post_m),
            args=["post_market"], id="brief_post_market", replace_existing=True,
        )
        logger.info("🕗 定时简报已启动: %s:%02d 盘前 / %s:%02d 盘后", pre_h, pre_m, post_h, post_m)

    if settings.shadow_schedule_enabled:
        s_h, s_m = _parse_hhmm(settings.shadow_run_time)
        sched.add_job(
            _run_shadow_job, CronTrigger(hour=s_h, minute=s_m),
            id="shadow_daily", replace_existing=True,
        )
        logger.info("👤 定时影子验证已启动: %s:%02d", s_h, s_m)

    if settings.closed_loop_enabled:
        c_h, c_m = _parse_hhmm(settings.closed_loop_time)
        sched.add_job(
            _run_closed_loop_job, CronTrigger(hour=c_h, minute=c_m),
            id="closed_loop_daily", replace_existing=True,
        )
        logger.info("🔁 定时自进化闭环已启动: %s:%02d", c_h, c_m)

    if sched.get_jobs():
        sched.start()
    return sched
