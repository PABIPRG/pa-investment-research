# -*- coding: utf-8 -*-
"""industry-chain 配置：统一从模块根 .env 加载（前缀 IC_）。

核心为静态图谱数据模块（服务端口 + 种子数据目录）；研报管线另需 LLM 配置
（DEEPSEEK key 从 dsh-trading-core/.env 复制，仅本地 .env 保留真实值）。
import 时一次性加载 .env；宿主注入的环境变量始终优先。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent  # industry-chain/
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
        self.host = os.getenv("IC_HOST", "127.0.0.1")
        self.port = int(os.getenv("IC_PORT", "8200"))
        self.state_root = _investment_state_root()
        # Host 托管模式把全部生成数据写入同一后端状态根；独立源码启动
        # 仍保留项目内 data，并兼容开发者显式配置种子目录。
        if self.state_root is None:
            self.data_root = ROOT / "data"
            self.data_dir = Path(os.getenv("IC_DATA_DIR", str(self.data_root / "seed")))
        else:
            self.data_root = self.state_root / "data"
            self.data_dir = self.data_root / "seed"
        self.reports_dir = self.data_root / "reports"
        self.state_dir = self.state_root / "state" if self.state_root is not None else ROOT
        self.user_config_dir = self.state_root / "user-config" if self.state_root is not None else ROOT / "config"
        self.cache_dir = self.state_root / "cache" if self.state_root is not None else self.data_root / "cache"
        self.logs_dir = self.state_root / "logs" if self.state_root is not None else ROOT / "logs"
        # fetch_seed_data.py 下载源
        self.seed_base_url = os.getenv(
            "IC_SEED_BASE_URL", "https://villadora.github.io/iducsite/data"
        )
        # 研报管线 LLM（DeepSeek；key 从 dsh-trading-core/.env 复制到本地 .env）
        self.deepseek_api_key = os.getenv("IC_DEEPSEEK_API_KEY", "")
        self.deepseek_base_url = os.getenv("IC_DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        self.llm_model = os.getenv("IC_LLM_MODEL", "deepseek-chat")


settings = Settings()
