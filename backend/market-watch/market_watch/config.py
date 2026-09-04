# -*- coding: utf-8 -*-
"""盯盘模块配置：统一从模块根 .env 加载。

关键点：import 时以进程环境优先的方式加载 .env；未配置 NO_PROXY 时补齐行情直连默认值。
任何 akshare 调用之前必须已 import 本模块（否则 eastmoney 直连被系统代理断掉）。
env 前缀用 MW_，与 trading-core 的 BRIEF_* 区分；推送凭据复用同名变量便于两模块共用。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent  # market-watch/
DEFAULT_NO_PROXY = "eastmoney.com,push2.eastmoney.com,82.push2.eastmoney.com,127.0.0.1,localhost"

# Profile/宿主注入的环境变量优先于独立启动时使用的项目 .env。
load_dotenv(ROOT / ".env", override=False)
# 没有部署方或 .env 指定 NO_PROXY 时，行情数据源仍默认直连。
os.environ.setdefault("NO_PROXY", DEFAULT_NO_PROXY)


def _investment_state_root() -> Path | None:
    raw = os.getenv("DSH_INVESTMENT_STATE_DIR", "").strip()
    if not raw:
        return None
    root = Path(raw)
    if not root.is_absolute():
        raise ValueError("DSH_INVESTMENT_STATE_DIR 必须是绝对路径")
    return root.resolve()


def _true(name: str, default: bool = False) -> bool:
    return os.getenv(name, "true" if default else "false").lower() == "true"


class Settings:
    def __init__(self) -> None:
        self.root = ROOT
        self.state_root = _investment_state_root()
        if self.state_root is None:
            self.data_dir = self.root / "data"
            self.cache_dir = self.root / "data" / "cache"
            self.logs_dir = self.root / "logs"
            self.state_dir = self.root
            self.user_config_dir = self.root / "config"
        else:
            self.data_dir = self.state_root / "data"
            self.cache_dir = self.state_root / "cache"
            self.logs_dir = self.state_root / "logs"
            self.state_dir = self.state_root / "state"
            self.user_config_dir = self.state_root / "user-config"
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
        self.scan_cache_ttl = float(os.getenv("MW_SCAN_CACHE_TTL", "15"))
        self.scan_stale_ttl = float(os.getenv("MW_SCAN_STALE_TTL", "300"))
        self.scan_cache_size = int(os.getenv("MW_SCAN_CACHE_SIZE", "64"))
        self.fund_flow_ttl = float(os.getenv("MW_FUND_FLOW_TTL", "300"))
        self.indices_stale_ttl = float(os.getenv("MW_INDICES_STALE_TTL", "300"))
        self.fund_flow_enabled = _true("MW_FUND_FLOW", default=True)
        self.lookback_days = int(os.getenv("MW_LOOKBACK_DAYS", "120"))
        # 新闻速递
        self.news_enabled = _true("MW_NEWS_ENABLED")
        self.news_interval_min = int(os.getenv("MW_NEWS_INTERVAL_MIN", "60"))
        self.news_top = int(os.getenv("MW_NEWS_TOP", "8"))
        self.stock_news_top = int(os.getenv("MW_STOCK_NEWS_TOP", "3"))
        self.stock_news_cache_ttl = float(os.getenv("MW_STOCK_NEWS_CACHE_TTL", "60"))
        self.stock_news_stale_ttl = float(os.getenv("MW_STOCK_NEWS_STALE_TTL", "300"))
        self.stock_news_cache_size = int(os.getenv("MW_STOCK_NEWS_CACHE_SIZE", "64"))
        self.flash_cache_ttl = float(os.getenv("MW_FLASH_CACHE_TTL", "15"))
        self.flash_stale_ttl = float(os.getenv("MW_FLASH_STALE_TTL", "300"))
        self.flash_first_paint_deadline = float(
            os.getenv("MW_FLASH_FIRST_PAINT_DEADLINE", "1.5")
        )
        self.flash_full_deadline = float(os.getenv("MW_FLASH_FULL_DEADLINE", "10"))
        self.flash_source_timeout = float(os.getenv("MW_FLASH_SOURCE_TIMEOUT", "2"))
        self.flash_source_workers = int(os.getenv("MW_FLASH_SOURCE_WORKERS", "8"))
        self.kline_cache_ttl = float(os.getenv("MW_KLINE_CACHE_TTL", "60"))
        self.kline_stale_ttl = float(os.getenv("MW_KLINE_STALE_TTL", "1800"))
        self.kline_cold_deadline = float(os.getenv("MW_KLINE_COLD_DEADLINE", "2.5"))
        self.kline_source_timeout = float(os.getenv("MW_KLINE_SOURCE_TIMEOUT", "2"))
        self.kline_baostock_timeout = float(os.getenv("MW_KLINE_BAOSTOCK_TIMEOUT", "2"))
        self.kline_refresh_workers = int(os.getenv("MW_KLINE_REFRESH_WORKERS", "4"))
        self.kline_failure_ttl = float(os.getenv("MW_KLINE_FAILURE_TTL", "30"))
        self.kline_failure_cache_size = int(os.getenv("MW_KLINE_FAILURE_CACHE_SIZE", "128"))
        self.kline_retry_after_ms = int(os.getenv("MW_KLINE_RETRY_AFTER_MS", "1500"))
        self.quote_name_deadline = float(os.getenv("MW_QUOTE_NAME_DEADLINE", "0.3"))
        self.quote_stale_ttl = float(os.getenv("MW_QUOTE_STALE_TTL", "300"))
        # 事件驱动（快讯 → 结构化事件 → 命中自选/持仓预警 → 个性化）
        self.event_enabled = _true("MW_EVENT_ENABLED", default=True)
        self.event_batch = int(os.getenv("MW_EVENT_BATCH", "15"))
        # 缓存 TTL 拉长：冷抽取（flash+LLM+定向）可达数十秒，trading-core 拉取超时仅 15s；
        # 60s 太短导致请求几乎每分钟撞一次冷抽取。事件改由后台 event-warm 线程按
        # event_warm_interval 周期续热（增量，无新快讯近零开销），TTL 因而可安全放宽。
        self.event_ttl = float(os.getenv("MW_EVENT_TTL", "300"))
        # 后台预热轮询间隔（秒）。远小于 event_ttl，保证 /news/events 恒命中缓存秒回。
        self.event_warm_interval = float(os.getenv("MW_EVENT_WARM_INTERVAL", "45"))
        self.trading_core_url = os.getenv("MW_TRADING_CORE", "http://127.0.0.1:8000")
        # 事件驱动 · 定向个股新闻（按持仓+自选逐只拉东财搜索，直标注 code，不走 LLM；频率受 event_ttl 限，无需独立 TTL）
        self.directed_news_enabled = _true("MW_DIRECTED_NEWS_ENABLED", default=True)
        self.directed_news_per_stock = int(os.getenv("MW_DIRECTED_NEWS_PER_STOCK", "3"))
        self.directed_news_workers = int(os.getenv("MW_DIRECTED_NEWS_WORKERS", "4"))
        self.directed_news_timeout = float(os.getenv("MW_DIRECTED_NEWS_TIMEOUT", "2"))
        # 一轮定向总预算：服务冷抽取时 flash/LLM 会并行抢占网络，3s 内 5 只常只完成 2-3 只；
        # 放宽到 8s 保证 5 只（≈2 波并发）都能在 budget 内完成，仍远小于 trading-core 15s deadline。
        self.directed_news_deadline = float(os.getenv("MW_DIRECTED_NEWS_DEADLINE", "8"))
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
