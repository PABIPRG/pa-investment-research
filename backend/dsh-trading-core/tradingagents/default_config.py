import os

from adapter.config import settings as investment_settings

# 项目根目录（dsh-trading-core/）= default_config.py 所在目录的父目录
_PROJECT_ROOT = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))  # tradingagents/
_APP_ROOT = os.path.dirname(_PROJECT_ROOT)  # dsh-trading-core/

DEFAULT_CONFIG = {
    "project_dir": _PROJECT_ROOT,
    "results_dir": (
        str(investment_settings.state_dir / "results")
        if investment_settings.state_root is not None
        else os.getenv("TRADINGAGENTS_RESULTS_DIR", os.path.join(_APP_ROOT, "results"))
    ),
    "data_dir": str(investment_settings.data_dir),
    "data_cache_dir": str(investment_settings.cache_dir),
    "eval_results_dir": (
        str(investment_settings.state_dir / "eval_results")
        if investment_settings.state_root is not None
        else "eval_results"
    ),
    # LLM settings
    "llm_provider": "openai",
    "deep_think_llm": "o4-mini",
    "quick_think_llm": "gpt-4o-mini",
    "backend_url": "https://api.openai.com/v1",
    # Debate and discussion settings
    "max_debate_rounds": 1,
    "max_risk_discuss_rounds": 1,
    "max_recur_limit": 100,
    # Tool settings - 从环境变量读取，提供默认值
    "online_tools": os.getenv("ONLINE_TOOLS_ENABLED", "false").lower() == "true",
    "online_news": os.getenv("ONLINE_NEWS_ENABLED", "true").lower() == "true",
    "realtime_data": os.getenv("REALTIME_DATA_ENABLED", "false").lower() == "true",

    # Note: Database and cache configuration is now managed by .env file and config.database_manager
    # No database/cache settings in default config to avoid configuration conflicts
}
