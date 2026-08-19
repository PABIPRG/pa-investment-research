# -*- coding: utf-8 -*-
"""盯盘模块配置：统一从模块根 .env 加载。

关键点：import 时一次性 load_dotenv(override=True)，把 NO_PROXY 注入环境，
任何 akshare 调用之前必须已 import 本模块（否则 eastmoney 直连被系统代理断掉）。
env 前缀用 MW_，与 trading-core 的 BRIEF_* 区分；推送凭据复用同名变量便于两模块共用。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent  # market-watch/
load_dotenv(ROOT / ".env", override=True)


def _true(name: str, default: bool = False) -> bool:
    return os.getenv(name, "true" if default else "false").lower() == "true"


class Settings:
    def __init__(self) -> None:
        self.root = ROOT
        # LLM（可选，触发解读 / 新闻摘要 / 盘前盘后简报）
        self.llm_enabled = _true("MW_LLM_ENABLED")
        self.llm_model = os.getenv("MW_LLM_MODEL", "deepseek-chat")
        self.deepseek_api_key = os.getenv("DEEPSEEK_API_KEY", "")
        self.deepseek_base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        # 外部推送（触发 / 新闻 / 简报）
        self.push_enabled = _true("MW_PUSH_ENABLED")
        self.push_channels = [
            c.strip()
            for c in os.getenv("MW_PUSH_CHANNELS", "").split(",")
            if c.strip()
        ]
        self.serverchan_sendkey = os.getenv("SERVERCHAN_SENDKEY", "")
        self.wecom_webhook_key = os.getenv("WECOM_WEBHOOK_KEY", "")
        # 调度
        self.schedule_enabled = _true("MW_SCHEDULE_ENABLED", default=True)
        self.poll_interval = int(os.getenv("MW_POLL_INTERVAL", "30"))
        # 行情数据
        # 快照是整市分页拉取（55+ 请求），TTL 太短会高频打爆东财 push2 被限流；60s 足够盯盘触发用
        self.quote_cache_ttl = float(os.getenv("MW_QUOTE_CACHE_TTL", "60"))
        self.fund_flow_ttl = float(os.getenv("MW_FUND_FLOW_TTL", "300"))
        self.fund_flow_enabled = _true("MW_FUND_FLOW", default=True)
        self.lookback_days = int(os.getenv("MW_LOOKBACK_DAYS", "120"))
        # 新闻速递
        self.news_enabled = _true("MW_NEWS_ENABLED")
        self.news_interval_min = int(os.getenv("MW_NEWS_INTERVAL_MIN", "60"))
        self.news_top = int(os.getenv("MW_NEWS_TOP", "8"))
        self.stock_news_top = int(os.getenv("MW_STOCK_NEWS_TOP", "3"))
        # 盘前/盘后简报
        self.pre_brief_enabled = _true("MW_PRE_BRIEF_ENABLED")
        self.pre_brief_time = os.getenv("MW_PRE_BRIEF_TIME", "08:50")
        self.post_brief_enabled = _true("MW_POST_BRIEF_ENABLED")
        self.post_brief_time = os.getenv("MW_POST_BRIEF_TIME", "15:30")
        # 时区
        self.timezone = os.getenv("TIMEZONE", "Asia/Shanghai")

    def llm_available(self) -> bool:
        return self.llm_enabled and bool(self.deepseek_api_key)


settings = Settings()
