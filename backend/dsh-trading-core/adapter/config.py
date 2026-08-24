# -*- coding: utf-8 -*-
"""适配器配置：统一从项目根 .env 加载。

优先级（从高到低）：shell 显式传入的环境变量 > .env 文件值 > 代码默认值。
  * start_all(.bat|.sh) 传 fake/engine 时会把 ADAPTER_RUNNER 注入子进程环境，
    必须让它优先于 .env 文件里的同名字段，所以 load_dotenv 用 override=False。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent  # TradingAgents-CN/
load_dotenv(ROOT / ".env", override=False)


def _investment_state_root() -> Path | None:
    raw = os.getenv("DSH_INVESTMENT_STATE_DIR", "").strip()
    if not raw:
        return None
    root = Path(raw)
    if not root.is_absolute():
        raise ValueError("DSH_INVESTMENT_STATE_DIR 必须是绝对路径")
    return root.resolve()


class Settings:
    def __init__(self) -> None:
        self.root = ROOT
        self.state_root = _investment_state_root()
        if self.state_root is None:
            self.data_dir = self.root / "data"
            self.cache_dir = self.root / "tradingagents" / "dataflows" / "data_cache"
            self.logs_dir = Path(os.getenv("TRADINGAGENTS_LOG_DIR", "./logs"))
            self.state_dir = self.root
            self.user_config_dir = self.root / "config"
        else:
            self.data_dir = self.state_root / "data"
            self.cache_dir = self.state_root / "cache"
            self.logs_dir = self.state_root / "logs"
            self.state_dir = self.state_root / "state"
            self.user_config_dir = self.state_root / "user-config"
        # 持仓数据源（功能3b）
        self.holdings_provider = os.getenv("HOLDINGS_PROVIDER", "manual")
        # 外部推送（功能4）
        self.push_enabled = os.getenv("BRIEF_PUSH_ENABLED", "false").lower() == "true"
        self.push_channels = [
            c.strip()
            for c in os.getenv("BRIEF_PUSH_CHANNELS", "").split(",")
            if c.strip()
        ]
        self.serverchan_sendkey = os.getenv("SERVERCHAN_SENDKEY", "")
        self.wecom_webhook_key = os.getenv("WECOM_WEBHOOK_KEY", "")
        # 定时调度（功能4）
        self.schedule_enabled = os.getenv("BRIEF_SCHEDULE_ENABLED", "false").lower() == "true"
        self.pre_market_time = os.getenv("BRIEF_PRE_MARKET_TIME", "08:50")
        self.post_market_time = os.getenv("BRIEF_POST_MARKET_TIME", "15:30")
        # 简报 LLM（openai 直连 DeepSeek，绕开 LangChain 层）
        self.llm_model = os.getenv("BRIEF_LLM_MODEL", "deepseek-chat")
        self.deepseek_api_key = os.getenv("DEEPSEEK_API_KEY", "")
        self.deepseek_base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")

    def llm_available(self) -> bool:
        return bool(self.deepseek_api_key)


settings = Settings()
