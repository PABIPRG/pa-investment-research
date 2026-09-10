# -*- coding: utf-8 -*-
"""适配器配置：统一加载环境变量、用户配置与项目 .env。

优先级（从高到低）：shell 显式传入的环境变量 > 用户 backend.env > 项目 .env > 代码默认值。
  * start_all(.bat|.sh) 传 fake/engine 时会把 ADAPTER_RUNNER 注入子进程环境，
    必须让它优先于配置文件里的同名字段，所以 load_dotenv 用 override=False。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent  # TradingAgents-CN/


def _investment_state_root() -> Path | None:
    raw = os.getenv("DSH_INVESTMENT_STATE_DIR", "").strip()
    if not raw:
        return None
    root = Path(raw)
    if not root.is_absolute():
        raise ValueError("DSH_INVESTMENT_STATE_DIR 必须是绝对路径")
    return root.resolve()


def _environment_files(state_root: Path | None) -> tuple[Path, Path]:
    """按从高到低的文件优先级返回用户配置和项目配置。"""
    user_config_dir = state_root / "user-config" if state_root is not None else ROOT / "config"
    return user_config_dir / "backend.env", ROOT / ".env"


def _load_environment(state_root: Path | None) -> None:
    """加载配置文件，同时保留进程环境和文件之间的优先级。"""
    for environment_file in _environment_files(state_root):
        load_dotenv(environment_file, override=False)


# 用户可写配置在打包版位于状态目录，在源码模式位于项目 config/backend.env。
# 先加载用户配置再加载项目 .env，配合 override=False 保持 shell > 用户 > 项目。
_user_state_root = _investment_state_root()
_load_environment(_user_state_root)


class Settings:
    def __init__(self) -> None:
        self.root = ROOT
        self.state_root = _user_state_root
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
        # easytrader CLI 接入（通达信/同花顺 GUI 自动化，零券商门槛）
        self.easytrader_broker = os.getenv("EASYTRADER_BROKER", "")  # 券商档案 id（broker_profiles.py），优先于 client_type
        self.easytrader_client_type = os.getenv("EASYTRADER_CLIENT_TYPE", "thstrader")  # thstrader | tdxtrader
        self.easytrader_client_path = os.getenv("EASYTRADER_CLIENT_PATH", "")
        # macOS：AppleScript 读同花顺 Mac 版持仓（见 holdings_providers/mac_ths.py）
        self.mac_ths_app_name = os.getenv("MAC_THS_APP_NAME", "")      # 空=默认「同花顺」
        self.mac_ths_timeout = float(os.getenv("MAC_THS_TIMEOUT", "60"))
        # QMT SDK 接入（迅投 miniQMT/xtquant，需券商开通，10万门槛）
        self.qmt_account_id = os.getenv("QMT_ACCOUNT_ID", "")
        self.qmt_session_id = int(os.getenv("QMT_SESSION_ID", "888888"))
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
        self.event_stale_ttl = float(os.getenv("EVENT_STALE_TTL", "900"))
        self.event_failure_backoff = float(os.getenv("EVENT_FAILURE_BACKOFF", "2"))
        self.risk_event_deadline = float(os.getenv("RISK_EVENT_DEADLINE", "0.35"))
        self.risk_portfolio_cache_ttl = float(os.getenv("RISK_PORTFOLIO_CACHE_TTL", "2"))
        self.shadow_schedule_enabled = os.getenv("SHADOW_SCHEDULE_ENABLED", "false").lower() == "true"
        self.shadow_run_time = os.getenv("SHADOW_RUN_TIME", "15:30")
        self.shadow_initial_capital = float(os.getenv("SHADOW_INITIAL_CAPITAL", "100000"))
        # 三期：个性化右链（O 策略匹配 + D/P 资讯卡片 + R 行为捕获）
        self.personalized_limit = int(os.getenv("PERSONALIZED_LIMIT", "30"))
        self.personalized_behavior_cap = int(os.getenv("PERSONALIZED_BEHAVIOR_CAP", "2000"))
        self.personalized_comment_enabled = os.getenv("PERSONALIZED_LLM_COMMENT", "true").lower() == "true"
        self.personalized_comment_ttl = float(os.getenv("PERSONALIZED_LLM_COMMENT_TTL", "1800"))
        # 四期：事件影响图谱 + 画像增强
        self.ic_url = os.getenv("IC_URL", "http://127.0.0.1:8200")          # 产业链图谱（C 扩展源）
        self.personalized_behavior_hours = float(os.getenv("PERSONALIZED_BEHAVIOR_HOURS", "168"))
        self.local_learning_retention_days = int(os.getenv("LOCAL_LEARNING_RETENTION_DAYS", "90"))
        self.local_learning_event_cap = int(os.getenv("LOCAL_LEARNING_EVENT_CAP", "2000"))
        # 自进化闭环（S_shadow 替身 → T 归因 → W 升降级/变异 → W→H 回流）
        self.evolve_min_days = int(os.getenv("EVOLVE_MIN_DAYS", "5"))            # 影子净值≥N 日才动作
        self.evolve_promote_nav = float(os.getenv("EVOLVE_PROMOTE_NAV", "1.03"))  # nav≥ 升级线
        self.evolve_demote_nav = float(os.getenv("EVOLVE_DEMOTE_NAV", "0.95"))    # nav≤ 观察线（降级）
        self.evolve_retire_nav = float(os.getenv("EVOLVE_RETIRE_NAV", "0.90"))    # nav≤ 淘汰线
        self.evolve_retire_closed_win = float(os.getenv("EVOLVE_RETIRE_CLOSED_WIN", "0.35"))  # 平仓胜率< 淘汰
        self.evolve_mutate_branches = int(os.getenv("EVOLVE_MUTATE_BRANCHES", "2"))  # 每升级策略变异分支数
        self.evolve_mutate_cooldown_days = int(os.getenv("EVOLVE_MUTATE_COOLDOWN_DAYS", "7"))  # 父策略变异冷却
        # 全自动闭环（每日 shadow → 自动进化 → 衍生候选自动回测激活 → 推送）
        self.closed_loop_enabled = os.getenv("CLOSED_LOOP_ENABLED", "false").lower() == "true"
        self.closed_loop_time = os.getenv("CLOSED_LOOP_TIME", "15:35")          # 闭环每日时刻（收盘后）
        self.candidate_auto_reject = os.getenv("CANDIDATE_AUTO_REJECT", "true").lower() == "true"
        # 闭环 Step 0：拉事件 → 生成新策略候选（并入闭环，幂等 md5 去重）
        self.event_generation_enabled = os.getenv("EVENT_GENERATION_ENABLED", "true").lower() == "true"
        self.event_generation_limit = int(os.getenv("EVENT_GENERATION_LIMIT", "20"))
        # 自动回测（首测 + 15 天复测巡检；候选/生效策略统一进回测任务历史，复测不改生命周期）
        self.auto_retest_enabled = os.getenv("AUTO_RETEST_ENABLED", "false").lower() == "true"
        self.auto_retest_time = os.getenv("AUTO_RETEST_TIME", "15:40")  # 巡检每日时刻（收盘后）
        self.auto_retest_interval_days = int(os.getenv("AUTO_RETEST_INTERVAL_DAYS", "15"))  # 复测间隔天
        self.auto_backtest_lookback_years = float(os.getenv("AUTO_BACKTEST_LOOKBACK_YEARS", "2.0"))
        # 自进化 v2 · 扩展证据持久化（P0.4）：per_symbol IS/OOS 总是存；每日组合净值曲线受开关与保留窗口约束
        self.evolve_persist_curve = os.getenv("EVOLVE_PERSIST_CURVE", "true").lower() == "true"
        self.evolve_curve_keep_days = int(os.getenv("EVOLVE_CURVE_KEEP_DAYS", "400"))  # 每日曲线保留近 N 日
        # 自进化 v2 · 最小 regime 检测器（P0.5）：每日算并落 market_regime
        self.regime_enabled = os.getenv("REGIME_ENABLED", "true").lower() == "true"
        self.regime_gate_enabled = os.getenv("REGIME_GATE_ENABLED", "false").lower() == "true"  # P5 前默认不 gate
        self.regime_index = os.getenv("REGIME_INDEX", "sh.000300")  # 主 regime 基准代码
        self.regime_ma_fast = int(os.getenv("REGIME_MA_FAST", "20"))
        self.regime_ma_slow = int(os.getenv("REGIME_MA_SLOW", "60"))
        self.regime_vol_window = int(os.getenv("REGIME_VOL_WINDOW", "20"))
        self.regime_high_vol_ratio = float(os.getenv("REGIME_HIGH_VOL_RATIO", "1.5"))  # 波动 > 中位×ratio 判 high_vol
        self.regime_trend_dist_pct = float(os.getenv("REGIME_TREND_DIST_PCT", "0.02"))  # |价/MA_slow-1|≥ 判趋势
        # 自进化 v2 · 事件账本/标的池（P0.2）与基因存档（P0.6）的容量边界
        self.events_ledger_cap = int(os.getenv("EVENTS_LEDGER_CAP", "3000"))
        self.symbol_pool_max_symbols = int(os.getenv("SYMBOL_POOL_MAX_SYMBOLS", "30"))
        # 自进化 v2 · 多维适应度（P1）：判「本事 vs 行情」。维度默认只**记档**不改裁决；
        # 只有当 EVOLVE_FITNESS_MODE 设为 relative/excess 时才把新判据接入升/降/汰。
        self.evolve_fitness_mode = os.getenv("EVOLVE_FITNESS_MODE", "log").lower()  # log|relative|excess
        self.evolve_relative_min_peers = int(os.getenv("EVOLVE_RELATIVE_MIN_PEERS", "3"))  # 同批≥N 策略才算分位
        self.evolve_promote_percentile = float(os.getenv("EVOLVE_PROMOTE_PERCENTILE", "80.0"))  # 同批净值分位≥ 升级
        self.evolve_retire_percentile = float(os.getenv("EVOLVE_RETIRE_PERCENTILE", "20.0"))    # 同批分位≤ 观察线
        self.evolve_excess_lookback_days = int(os.getenv("EVOLVE_EXCESS_LOOKBACK_DAYS", "20"))
        self.evolve_overfit_gap_pct = float(os.getenv("EVOLVE_OVERFIT_GAP_PCT", "25.0"))  # IS胜率 − OOS胜率 ≥ 视为过拟合
        self.evolve_overfit_min_trades = int(os.getenv("EVOLVE_OVERFIT_MIN_TRADES", "4"))  # OOS 至少 N 笔才判 overfit
        # 自进化 v2 · 基因座开放（P2）：生态位族内换 kind + 跨同类事件池换标的。
        # 默认开；如需回 v1 的纯参数微扰（变异不换 kind），设 EVOLVE_MIGRATION_ENABLED=false。
        # 开启后从第 EVOLVE_MIGRATE_FROM_BRANCH 条变异分支起尝试迁移。
        self.evolve_migration_enabled = os.getenv("EVOLVE_MIGRATION_ENABLED", "true").lower() == "true"
        self.evolve_migrate_from_branch = int(os.getenv("EVOLVE_MIGRATE_FROM_BRANCH", "1"))
        self.evolve_pool_max_new_symbols = int(os.getenv("EVOLVE_POOL_MAX_NEW_SYMBOLS", "3"))  # 跨池最多引入新标的数
        # 自进化 v2 · 有性繁殖 + 归因引导有向变异（P3），默认开（关闭 crossover 设 EVOLVE_RECOMBINE_ENABLED=false）。
        # crossover：当同一裁决批里有 ≥EVOLVE_RECOMBINE_MIN_PARENTS 条升入 promote 的高 fitness 亲本，
        # 取 A 因子结构 × B 标的池重组成一条带双亲谱系子代（factor×symbols 重组，互补寻优）。
        self.evolve_recombine_enabled = os.getenv("EVOLVE_RECOMBINE_ENABLED", "true").lower() == "true"
        self.evolve_recombine_min_parents = int(os.getenv("EVOLVE_RECOMBINE_MIN_PARENTS", "2"))
        # 归因引导有向变异：变异前用 per-symbol 证据（影子平仓/扩展证据）换掉最差的
        # EVOLVE_GUIDED_PRUNE_WORST 只拖累票，朝已证有效方向走而非盲摇骰子。
        self.evolve_guided_prune_enabled = os.getenv("EVOLVE_GUIDED_PRUNE_ENABLED", "true").lower() == "true"
        self.evolve_guided_prune_worst = int(os.getenv("EVOLVE_GUIDED_PRUNE_WORST", "1"))
        # 自进化 v2 · 种群治理（P4），默认开；对应子项可单独设 false 关闭回到 v1。
        # 生态位+相关性去重：变异子代入池前，与同生态位 active 影子净值序列相关
        # ≥EVOLVE_CORRELATION_MAX 且不比在位的优 → 拒入（堵克隆膨胀）。
        self.evolve_correlation_enabled = os.getenv("EVOLVE_CORRELATION_ENABLED", "true").lower() == "true"
        self.evolve_correlation_max = float(os.getenv("EVOLVE_CORRELATION_MAX", "0.80"))
        # 停滞退役：active 连续 EVOLVE_STAGNANT_DAYS 天未刷新影子净值新高 → 平庸让位。
        self.evolve_stagnant_enabled = os.getenv("EVOLVE_STAGNANT_ENABLED", "true").lower() == "true"
        self.evolve_stagnant_days = int(os.getenv("EVOLVE_STAGNANT_DAYS", "10"))
        # 基因存档与复活：退役时进 gene_archive（带存活期 regime 画像/fitness）；
        # 当 market/regime 切回其擅长档时从存档召回复测。
        self.evolve_archive_enabled = os.getenv("EVOLVE_ARCHIVE_ENABLED", "true").lower() == "true"
        self.evolve_revive_enabled = os.getenv("EVOLVE_REVIVE_ENABLED", "false").lower() == "true"
        # 自进化 v2 · 运行时自适应·冬眠（P5）。默认开：当日 market/regime 不在策略 gate.allow
        # 内时，该策略走 skipped「冬眠」语义（不产生新信号、不落当日净值点），把「环境不配合」
        # 与「能力不行」分开，防误降/误汰。设 EVOLVE_HIBERNATE_ENABLED=false 即影子不按 regime 过滤、回到 v1。
        self.evolve_hibernate_enabled = os.getenv("EVOLVE_HIBERNATE_ENABLED", "true").lower() == "true"
        # 自进化 v2 · 进化反馈到上游·假设生成先验（P6）。默认开：generate_hypotheses 会把
        # 「方向×因子族的样本外过验统计」作为一段先验附在 _HYPOTHESIS_SYSTEM 里，让假设生成
        # 倾向与下游筛选协同。设 PRIOR_REPLAY_ENABLED=false 即系统提示不带先验、输出回到 v1。
        self.prior_replay_enabled = os.getenv("PRIOR_REPLAY_ENABLED", "true").lower() == "true"
        self.evolve_prior_min_trials = int(os.getenv("EVOLVE_PRIOR_MIN_TRIALS", "3"))
        self.evolve_prior_max_lines = int(os.getenv("EVOLVE_PRIOR_MAX_LINES", "8"))

    def llm_available(self) -> bool:
        return bool(self.deepseek_api_key)


settings = Settings()
