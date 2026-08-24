# -*- coding: utf-8 -*-
"""定时盘前/盘后简报（功能4 调度侧）。

- APScheduler 后台调度 08:50 / 15:30（可配 BRIEF_PRE_MARKET_TIME / BRIEF_POST_MARKET_TIME）
- job 内先 `tool_trade_date_hist_sina()` 判交易日（官方日历，**不能用 get_market_status 启发式**）
- (period, trade_date) 幂等：已存在则跳过，避免重启/重复触发重复生成与重复推送
- 生成后经 PusherManager 推送（企业微信 + Server酱），单通道失败不影响其它

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


def setup_scheduler() -> BackgroundScheduler | None:
    """按 BRIEF_SCHEDULE_ENABLED / SHADOW_SCHEDULE_ENABLED 决定是否挂载；全关返回 None。"""
    if not settings.schedule_enabled and not settings.shadow_schedule_enabled:
        logger.info("BRIEF_SCHEDULE_ENABLED=false 且 SHADOW_SCHEDULE_ENABLED=false，跳过定时调度")
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

    if sched.get_jobs():
        sched.start()
    return sched
