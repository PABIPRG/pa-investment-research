# -*- coding: utf-8 -*-
"""industry-chain 配置：统一从模块根 .env 加载（前缀 IC_）。

核心为静态图谱数据模块（服务端口 + 种子数据目录）；研报管线另需 LLM 配置
（DEEPSEEK key 从 dsh-trading-core/.env 复制，仅本地 .env 保留真实值）。
import 时一次性 load_dotenv(override=True)，保证任何调用前环境变量就绪。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent  # industry-chain/
load_dotenv(ROOT / ".env", override=True)


class Settings:
    def __init__(self) -> None:
        self.root = ROOT
        self.host = os.getenv("IC_HOST", "127.0.0.1")
        self.port = int(os.getenv("IC_PORT", "8200"))
        # 种子数据目录（默认 data/seed）。懒加载，首次查询时读取。
        self.data_dir = Path(os.getenv("IC_DATA_DIR", str(ROOT / "data" / "seed")))
        # fetch_seed_data.py 下载源
        self.seed_base_url = os.getenv(
            "IC_SEED_BASE_URL", "https://villadora.github.io/iducsite/data"
        )
        # 研报管线 LLM（DeepSeek；key 从 dsh-trading-core/.env 复制到本地 .env）
        self.deepseek_api_key = os.getenv("IC_DEEPSEEK_API_KEY", "")
        self.deepseek_base_url = os.getenv("IC_DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        self.llm_model = os.getenv("IC_LLM_MODEL", "deepseek-chat")


settings = Settings()
