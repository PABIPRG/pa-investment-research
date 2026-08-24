# -*- coding: utf-8 -*-
"""调度器 + 盯盘主循环：条件评估 → 冷却/上限 → LLM 解读 → 多渠道推送。

4 类 job（全部受交易日守卫，定时推送默认 OFF，.env 开启）：
  盘中轮询  IntervalTrigger(poll_interval s)  交易时段内
  新闻速递  IntervalTrigger(news_interval_min) 交易日 + 时段
  盘前简报  CronTrigger(pre_brief_time)        交易日
  盘后日报  CronTrigger(post_brief_time)       交易日
run_watch_cycle(manual) 是手动盯盘入口（/scheduler/tick），绕时段守卫、仍应用冷却/上限。
"""

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from . import briefs, news, quotes, rules
from .config import settings
from .push import PusherManager
from .store import JsonStore

logger = logging.getLogger("market_watch.scheduler")

_MAX_TRIGGERS_KEPT = 50
_scheduler: BackgroundScheduler | None = None


class _TriggerRejected(Exception):
    def __init__(self, outcome: str):
        super().__init__(outcome)
        self.outcome = outcome


# ---- 状态维护 -----------------------------------------------------------


def _state() -> dict:
    return JsonStore().get("state", "data", {})


def _cooldown_ok(st: dict, rule_id: str, cooldown_min: int) -> bool:
    if not cooldown_min:
        return True
    ts = st.get("cooldowns", {}).get(rule_id)
    if not ts:
        return True
    last = datetime.fromisoformat(ts)
    return (datetime.now(ZoneInfo(settings.timezone)) - last).total_seconds() >= cooldown_min * 60


def _daily_cap_ok(st: dict, rule_id: str, date: str, cap: int) -> bool:
    if not cap:
        return True
    return st.get("daily_counts", {}).get(rule_id, {}).get(date, 0) < cap


def _record_trigger(t: dict, cooldown_min: int, cap: int) -> str:
    """原子检查冷却/日上限并登记触发，返回 recorded/cooldown/cap。"""
    def claim(current):
        st = dict(current or {})
        if not _cooldown_ok(st, t["rule_id"], cooldown_min):
            raise _TriggerRejected("cooldown")
        if not _daily_cap_ok(st, t["rule_id"], t["date"], cap):
            raise _TriggerRejected("cap")
        st.setdefault("cooldowns", {})[t["rule_id"]] = t["ts"]
        counts = st.setdefault("daily_counts", {}).setdefault(t["rule_id"], {})
        counts[t["date"]] = counts.get(t["date"], 0) + 1
        # 仅保留当日触发，历史滚进 triggers 日志（截断）
        triggers = st.setdefault("triggers", [])
        if t["date"] != (triggers[-1]["date"] if triggers else None):
            triggers.clear()
        triggers.append(t)
        del triggers[:-_MAX_TRIGGERS_KEPT]
        return st

    try:
        JsonStore().mutate("state", "data", claim, {})
    except _TriggerRejected as exc:
        return exc.outcome
    return "recorded"


def _trigger_text(quote: dict, brief: dict) -> str:
    return (
        f"{quote['name']}（{quote['code']}）现价 {quote.get('price')}，"
        f"涨跌 {quote.get('pct_change')}% — 触发规则「{brief['name']}」"
        f"（{brief['condition_text']}）"
    )


def _interpret(quote: dict, brief: dict) -> str | None:
    """LLM 触发解读（best-effort，失败回退 None 由调用方补模板）。"""
    if not settings.llm_available():
        return None
    try:
        from .indicators import compute_indicators, summarize
        from . import llm

        df = quotes.get_kline(quote["code"], lookback=min(settings.lookback_days, 60))
        ind_lines = summarize(compute_indicators(df)) if df is not None else []
        system = (
            "你是A股盯盘解读助手。用户的自选股触发了一条盯盘规则，请给一句简短解读"
            "（什么情况、原因、注意点），不超过80字，不荐股。"
        )
        block = {
            "股票": quote["name"], "代码": quote["code"], "现价": quote.get("price"),
            "涨跌幅%": quote.get("pct_change"), "触发条件": brief["condition_text"],
            "技术信号": ind_lines,
        }
        return llm.chat(system, str(block), max_tokens=300)
    except Exception as exc:
        logger.warning("触发解读 LLM 失败: %s", exc)
        return None


# ---- 盯盘主循环 -----------------------------------------------------------


