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
        # 二期：事件→策略（事件源 + 影子验证）
        self.mw_url = os.getenv("MW_URL", "http://127.0.0.1:8100")
        self.event_cache_ttl = float(os.getenv("EVENT_CACHE_TTL", "60"))
        self.shadow_schedule_enabled = os.getenv("SHADOW_SCHEDULE_ENABLED", "false").lower() == "true"
        self.shadow_run_time = os.getenv("SHADOW_RUN_TIME", "15:30")
        self.shadow_initial_capital = float(os.getenv("SHADOW_INITIAL_CAPITAL", "100000"))
        # 三期：个性化右链（O 策略匹配 + D/P 资讯卡片 + R 行为捕获）
        self.personalized_limit = int(os.getenv("PERSONALIZED_LIMIT", "30"))
        self.personalized_behavior_cap = int(os.getenv("PERSONALIZED_BEHAVIOR_CAP", "500"))
        self.personalized_comment_enabled = os.getenv("PERSONALIZED_LLM_COMMENT", "true").lower() == "true"
        self.personalized_comment_ttl = float(os.getenv("PERSONALIZED_LLM_COMMENT_TTL", "1800"))
        # 四期：事件影响图谱 + 画像增强
        self.ic_url = os.getenv("IC_URL", "http://127.0.0.1:8200")          # 产业链图谱（C 扩展源）
        self.personalized_behavior_hours = float(os.getenv("PERSONALIZED_BEHAVIOR_HOURS", "168"))
        # 自进化闭环（S_shadow 替身 → T 归因 → W 升降级/变异 → W→H 回流）
        self.evolve_min_days = int(os.getenv("EVOLVE_MIN_DAYS", "5"))            # 影子净值≥N 日才动作
        self.evolve_promote_nav = float(os.getenv("EVOLVE_PROMOTE_NAV", "1.03"))  # nav≥ 升级线
        self.evolve_demote_nav = float(os.getenv("EVOLVE_DEMOTE_NAV", "0.95"))    # nav≤ 观察线（降级）
        self.evolve_retire_nav = float(os.getenv("EVOLVE_RETIRE_NAV", "0.90"))    # nav≤ 淘汰线
        self.evolve_retire_closed_win = float(os.getenv("EVOLVE_RETIRE_CLOSED_WIN", "0.35"))  # 平仓胜率< 淘汰
        self.evolve_mutate_branches = int(os.getenv("EVOLVE_MUTATE_BRANCHES", "2"))  # 每升级策略变异分支数
        self.evolve_mutate_cooldown_days = int(os.getenv("EVOLVE_MUTATE_COOLDOWN_DAYS", "7"))  # 父策略变异冷却

    def llm_available(self) -> bool:
        return bool(self.deepseek_api_key)


settings = Settings()
