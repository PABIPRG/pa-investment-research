# -*- coding: utf-8 -*-
"""适配器配置：统一从项目根 .env 加载。

修现坑：适配器此前不 load_dotenv，DEEPSEEK 相关 key 能读到纯属 shell 恰好 export。
这里在 import 时一次性加载项目根 .env（override=True，以后出现者为准），
所有新配置项（推送/调度/持仓源/LLM）都从这里读，避免散落各处。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent  # TradingAgents-CN/
load_dotenv(ROOT / ".env", override=True)


class Settings:
    def __init__(self) -> None:
        self.root = ROOT
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