def run_watch_cycle(manual: bool = False) -> dict:
    """评估一轮所有启用规则，返回 {evaluated, triggered, skipped_cooldown, skipped_cap, push_results}。
    manual=True 绕时段守卫（供 /scheduler/tick 夜间测试），冷却/上限照常生效。"""
    if not manual and not (quotes.is_trading_day(quotes.latest_trade_date())
                           and quotes.in_trading_session()):
        return {"evaluated": 0, "triggered": [], "skipped_cooldown": 0, "skipped_cap": 0,
                "push_results": [], "reason": "非交易时段"}

    store = JsonStore()
    alerts = [r for r in store.get("alerts", "default", []) if r.get("enabled", True)]
    watchlist = store.get("watchlist", "default", []) or []
    codes = {w["code"] for w in watchlist}
    # 规则可带独立 ticker（不在自选也能盯），汇总需要评估的代码
    for a in alerts:
        if a.get("ticker"):
            codes.add(a["ticker"])

    quotes_map = {q["code"]: q for q in quotes.cache().get_quotes(sorted(codes))}
    now = datetime.now(ZoneInfo(settings.timezone))
    today = now.strftime("%Y-%m-%d")

    summary = {"evaluated": 0, "triggered": [], "skipped_cooldown": 0, "skipped_cap": 0,
               "push_results": []}
    pushes: list[tuple[str, str]] = []

    for rule in alerts:
        for code in sorted(codes):
            if rule.get("ticker") and rule["ticker"] != code:
                continue
            quote = quotes_map.get(code)
            if quote is None:
                continue
            res = rules.eval_rule(rule, quote)
            if not res["triggered"]:
                continue
            summary["evaluated"] += 1
            ts = now.isoformat(timespec="seconds")
            # value = 命中条件的字段值（combine=or 取首个命中；and 取首个条件）
            ok_results = [r for r in res["results"] if r and r["ok"]]
            trig = {
                "date": today, "ts": ts, "rule_id": rule["id"],
                "rule_name": rule.get("name", ""), "code": code, "name": quote["name"],
                "value": ok_results[0]["value"] if ok_results else quote.get("pct_change"),
                "price": quote.get("price"),
                "condition_text": rules.describe_rule(rule),
            }
            brief = {
                "id": rule["id"], "name": rule.get("name", ""),
                "condition_text": rules.describe_rule(rule),
            }
            outcome = _record_trigger(
                trig,
                rule.get("cooldown_min", 0),
                rule.get("daily_cap", 0),
            )
            if outcome == "cooldown":
                summary["skipped_cooldown"] += 1
                continue
            if outcome == "cap":
                summary["skipped_cap"] += 1
                continue
            summary["triggered"].append(trig)

            interp = _interpret(quote, brief)
            text = _trigger_text(quote, brief)
            if interp:
                text += f"\n\n> LLM解读：{interp}"
            pushes.append((f"盯盘触发 {quote['name']}", text))

    if settings.push_enabled and pushes:
        pm = PusherManager()
        for title, content in pushes:
            summary["push_results"].extend(pm.push(title, content))
    return summary


# ---- 调度 job -------------------------------------------------------------


def _poll_job() -> None:
    if not quotes.in_trading_session():
        return
    try:
        run_watch_cycle(manual=True)  # 已判时段，这里放开守卫
    except Exception as exc:
        logger.exception("盘中轮询失败: %s", exc)


def _news_job() -> None:
    if not (quotes.is_trading_day(quotes.latest_trade_date()) and quotes.in_trading_session()):
        return
    try:
        record = news.express()
        if settings.push_enabled:
            PusherManager().push("新闻速递", record["digest"])
    except Exception as exc:
        logger.exception("新闻速递失败: %s", exc)


def _pre_brief_job() -> None:
    if not quotes.is_trading_day(quotes.latest_trade_date()):
        return
    try:
        record = briefs.generate("pre", manual=True)
        if settings.push_enabled:
            PusherManager().push("盘前关注", record["content"])
    except Exception as exc:
        logger.exception("盘前简报失败: %s", exc)


def _post_brief_job() -> None:
    if not quotes.is_trading_day(quotes.latest_trade_date()):
        return
    try:
        record = briefs.generate("post", manual=True)
        if settings.push_enabled:
            PusherManager().push("盘后复盘", record["content"])
    except Exception as exc:
        logger.exception("盘后复盘失败: %s", exc)


def _cron_from(time_str: str) -> CronTrigger:
    hour, minute = (int(x) for x in time_str.split(":"))
    return CronTrigger(hour=hour, minute=minute, timezone=ZoneInfo(settings.timezone))


def start_scheduler() -> BackgroundScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    sched = BackgroundScheduler(timezone=ZoneInfo(settings.timezone))
    if settings.schedule_enabled:
        sched.add_job(_poll_job, IntervalTrigger(seconds=settings.poll_interval),
                      id="watch-poll", max_instances=2, coalesce=True)
        if settings.news_enabled:
            sched.add_job(_news_job, IntervalTrigger(minutes=settings.news_interval_min),
                          id="news-express", max_instances=1, coalesce=True)
        if settings.pre_brief_enabled:
            sched.add_job(_pre_brief_job, _cron_from(settings.pre_brief_time),
                          id="pre-brief", max_instances=1, coalesce=True)
        if settings.post_brief_enabled:
            sched.add_job(_post_brief_job, _cron_from(settings.post_brief_time),
                          id="post-brief", max_instances=1, coalesce=True)
        sched.start()
        logger.info("调度器已启动（poll=%ss news=%smin pre=%s post=%s）",
                    settings.poll_interval, settings.news_interval_min,
                    settings.pre_brief_time, settings.post_brief_time)
    else:
        logger.info("调度器未启动（MW_SCHEDULE_ENABLED=false）")
    _scheduler = sched
    return sched


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None


def status() -> dict:
    jobs = []
    if _scheduler is not None:
        for j in _scheduler.get_jobs():
            jobs.append({"id": j.id, "next_run": str(j.next_run_time) if j.next_run_time else None})
    return {
        "running": _scheduler is not None and _scheduler.running,
        "schedule_enabled": settings.schedule_enabled,
        "jobs": jobs,
    }
