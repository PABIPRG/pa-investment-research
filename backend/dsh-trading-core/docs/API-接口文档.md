# dsh-trading-core · 适配器 API 接口文档

> 面向：后端联调 / 前端桥接层开发者 / 部署运维。
> 本文档描述 **Python 适配器（FastAPI，`adapter/app.py`）** 暴露的全部 HTTP 接口。
> 版本：适配器 0.1.0 · 覆盖代码当前实现（**46 个端点**）。

---

## 1. 总体说明

### 1.1 架构与接口类型

```
前端 UI / dsh 插件 / product/（任何 HTTP 客户端）
        │  HTTP + SSE
        ▼
   FastAPI 适配器  (127.0.0.1:8000)
        ├─ 任务式接口：POST /analyze、/holdings/analyze、/brief、
        │     /backtest/run、/strategies/run、/shadow/run
        │     → 返回 task_id → 轮询 /analyze/{id} 或 订阅 SSE /analyze/{id}/stream
        ├─ 同步慢接口：POST /strategies/hypothesize（LLM 阻塞 10-30s）
        └─ 轻量接口：watchlist / risk_profile / kyc / holdings / brief/latest /
              strategies / shadow / backtest / reports 查询 / health
              → 同步请求/响应，秒级返回
        │
        ▼
   TradingAgents-CN 引擎 / 回测引擎 / 策略回测 / 影子验证
      （ThreadPoolExecutor worker 线程，同步阻塞；回测/策略/影子为纯逻辑）
```

| 类型 | 端点 | 特点 |
|---|---|---|
| 任务式 | `/analyze`、`/holdings/analyze`、`/brief` | 异步长任务（单股分析 3–9 分钟），先拿 `task_id`，再轮询或订阅 SSE |
| 任务式 | `/backtest/run`、`/strategies/run`、`/shadow/run` | 异步任务（分钟级），同一套 `task_id` + SSE 协议 |
| 同步慢 | `/strategies/hypothesize` | 普通 HTTP（LLM 生成假设，10–30s），直接返回结果；不要设短超时 |
| 轻量 | `/watchlist`、`/risk_profile`、`/kyc/*`、`/holdings`、`/holdings/save`、`/brief/latest`、`/strategies*`、`/shadow/*`、`/backtest/*`、`/reports*`、`/health` | 同步短请求，直接返回结果 |
| 流式 | `/analyze/{id}/stream` | SSE 进度流（六类任务共用），事件见 §5.3 |

> **fake 模式**（`ADAPTER_RUNNER=fake`）：`stock/holdings/brief` 三个 runner 换成假实现，但
> **`backtest`/`strategy`/`shadow` 三个 runner 走真实逻辑**（纯 pandas + baostock，无 LLM），
> 用于链路自测仍需要行情可达。

### 1.2 通用约定

- **Base URL**：`http://127.0.0.1:8000`（可通过 `--host` / `--port` 修改；插件 `adapterBaseUrl` 配置指向它）
- **请求体**：`application/json`（Pydantic 校验，字段缺失/非法返回 `422`）
- **响应体**：`application/json`（中文已 `ensure_ascii=False`，UTF-8）
- **CORS**：`allow_origins=["*"]`，浏览器跨域可直接调用
- **错误格式**：FastAPI 标准错误 `{"detail": "..."}`；自定义错误码见下表
- **认证**：当前无鉴权（仅绑定 127.0.0.1 默认；对外部署需自行加反向代理/网关）
- **任务状态**：任务全部保存在**适配器进程内存**中（`TaskManager`），**进程重启后任务丢失**；成功任务中的非空报告正文另行持久化，重启后仍可由 `/reports` 查询

### 1.3 错误码速查

| 状态码 | 场景 |
|---|---|
| 200 | 成功 |
| 404 | 任务不存在 / 策略不存在 / 简报或报告记录缺失 |
| 409 | `GET /analyze/{id}/result` 任务尚未完成；`POST /kyc/adjust` 尚未完成风险问卷 |
| 422 | 请求体校验失败（字段缺失、非法枚举；`/kyc/questionnaire` 缺题/分数非法；`/kyc/parse` 空文本） |
| 500 | 引擎异常（已由 `TaskManager` 捕获，任务标记 `failed`，SSE 会推 `error` 事件） |

> 策略假设生成 `/strategies/hypothesize` 在事件源不可用时返回**空候选**（`200` + `note`），不是 500。

### 1.4 风险偏好（risk_profile）贯穿所有任务

`conservative`（保守）/ `balanced`（稳健，默认）/ `aggressive`（进取）。
解析优先级：**请求参数 `risk_profile` > 已保存偏好（store）> `.env RISK_PROFILE` > `balanced`**。

二期起 risk_profile 的**唯一写入入口是 KYC 流程**（§4.8–4.11）：问卷推断 / 滑块微调后落盘
`preferences.risk_profile`，下游引擎基调 / 持仓预算 / 简报过滤照旧读取它。引擎决策还会被
"风险偏好护栏"修正（`calibration` / `calibration_note` 字段标注是否被校准）。

---

## 2. 端点总表

| # | 方法 | 路径 | 说明 | 类型 |
|---|---|---|---|---|
| 1 | GET | `/health` | 健康检查 + 六类 runner 列表 | 轻量 |
| 2 | POST | `/analyze` | 启动**个股多智能体分析** | 任务式 |
| 3 | POST | `/holdings/analyze` | 启动**持仓风险分析** | 任务式 |
| 4 | POST | `/holdings/save` | 保存/整体替换持仓 | 轻量 |
| 5 | GET | `/holdings` | 读取持仓列表（供盯盘/事件命中预警） | 轻量 |
| 6 | GET | `/watchlist` | 读取自选列表 | 轻量 |
| 7 | POST | `/watchlist` | 整体替换自选列表 | 轻量 |
| 8 | GET | `/risk_profile` | 读取风险偏好 | 轻量 |
| 9 | POST | `/risk_profile` | 保存全局风险偏好 | 轻量 |
| 10 | GET | `/kyc/profile` | KYC 现状 + 题组 schema + 阈值（前端唯一事实源） | 轻量 |
| 11 | POST | `/kyc/questionnaire` | 提交问卷 → 计分 → 推断画像写入 risk_profile | 轻量 |
| 12 | POST | `/kyc/adjust` | 滑块微调已推断画像 | 轻量 |
| 13 | POST | `/kyc/parse` | 自然语言/语音转写 → 结构化问卷答案 | 轻量 |
| 14 | POST | `/brief` | 启动**市场简报生成** | 任务式 |
| 15 | GET | `/brief/latest` | 最近一份简报（dsh 播报去重） | 轻量 |
| 16 | POST | `/brief/{id}/dsh-pushed` | 标记简报已播报（幂等） | 轻量 |
| 17 | POST | `/backtest/run` | 启动**历史决策前瞻回测** | 任务式 |
| 18 | GET | `/backtest/results` | 最近的回测运行记录 | 轻量 |
| 19 | GET | `/backtest/performance` | 从 `decisions.eval_meta` 重算整体表现（`?code=`） | 轻量 |
| 20 | GET | `/backtest/performance/{code}` | 单只股票的整体表现（同上重算） | 轻量 |
| 21 | POST | `/strategies/hypothesize` | 事件 → 投资假设 → 候选入库（同步慢接口） | 同步慢 |
| 22 | POST | `/strategies/run` | 启动候选策略**历史+样本外回测** | 任务式 |
| 23 | GET | `/strategies` | 策略池列表 | 轻量 |
| 24 | GET | `/strategies/{sid}` | 单条策略详情（含 backtest） | 轻量 |
| 25 | POST | `/strategies/{sid}/{action}` | 手动状态迁移 activate/reject/retire | 轻量 |
| 26 | POST | `/shadow/run` | 启动**实时影子验证**（paper trading 记账） | 任务式 |
| 27 | GET | `/shadow/status` | 最近一次影子运行汇总 | 轻量 |
| 28 | GET | `/shadow/positions` | 影子账户当前持仓（`?strategy_id=`） | 轻量 |
| 29 | GET | `/shadow/equity` | 影子净值历史（`?strategy_id=&limit=`） | 轻量 |
| 30 | GET | `/analyze/{task_id}/stream` | **SSE 进度流**（六类任务共用） | 流式 |
| 31 | GET | `/analyze/{task_id}/result` | 最终结果（未完成 409） | 查询 |
| 32 | GET | `/analyze/{task_id}` | 任务状态查询 | 查询 |
| 33 | GET | `/personalized/matches` | **O 策略—用户匹配**：active 策略 × 画像推荐（含行为激进度 + N→O 分散化修正） | 轻量 |
| 34 | GET | `/personalized/cards` | **D+P 个性化资讯卡片 feed**（分桶 + relevance 排序 + C 影响 + V→D 反馈归因） | 轻量 |
| 35 | POST | `/personalized/interactions` | **R 行为捕获**：view/click 阅读埋点 | 轻量 |
| 36 | GET | `/personalized/interactions` | 最近行为记录（时间倒序） | 轻量 |
| 37 | GET | `/personalized/impact` | **C 调试**：事件影响图谱扩展结果（impact_codes/impact_by） | 轻量 |
| 38 | GET | `/personalized/profile` | **K 画像增强**：基础画像 + 行为推断（含行业/关注/交易/反馈维度） | 轻量 |
| 39 | GET | `/risk/portfolio` | **N 组合风险模型**：等权集中度/单股权重 + 影子回撤波动 vs 预算 | 轻量 |
| 40 | GET | `/risk/alerts` | **Q 风险预警中心**：四源聚合 + R→V 效果归因（反馈计数/灵敏度校准） | 轻量 |
| 41 | POST | `/personalized/feedback` | **P→R 显式反馈**：卡片/预警 有用/没用（供画像修正与效果归因） | 轻量 |
| 42 | GET | `/evolution/status` | **自进化闭环状态**：影子数据是否就绪 + 策略生命周期统计 | 轻量 |
| 43 | GET | `/evolution/attribution` | **S→T 归因**：影子组合整体 + 每策略 收益/回撤/平仓胜率（只读） | 轻量 |
| 44 | POST | `/evolution/run` | **T→W→H 进化**：升降级/淘汰 + 参数变异回流（apply=false 预览 / true 写库） | 轻量 |
| 45 | GET | `/reports` | 持久化报告摘要列表（`?limit=&task_type=`） | 轻量 |
| 46 | GET | `/reports/{report_id}` | 持久化报告完整详情 | 轻量 |

---

## 3. 任务式接口

> 三步调用范式（六类任务一致）：
> 1. **启动**：POST 对应端点 → `{ "task_id": "..." }`
> 2. **订阅进度**：GET `/analyze/{task_id}/stream`（SSE）或轮询 GET `/analyze/{task_id}`
> 3. **取结果**：SSE 的 `result` 事件里自带最终结果；或任务 `done` 后 GET `/analyze/{task_id}/result`
>
> `task_type` 取值：`stock` / `holdings` / `brief` / `backtest` / `strategy` / `shadow`。

### 3.1 POST /analyze —— 个股分析

**请求体（AnalyzeRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ticker` | string | ✅ | 股票代码（`600519`）或名称（`贵州茅台`） |
| `date` | string | | 分析日期 `YYYY-MM-DD`，默认最近交易日 |
| `market` | string | | 市场，默认 `a_shares`（按代码自动识别） |
| `research_depth` | enum | | `quick` / `basic` / `standard` / `deep` / `full`，默认 `standard` |
| `config_overrides` | object | | 会话级引擎参数覆盖（如 `{"max_debate_rounds": 3}`） |
| `risk_profile` | enum | | `conservative` / `balanced` / `aggressive`，缺省用已保存偏好 |

```jsonc
// 请求
POST /analyze
{
  "ticker": "600519",
  "research_depth": "standard",
  "risk_profile": "balanced"
}
// 响应 200
{ "task_id": "3f9a2b8c1d0e4f5a6b7c8d9e" }
```

**深度映射到引擎参数**（`engine_bridge.RESEARCH_DEPTH_MAP`）：

| depth | 分析师 | max_debate_rounds | max_risk_discuss_rounds | online_news | agent 节点预算 |
|---|---|---|---|---|---|
| quick | 市场 | 1 | 1 | false | 9 |
| basic | 市场、基本面 | 1 | 1 | false | 10 |
| standard | 市场、社媒、新闻、基本面 | 1 | 1 | false | 12 |
| deep | 市场、社媒、新闻、基本面 | 2 | 2 | false | 17 |
| full | 市场、社媒、新闻、基本面 | 3 | 3 | true | 22 |

adapter 分析固定关闭 TradingAgentsGraph memory，跨次记忆仍由 dsh 会话层持有；该路径不初始化 Chroma memory，不发起 memory embedding 请求。

**最终结果结构**（SSE `result` 事件 或 `GET /analyze/{id}/result`）：

```jsonc
{
  "signal": {
    "signal_type": "final",
    "ticker": "600519",
    "company_name": "贵州茅台",
    "action": "买入 | 持有 | 卖出",          // 风险偏好护栏可能把 买入/卖出 校准为 持有
    "target_price": 1560.0,
    "confidence": 0.75,
    "risk_score": 0.4,
    "reasoning": "……",
    "model_info": "……",                     // 可选
    "risk_profile": "balanced",
    "calibration": false,                   // 是否被护栏修正
    "calibration_note": null                // 修正说明（校准后非空）
  },
  "reports": {                              // 分步 Markdown 报告，按阶段出现
    "market": "# …", "fundamentals": "# …", "news": "# …",
    "sentiment": "# …", "debate": "# …", "trader": "# …", "risk": "# …"
  },
  "performance_metrics": {}                 // 各节点耗时统计
}
```

> 引擎阶段顺序：市场分析 → 基本面 → 新闻 → 情绪 → 多空辩论 → 交易员 → 风险辩论 → 决策。
> 单股分析典型耗时 **3–9 分钟**（LLM 调用），SSE 超时建议给足（插件默认 600s）。

### 3.2 POST /holdings/analyze —— 持仓风险分析

**请求体（HoldingsRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `holdings` | array | | `[{ticker, quantity, cost_price}]`，为空时回退已保存持仓 |
| `mode` | enum | | `quick`（仅定量，秒级）/ `deep`（逐股 `standard` 四分析师引擎，3–5 分钟），默认 `deep` |
| `use_saved` | boolean | | `holdings` 为空时是否用已保存持仓，默认 `true` |
| `risk_profile` | enum | | 同上 |

```jsonc
POST /holdings/analyze
{ "holdings": [{"ticker": "600519", "quantity": 200, "cost_price": 1480}], "mode": "deep" }
// 响应 200
{ "task_id": "…" }
```

**最终结果结构**（重点：`signal`）：

```jsonc
{
  "signal": {
    "signal_type": "portfolio",
    "holdings": [{ "ticker": "600519", "quantity": 200, "cost_price": 1480 }],
    "mode": "deep",
    "risk_profile": "balanced",
    "total_market_value": 312000.0,      // 总市值
    "total_cost": 296000.0,              // 总成本
    "floating_pnl": 16000.0,             // 浮动盈亏
    "floating_pnl_pct": 0.054,           // 浮盈比例
    "weighted_risk_score": 0.45,         // 加权风险分 0~1
    "portfolio_annualized_vol": 0.28,    // 组合年化波动率
    "concentration_hhi": 0.33,           // 集中度 HHI
    "sector_exposure": [{"industry": "食品饮料", "weight": 0.65}],
    "risk_breaches": [                   // 风险预算超限项
      { "indicator": "single_stock_weight", "label": "600519",
        "value": 0.65, "limit": 0.25, "excess": 0.40 }
    ],
    "rebalance_suggestions": ["建议减持 600519，使权重降至 25% 以内（当前 65.0%）"],
    "n_positions": 1,
    "per_stock": {
      "600519": {
        "name": "贵州茅台", "quantity": 200, "cost_price": 1480,
        "last_price": 1560, "market_value": 312000, "floating_pnl": 16000,
        "weight": 1.0, "annualized_vol": 0.32, "max_drawdown": 0.18,
        "beta": 0.9, "industry": "食品饮料",
        "risk_score": 0.4, "risk_level": "中",   // 低/中/高，按画像 bands
        "action": "持有", "confidence": 0.7, "reasoning": "……"
      }
    }
  },
  "reports": { "portfolio": "# 持仓风险分析报告\n…" },
  "performance_metrics": {}
}
```

> `risk_breaches` 的 `indicator` 枚举：`single_stock_weight` / `portfolio_vol` / `hhi` / `beta`。
> `risk_level` 计算：deep 用引擎 `risk_score`，quick 用年化波动率近似（`risk_profiles.risk_level_for`）。
> **数据源**：个股/指数历史行情走 baostock（带锁串行）；行业分类 best-effort（失败标 `"未知"`）。

### 3.3 POST /brief —— 市场简报

**请求体（BriefRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `period` | enum | | `pre_market`（盘前）/ `post_market`（盘后）/ `now`（盘中），默认 `now` |
| `scope` | string | | `market` / `industry` / `concept` / `news` / `watchlist` / `all`，默认 `all` |
| `tickers` | array | | 覆盖的自选股；缺省用已保存 watchlist |
| `risk_profile` | enum | | 同上 |

```jsonc
POST /brief
{ "period": "pre_market", "scope": "all" }
// 响应 200
{ "task_id": "…" }
```

**最终结果结构**：

```jsonc
{
  "signal": {
    "signal_type": "brief",
    "period": "pre_market",
    "trade_date": "2026-08-19",
    "summary": "# 盘前简报 · 2026-08-19\n## 市场概览\n…",   // Markdown 简报（LLM 或降级模板）
    "opportunities": [
      { "kind": "northbound", "risk_level": "低", "title": "北向资金净流入 21.3 亿" },
      { "kind": "watchlist_move", "risk_level": "中", "ticker": "600519", "title": "自选股600519大涨 +5.1%" }
    ],
    "risk_profile": "balanced"
  },
  "reports": { "brief": "# … 同上 summary" },
  "performance_metrics": {}
}
```

**机会点 `kind` 与风险等级**：

| kind | 中文 | 风险等级 |
|---|---|---|
| `northbound` | 北向资金异动 | 低 |
| `watchlist_move` | 自选股异动（±4%） | 中 |
| `sector` | 板块涨跌（前3/后3） | 中 |
| `news_event` | 资讯事件驱动 | 中 |
| `lhb` | 龙虎榜净买入（>1亿） | 高 |
| `market_heat` | 市场过热（涨停≥80） | 高 |
| `market_risk` | 风险释放（跌停≥30） | 高 |

> 按风险画像过滤：保守档只展示 ≤中 风险机会点；进取档高风险置顶。
> 简报生成后**落 store**（key = `{period}:{trade_date}`，幂等），并写入 `latest` 指针。
> **注意**：`/brief` 请**串行**调用（akshare 的 V8 并发会崩适配器）。
> LLM 不可用时自动降级为确定性模板（summary 末尾注明）。

### 3.4 POST /backtest/run —— 历史决策前瞻回测

对 `decisions` 结构化决策（+ `eval_results` 文本兜底）做**前瞻收益评估**：取每条决策
`trade_date` 后 `eval_window_days` 个交易日的前景日线，按 `stop_loss` / `take_profit` /
`neutral_band` 判定收益与方向准确率，最后 `compute_summary` 聚合。纯逻辑（baostock + pandas），无 LLM。

**请求体（BacktestRunRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | | 只回测该股票代码（如 `600519`） |
| `force` | boolean | | 强制重评估（忽略同版本同窗口的已评估缓存），默认 `false` |
| `eval_window_days` | int | | 评估窗口（入场后前景交易日数），1–120，默认 `10` |
| `min_age_days` | int | | 决策最小年龄（自然日），0–365，默认 `14`；`0`=不限制 |
| `analysis_date_from` / `analysis_date_to` | string | | 决策分析日期下界/上界 `YYYY-MM-DD` |
| `limit` | int | | 最多评估决策条数，1–2000，默认 `200` |
| `stop_loss_pct` | float | | 止损幅度（%），默认 `5.0` |
| `take_profit_pct` | float | | 止盈幅度（%），默认 `10.0` |
| `neutral_band_pct` | float | | 中性带（%），区间收益低于此视为方向中性，默认 `2.0` |

```jsonc
POST /backtest/run
{ "code": "600519", "eval_window_days": 10, "limit": 50 }
// 响应 200
{ "task_id": "…" }
```

**最终结果结构**：

```jsonc
{
  "summary": { … },                  // BacktestSummary（§6.5，compute_summary 输出）
  "results": [ … ],                  // 每条决策的评估行（BacktestItem，§6.6）
  "params": {                        // 请求参数回显（提交时实际生效值）
    "code": "600519", "force": false, "eval_window_days": 10,
    "min_age_days": 14, "analysis_date_from": null, "analysis_date_to": null,
    "limit": 50, "stop_loss_pct": 5.0, "take_profit_pct": 10.0, "neutral_band_pct": 2.0
  },
  "meta": { "engine_version": "v1", "created_at": "2026-08-24T07:00:00+00:00" }
}
```

> `results` 每行 `eval_status`：`evaluated`（完整评估）/ `insufficient_data`（前景窗口不足）/
> `fetch_failed`（baostock 拉取失败）。三种都会出现在 `results` 里，聚合时各自计数。
> 评估结果写回 `decisions` 记录的 `eval_meta`（幂等：同 `engine_version` + `eval_window_days` 已评估则跳过，
> 除非 `force`）。
> 任务耗时分钟级，SSE 逐条 `progress` 上报 `i/n`。

### 3.5 POST /strategies/run —— 策略历史+样本外回测

对策略池一条候选（§4.14 生成）做**规则信号回测**：拉前复权日线 → 内联指标（ma/rsi/momentum/breakout/bollinger/volume_breakout，
纯 pandas）→ 全序列先算信号（因果、无 look-ahead）→ 按 `oos_frac` 切样本内(70%)/样本外(30%) →
统一「bar t 信号 → bar t+1 开盘成交」状态机逐笔成交 → 样本内/外各聚合 + 合成组合等权净值曲线。

**请求体（StrategyRunRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `strategy_id` | string | ✅ | 策略 id（`strategies` 集合键，`strat-` 开头） |
| `lookback_years` | float | | 历史回看年数，0.5–10，默认 `2.0` |
| `oos_frac` | float | | 样本外比例，0–0.5，默认 `0.3` |
| `initial_capital` | float | | 回测初始资金；`0` = 用 `SHADOW_INITIAL_CAPITAL`（默认 100000） |
| `min_oos_trades` | int | | 样本外最低成交数，1–100，默认 `4`（不足保持 candidate） |

```jsonc
POST /strategies/run
{ "strategy_id": "strat-abc123def0", "lookback_years": 2.0 }
// 响应 200
{ "task_id": "…" }
```

**最终结果结构**：

```jsonc
{
  "strategy_id": "strat-abc123def0",
  "status": "active",                 // active | candidate | rejected | retired（退役保留）
  "backtest": {
    "in_sample": {
      …BacktestSummary…,             // compute_summary 副口径（胜率/方向准确率等）
      "portfolio": {                  // 组合等权净值主口径（自算，见下）
        "portfolio_return_pct": 12.34,
        "portfolio_max_drawdown_pct": -8.21,
        "portfolio_sharpe": 0.87
      }
    },
    "out_of_sample": { …同上… },
    "thresholds_pass": true,
    "reason": "样本外胜率/均收益达标",
    "ran_at": "2026-08-24 15:05:12",
    "per_symbol": {
      "600519": { "trades_in": 12, "trades_out": 5, "last_in_ret": 1.24, "last_out_ret": 2.10 },
      "000858": { "error": "无历史行情（baostock 空）" }   // 单标失败不整任务失败
    },
    "symbol_errors": { "000858": "无历史行情（baostock 空）" }
  },
  "symbol_errors": {}
}
```

**自动迁移阈值**（`status` 由回测结果决定）：

| 条件 | status | thresholds_pass |
|---|---|---|
| 样本外 `n_evaluated < min_oos_trades` | `candidate`（保持） | false（reason=`样本外成交不足`） |
| 样本外 `win_rate_pct ≥ 50` 且 `avg_simulated_return_pct > 0` | `active` | true |
| 其余 | `rejected` | false |

> `retired` 策略不会被回测擅自改回（退役优先）。
> 成交约定：**bar t 信号 → bar t+1 开盘成交**（无 look-ahead）；序列末尾仍持仓按最后收盘强平
> （`exit_reason="series_end"`）；系统只做多（利空事件强制 `rsi_reversal`/`bollinger` 超跌反弹）。
> 回测结果同时写回策略记录的 `backtest` 字段（§4.16 可查）。

### 3.6 POST /shadow/run —— 实时影子验证

对全部 `active` 策略（或指定一条）做 **paper-trading 记账**：每个 symbol 独立子账户等权，
重放 `track_from` 以来的历史确定当前持仓（确定性单一路径，天然幂等），按收盘 mark-to-market。

**请求体（ShadowRunRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `force` | boolean | | 强制重跑当日（忽略幂等），默认 `false` |
| `strategy_id` | string | | 只验证该策略；空 = 全部 active 策略 |

```jsonc
POST /shadow/run
{ }
// 响应 200
{ "task_id": "…" }
```

**最终结果结构**（SSE `result` / `GET /analyze/{id}/result`）：

```jsonc
// 正常运行
{
  "skipped": false,
  "trade_date": "2026-08-24",
  "strategies": {
    "strat-abc123def0": {
      "name": "利好·momentum·600519", "kind": "momentum",
      "symbols": ["600519"], "initial_capital": 100000,
      "equity": 100512.3, "nav": 1.005123,
      "track_from": "2026-08-22", "closed_count": 2,
      "per_symbol": {
        "600519": {
          "qty": 200, "entry_price": 1480.0, "entry_date": "2026-08-23",
          "avg_cost": 1480.0, "cash": 70400.0, "last_price": 1503.0,
          "equity": 100400.0, "signal_intent": 1
        }
      },
      "symbol_errors": {}
    }
  },
  "overall_nav": 1.005123,
  "strategy_errors": {}
}
// 幂等跳过（当日已跑且非 force）或无 active 策略
{ "skipped": true, "trade_date": "2026-08-24", "reason": "2026-08-24 已运行（force=true 可重跑）" }
```

> **激活不立即建仓**：策略首次被影子跟踪当日（`track_from`）不进仓，从次一 bar 起按信号状态机
> 自然进出；当日数据滞后时只 mark-to-market 不成交当天。
> 同日重复运行幂等返回 `skipped:true`；`force=true` 可重跑覆盖。

---

## 4. 轻量接口

### 4.1 GET /health —— 健康检查

```jsonc
// 200
{
  "service": "trading-core",
  "status": "ok",
  "runners": {
    "stock": "engine-runner",             // fake 模式为 fake
    "holdings": "holdings-analyzer",      // fake 模式为 fake-holdings
    "brief": "brief-engine",              // fake 模式为 fake-brief
    "backtest": "backtest",
    "strategy": "strategy-backtest",
    "shadow": "shadow-validator"
  }
}
```

> 六类 runner 恒在（回测/策略/影子在 fake 模式下也是真实实现）。runner 值随 `ADAPTER_RUNNER`
> 变化（stock/holdings/brief 三个）。

### 4.2 GET /holdings —— 读取持仓列表

```jsonc
// 200（name 恒为空串，消费方自行补名称，避免逐票打外部接口）
{ "items": [ { "ticker": "600519", "name": "", "quantity": 200, "cost_price": 1480 } ] }
```

> 供盯盘/事件模块（market-watch :8100）做持仓命中预警的数据源。

### 4.3 POST /holdings/save —— 保存持仓

```jsonc
POST /holdings/save
{ "holdings": [{"ticker": "600519", "quantity": 200, "cost_price": 1480}] }
// 200
{ "saved": 1 }
```

### 4.4 GET /watchlist —— 读取自选列表

```jsonc
// 200
{ "tickers": ["600519", "000858", "300750"] }
```

### 4.5 POST /watchlist —— 整体替换自选列表

```jsonc
POST /watchlist
{ "tickers": ["600519", "000858"] }
// 200
{ "saved": 2 }
```

### 4.6 GET /risk_profile —— 读取风险偏好

```jsonc
// 200
{ "risk_profile": "balanced", "label": "稳健型" }
```

### 4.7 POST /risk_profile —— 保存全局风险偏好

```jsonc
POST /risk_profile
{ "risk_profile": "aggressive" }
// 200
{ "risk_profile": "aggressive", "label": "进取型" }
```

### 4.8 GET /kyc/profile —— KYC 现状 + 题组 + 阈值

前端渲染 KYC 问卷的**唯一事实源**：返回当前状态、推断画像、题组 schema、档位区间与各档护栏。

```jsonc
// 200
{
  "status": "completed",                  // not_started | completed | adjusted
  "inferred_profile": "balanced",         // 问卷推断画像（不被滑块微调污染）
  "effective_profile": "balanced",        // 当前生效画像（risk_profile 现值）
  "effective_label": "稳健型",
  "score": 26,
  "answers": [ { "qid": "horizon", "label": "1-3年", "score": 3 } ],
  "manual_adjust": null,                  // 最近一次滑块微调 {risk_tolerance,horizon_years,note}
  "completed_at": "2026-08-24T07:00:00+00:00",
  "method": "questionnaire",              // questionnaire | voice
  "voice_source": null,
  "last_profile": "conservative",         // 本次变更前的画像（供 UI 展示"发生了什么变化"）
  "tiers": { "quick": ["horizon","loss_tolerance","goal"], "full": [ …8 题… ] },
  "question_bank": {
    "horizon": { "qid": "horizon", "title": "你计划持有这笔资金多久？",
      "options": [ { "label": "3个月以内", "score": 1 }, … ] }
  },
  "bands": {                              // full 档的档位区间
    "conservative": { "min": 1, "max": 18, "label": "保守型", "desc": "…" },
    "balanced":     { "min": 19, "max": 29, "label": "稳健型", "desc": "…" },
    "aggressive":   { "min": 30, "max": 40, "label": "进取型", "desc": "…" }
  },
  "profile_labels": { "conservative": "保守型", "balanced": "稳健型", "aggressive": "进取型" },
  "profiles_detail": { … }                // RISK_PROFILES：各档护栏/预算，供"该画像下生效的护栏"卡
}
```

### 4.9 POST /kyc/questionnaire —— 提交问卷

**请求体（KycQuestionnaireRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `answers` | array | ✅ | 覆盖该档全部题目的答案 `[{qid, label, score}]`，score 1–5 |
| `tier` | enum | ✅ | `quick`（3 题速测）/ `full`（8 题完整） |
| `method` | enum | | `questionnaire`（点选）/ `voice`（语音），默认 `questionnaire` |
| `voice_source` | string | | 语音作答时保存的原始转写文本 |

```jsonc
POST /kyc/questionnaire
{
  "answers": [
    { "qid": "horizon", "label": "1-3年", "score": 3 },
    { "qid": "loss_tolerance", "label": "10%左右", "score": 3 },
    { "qid": "goal", "label": "长期增值，追求市场平均回报", "score": 3 }
  ],
  "tier": "quick", "method": "questionnaire"
}
// 200
{
  "profile": "balanced",
  "label": "稳健型",
  "score": 9,                              // quick 满分 15（full 满分 40）
  "inferred_profile": "balanced",
  "mapping": { … }                          // 该 tier 的档位区间（bands）
}
// 422（缺题 / 分数非法 / 选项不在题组内）→ { "detail": "问卷缺少题目: loss_tolerance, goal" }
```

> 计分阈值按 tier 满分等比折算：full 保守 1–18 / 稳健 19–29 / 进取 30–40；quick（×0.375）1–7 / 8–11 / 12–15。
> 提交成功即**推断画像写入 `risk_profile`**（推断即生效），并清空此前的滑块微调覆盖层（重做问卷 = 重新推断）。

### 4.10 POST /kyc/adjust —— 滑块微调画像

**请求体（KycAdjustRequest）**：`risk_tolerance`（0–1，默认 0.5：0=保守 / 0.5=稳健 / 1=进取）、
`horizon_years`（1–10，默认 3，作辅助约束）、`note`（可选）。

```jsonc
POST /kyc/adjust
{ "risk_tolerance": 0.7, "horizon_years": 3, "note": "最近能承受更多波动" }
// 200
{ "profile": "aggressive", "label": "进取型",
  "manual_adjust": { "risk_tolerance": 0.7, "horizon_years": 3, "note": "最近能承受更多波动" } }
// 409（尚未完成问卷）
{ "detail": "尚未完成风险问卷，请先提交问卷再微调" }
```

> 微调在**推断画像之上**漂移后再次写入 `risk_profile`；`inferred_profile` 保持不变。
> 确定性逻辑：`round(2×risk_tolerance)` 取档；期限 <2 年最多到稳健、≥5 年至少稳健。

### 4.11 POST /kyc/parse —— 自然语言 → 结构化答案

```jsonc
POST /kyc/parse
{ "text": "我能接受 10% 左右的亏损，主要想稳健增值，持股周期一年到三年" }
// 200
{
  "answers": [
    { "qid": "loss_tolerance", "label": "10%左右", "score": 3 },
    { "qid": "goal", "label": "稳健增值，跑赢通胀即可", "score": 2 },
    { "qid": "horizon", "label": "1-3年", "score": 3 }
  ],
  "text": "我能接受 10% 左右的亏损，主要想稳健增值，持股周期一年到三年",
  "source": "llm"                          // llm | rules（关键词降级）
}
// 422（空文本）
{ "detail": "文本不能为空" }
```

> LLM 不可用 / 解析失败时关键词规则降级；无法从文本判断的题目省略（前端可让用户补答）。

### 4.12 GET /brief/latest —— 最近一份简报

```jsonc
// 已有简报
{
  "id": "pre_market:2026-08-19",
  "period": "pre_market",
  "trade_date": "2026-08-19",
  "summary": "# 盘前简报 …",
  "dsh_pushed": false
}
// 尚无简报（归一化为空串，供 dsh 插件 schema 校验；前端按"暂无简报"处理，非 404）
{ "id": "", "period": "", "trade_date": "", "summary": "", "dsh_pushed": false }
```

> 输出恒为 5 个字段（`additionalProperties:false` 且非空类型），供 `get_latest_brief` 插件直连。

### 4.13 POST /brief/{id}/dsh-pushed —— 标记已播报（幂等）

```jsonc
POST /brief/pre_market%3A2026-08-19/dsh-pushed
// 200
{ "id": "pre_market:2026-08-19", "dsh_pushed": true }
// 简报不存在 → 404 { "detail": "简报不存在" }
```

> `id` 需 URL 编码（含 `:` 与 `日期`）。用于"对话内播报去重"：播报成功后才标记，重启可重放。

### 4.14 POST /strategies/hypothesize —— 事件 → 假设 → 候选入库（同步慢接口）

从 market-watch（:8100）`GET /news/events` 拉结构化事件（HTTP，TTL 缓存），LLM 把每条
`direction∈{利好,利空}` 的事件转成一条可回测的技术规则策略假设，校验后落入 `strategies` 池
（`status=candidate`）。**同步返回，LLM 阻塞 10–30s，走线程池不卡事件循环**。

**请求体（HypothesizeRequest）**：`limit`（事件条数上限，1–100，默认 20）、`dry_run`
（true=只生成不落库，返回 `candidates: []` 供预览）。

```jsonc
POST /strategies/hypothesize
{ "limit": 20, "dry_run": false }
// 200（事件源可用）
{
  "n_events": 12,
  "hypotheses": [
    {
      "event_idx": 0,
      "symbols": ["600519", "000858"],
      "direction": "利好",
      "kind": "momentum",                    // ma_cross | rsi_reversal | momentum | breakout | bollinger | volume_breakout
      "params": { "n": 10 },                 // 各 kind 默认参数（见 §6.8）
      "rationale": "事件因果一句话……",
      "holding_window_days": 20
    }
  ],
  "candidates": ["strat-abc123def0"]         // 落库的候选 id（dry_run 时为 []）
}
// 200（事件源不可用，优雅降级不 500）
{ "candidates": [], "hypotheses": [], "note": "事件源暂无事件（market-watch 未开 / 无新事件）" }
```

> **规则约束**：利好 → `ma_cross`（趋势跟随）/ `momentum`（动量）/ `breakout`（通道突破）/ `volume_breakout`（放量突破）；
> 利空 → `rsi_reversal` 或 `bollinger`（超跌反弹，系统只做多）；北交所 4/8 开头、B 股 2/9 开头代码被剔除；无 6 位可交易码的事件不生成。
> LLM 不可用/失败 → 规则降级（利好 momentum / 利空 rsi_reversal，rationale=事件摘要）。
> 假设生成与候选入库走同一 `event_idx` 索引，校验失败的单条丢弃、其余继续。

### 4.15 GET /strategies —— 策略池列表

```jsonc
// 200（created_at 倒序，limit 1–200，默认 50）
{
  "count": 3,
  "items": [ …StrategyRecord… ]            // 结构见 §6.7
}
```

### 4.16 GET /strategies/{sid} —— 单条策略详情

```jsonc
// 200 → 一条 StrategyRecord（含 backtest，未回测过为 null）
// 404 { "detail": "策略不存在" }
```

### 4.17 POST /strategies/{sid}/{action} —— 手动状态迁移

`action` ∈ `activate` / `reject` / `retire`，对应 `active` / `rejected` / `retired`。

```jsonc
POST /strategies/strat-abc123def0/activate
// 200
{ "id": "strat-abc123def0", "status": "active" }
// 404 { "detail": "策略不存在" }
```

> 激活后才会被 `/shadow/run` 纳入影子验证。回测自动迁移出的 `active` 无需再手动 activate。

### 4.18 GET /shadow/status —— 最近一次影子运行汇总

```jsonc
// 已运行
{ "trade_date": "2026-08-24", "ran_at": "2026-08-24 15:05:12", "overall_nav": 1.005123, "strategy_count": 1 }
// 从未运行
{ "note": "尚未运行影子验证" }
```

### 4.19 GET /shadow/positions —— 影子账户当前持仓

```jsonc
// 200（?strategy_id= 可过滤；按 strategy_id+symbol 排序）
{
  "count": 1,
  "items": [
    { "strategy_id": "strat-abc123def0", "symbol": "600519",
      "qty": 200, "entry_price": 1480.0, "entry_date": "2026-08-23",
      "avg_cost": 1480.0, "cash": 70400.0, "last_price": 1503.0,
      "last_update": "2026-08-24 15:05:12" }
  ]
}
```

### 4.20 GET /shadow/equity —— 影子净值历史

```jsonc
// 200（日期倒序，limit 1–100，默认 30）
// 带 ?strategy_id=
{
  "count": 30,
  "items": [
    { "date": "2026-08-24", "strategy": { …ShadowSnapshot… }, "overall_nav": 1.005123 }
  ]
}
// 不带 strategy_id（整体净值）
{
  "count": 30,
  "items": [
    { "date": "2026-08-24", "overall_nav": 1.005123, "strategy_count": 1 }
  ]
}
```

### 4.21 GET /backtest/results —— 最近的回测运行记录

```jsonc
// 200（created_at 倒序，limit 1–200，默认 20）
{
  "count": 5,
  "runs": [
    { "run_id": "…", "task_id": "…", "created_at": "2026-08-24T07:00:00+00:00",
      "params": { … }, "summary": { …BacktestSummary… }, "n_results": 42 }
  ]
}
```

### 4.22 GET /backtest/performance —— 整体表现重算

从 `decisions.eval_meta` 重算（**无需重跑行情**），`?code=` 可选过滤单股。

```jsonc
// 200
{ "code": "600519", "n_items": 42, "summary": { …BacktestSummary… } }
// 不带 code
{ "code": "all", "n_items": 120, "summary": { …BacktestSummary… } }
```

### 4.23 GET /backtest/performance/{code} —— 单股表现重算（别名）

```jsonc
// 200 → 与 4.22 相同结构，code 恒为路径参数
{ "code": "600519", "n_items": 42, "summary": { … } }
```

### 4.24 GET /personalized/matches —— O 策略—用户匹配推荐

`active` 策略 × 用户画像（KYC 有效画像 + 持仓/自选 + 影子净值 + 样本外 + 组合集中度）确定性打分
（0–100，四维度权重 35/35/20/10 + **N→O 分散化修正**），输出"为你推荐"。同步、<100ms、可解释。

```jsonc
// 200
{
  "as_of": "2026-08-24 15:57:00",
  "profile": "balanced", "profile_label": "稳健型",
  "count": 1,
  "portfolio_concentration": { "concentrated": true, "n": 1, "hhi": 1.0, "limit": 0.3, "label": "稳健型" },
  "items": [{
    "strategy_id": "strat-b022a7436e", "name": "利空·rsi_reversal·688981+2",
    "kind": "rsi_reversal", "direction": "利空", "symbols": ["688981","603986","688347"],
    "status": "active", "nav": 1.0, "closed_count": 0,
    "match_score": 44.2, "fits_profile": true, "caution": null,
    "breakdown": {
      "affinity":    { "score": 0,  "notes": ["未命中你的持仓/自选"] },
      "profile_fit": { "score": 21.0, "notes": ["稳健型画像(激进度0.5) vs 利空rsi_reversal(需求0.9)，契合度60%"] },
      "shadow":      { "score": 10.0, "notes": ["影子净值 1.0000"] },
      "quality":     { "score": 10.0, "notes": ["样本外胜率 100%", "样本外均收益 1.61%"] },
      "diversification": { "score": 3.2, "notes": ["组合集中度高（HHI=1.00），该策略与持仓无重叠，可分散组合 → 加分"] }
    },
    "match_reasons": [
      { "dim": "affinity", "code": "none", "text": "未命中你的持仓/自选", "score": 0 },
      { "dim": "profile_fit", "code": "aligned", "text": "稳健型画像…契合度60%", "score": 21.0 }
    ]
  }]
}
```

- `fits_profile=false` + `caution` 文案出现于硬约束：conservative×利空 / aggressive×ma_cross。
- **N→O 分散化修正**：组合集中度超标（HHI > 画像 `hhi_max`，等权 HHI=1/N）时，
  `diversification` 维度生效——与持仓重叠策略 `-W_DIV`（1 只 -4 / ≥2 只 -8）、无重叠 `+3.2`；
  未超标则该维度 score=0（"组合集中度正常"）。`portfolio_concentration` 暴露集中度信号给前端。
- 排序：`fits_profile` 在前，再按 `match_score` 降序；无 active 策略时 `items` 为空。
- `match_reasons[].code` 取值：affinity=`hit|none`；profile_fit=`aligned|demand_gap|caution`；
  shadow=`nav|profit|no_nav`；quality=`strong|weak`；diversification=`overlap|diversify|neutral`。

### 4.25 GET /personalized/cards —— D+P 个性化资讯卡片 feed

market-watch 事件 → 资讯卡片（命中持仓/自选/策略 → 分桶），按「桶优先级 > relevance」排序。
事件拉取复用 `strategies.fetch_events`（TTL 缓存；market-watch 冷缓存时首次可能空，下一轮恢复）。

| Query | 默认 | 说明 |
|---|---|---|
| `limit` | `30` | 卡片数（1–100） |
| `bucket` | `all` | `all` / `holdings` / `watchlist` / `strategy` / `fresh` |
| `match` | `0` | `1` = 仅命中关注（排除 `fresh` 桶） |
| `comment` | `0` | `1` = 附加 LLM 一句话点评（仅前几张命中卡；无 key/失败 → `null`） |
| `strategy_id` | — | 只返回命中该策略的事件卡 |

```jsonc
// 200
{
  "as_of": "2026-08-24 15:57:29",
  "profile": "balanced", "profile_label": "稳健型",
  "count": 8, "cards": [{
    "card_id": "card-f87bec719", "event_id": "ev-…", "item_id": "sina-…",
    "bucket": "strategy", "relevance_score": 85,
    "type": "价格异动", "direction": "利空",
    "title": "港股芯片股集体下挫…", "summary": "…", "time": "2026-08-24 14:59:48",
    "source": "财联社", "url": "…",
    "tickers": [{ "name": "中芯国际", "code": "688981" }], "industries": ["半导体"],
    "matched": {
      "holdings": [], "watchlist": [],
      "strategies": [{ "id": "strat-b022a7436e", "name": "…", "kind": "rsi_reversal",
                       "direction": "利空", "symbols": ["688981","603986","688347"],
                       "status": "active", "nav": 1.0, "closed_count": 0 }]
    },
    "risk": { "level": "高", "note": "利空事件，稳健型画像需关注持仓风险（买入风险分上限 0.65）" },
    "reasons": ["利空事件", "新鲜：<1小时", "你近期看过相关个股"],
    "llm_comment": "港股芯片板块承压，相关个股短期波动需关注。",
    "event": { /* 原事件全部字段，前端可复用 drawer */ }
  }]
}
```

- `card_id = "card-" + md5(event.id)[:10]`，跨刷新稳定，供 R 埋点回传。
- 桶优先级：`holdings > watchlist > strategy > fresh`；`relevance` 组成：
  `BUCKET_BASE(70/60/50/20) + 新鲜度(15/10/5) + 方向(10/3) + 类型(5/3/0) + 关联策略盈利(5) + 近期点击(5)`。
- **V→D 反馈归因**（R→V→D 闭环）：你反馈「有用」的个股 +6、有用行业（`impact_industries`/`industries`）
  +4；「没用」的个股 -4。对应 reason：「你反馈有用的个股 / 你关注的行业 / 你反馈无用的个股」。
- `risk.level` 按画像护栏文案生成（利空×conservative/balanced→高、aggressive→中；利好→低；中性→中）。

### 4.26 POST /personalized/interactions —— R 行为捕获（view/click 埋点）

```jsonc
// body
{ "card_id": "card-f87bec719", "action": "click",
  "ts": "2026-08-24 15:57:30", "meta": { "bucket": "strategy", "ticker": "688981",
  "strategy_id": "strat-b022a7436e" } }
// 200
{ "ok": true, "stored": true, "action": "click", "card_id": "card-f87bec719" }
```

- `action` ∈ `view`（曝光，每卡每会话一次）/ `click`（点击打开，每次记）。
- 落 `data/adapter/behavior.json`（环形缓冲，默认 cap 500）；`click` 会在 24h 内
  给同 ticker 事件卡 +5 relevance（反馈进 P 排序）。
- `meta` 建议带 `{ bucket, ticker, strategy_id, direction, industries }`：`direction` 参与
  K 画像方向偏差统计（旧记录无 direction 按不参与）；`industries` 参与行业亲和归因。
- `ts` 缺省服务端记；`card_id` 必须回传（渲染时的 `card_id`）。

### 4.27 GET /personalized/interactions —— 最近行为记录

```jsonc
// 200
{ "count": 1, "items": [{ "card_id": "card-…", "action": "click",
  "ts": "…", "meta": { … }, "server_ts": "…" }] }
```

### 4.28 GET /risk/portfolio —— N 组合风险模型（同步、确定性、无实时行情）

等权估算：持仓 `N` → 单股权重 `1/N`、集中度 `HHI=1/N`，对比
`risk_profiles.profile()["risk_budget"]`（balanced：单股 0.25 / HHI 0.30 / 波动 0.18）。
影子回撤/波动来自 `shadow_equity` 净值序列，**≥2 日才评估**，否则 `null` + `data_note="数据不足"`。
服务端按持仓、影子净值和画像版本保存 `RISK_PORTFOLIO_CACHE_TTL` 秒的进程内短缓存；
文件 revision 同时包含设备、inode、ctime、mtime 与尺寸，因此同尺寸原子替换也会立即失效；
同版本的并发请求通过 single-flight 共享同一次成功结果或失败。

```jsonc
// 200
{
  "as_of": "2026-08-24 16:36:58",
  "profile": "balanced", "profile_label": "稳健型",
  "summary": {
    "n_positions": 1, "equal_weight": 1.0, "hhi": 1.0,
    "shadow_max_drawdown": null, "shadow_annualized_vol": null,
    "data_note": "影子净值不足2日，回撤/波动未评估"
  },
  "breaches": [
    { "indicator": "single_stock_weight", "label": "单股权重",
      "value": 1.0, "limit": 0.25, "excess": 4.0, "severity": "高" },
    { "indicator": "hhi", "label": "集中度 HHI",
      "value": 1.0, "limit": 0.3, "excess": 3.33, "severity": "高" }
  ]
}
```

- breach 形状与 `holdings_runner._risk_budget_check` 一致（`{indicator,label,value,limit,excess}`），
  额外带 `severity`：`excess>1.5→高 / >1→中 / 其余低`；`indicator` ∈ `single_stock_weight|hhi|portfolio_vol`。
- 数据不足时**不产出 0 值 breach**（避免误报）。

### 4.29 GET /risk/alerts —— Q 风险预警中心（四源聚合）

聚合 组合(N) + 影子(I) + 事件(F) + 画像(K) 四源，按 `severity 高>中>低` 排序。

```jsonc
// 200
{
  "as_of": "2026-08-24 16:37:09", "profile": "balanced", "profile_label": "稳健型",
  "count": 3,
  "degraded": false,
  "upstreams": {
    "market_watch_events": {
      "degraded": false, "stale": false, "source": "upstream",
      "reason": null, "age_seconds": 0.0, "deadline_seconds": 0.35
    }
  },
  "items": [
    { "id": "risk-…", "source": "portfolio", "severity": "高",
      "title": "单股权重超预算",
      "detail": "当前单股等权占比 100%，稳健型预算上限 25%（超 4.0 倍）",
      "codes": ["600519"], "strategy_id": null, "ts": "…",
      "feedback": { "useful": 0, "useless": 0 } },
    { "id": "risk-…", "source": "portfolio", "severity": "高",
      "title": "集中度 HHI超预算", "detail": "…", "codes": ["600519"], "strategy_id": null, "ts": "…",
      "feedback": { "useful": 0, "useless": 0 } },
    { "id": "risk-…", "source": "profile", "severity": "低",
      "title": "画像预算提示",
      "detail": "当前画像 稳健型，组合预算 波动≤18% / HHI≤0.30",
      "codes": [], "strategy_id": null, "ts": "…",
      "feedback": { "useful": 0, "useless": 0 } }
  ],
  "effect": { "window_hours": 168, "views": 5, "clicks": 0, "useful": 1, "useless": 0, "ctr": 0.0 }
}
```

- `source` ∈ `portfolio | shadow | event | profile`：
  - `portfolio`：N 模型 breach 展开；
  - `shadow`：影子策略 `nav<1`（净值回撤，<0.95→高 / 其余中）、已平仓净负（`shadows/trades:{sid}`）、
    运行错误（`shadow_equity.strategy_errors`）三项；
  - `event`：`fetch_events` → 命中持仓/自选 且 **利空** 事件（持仓→高、自选→中，再用
    `_risk_level` 按画像校准）；market-watch 在 `RISK_EVENT_DEADLINE` 内不可用时优先读取
    `EVENT_STALE_TTL` 内旧值，无旧值则该源自动缺失（不 500），并用 `EVENT_FAILURE_BACKOFF`
    做短失败退避，避免页面轮询反复等待 deadline；
  - `profile`：一条画像预算 advisory（低）。
- 顶层 `degraded` 表示事件上游是否降级；`upstreams.market_watch_events` 给出
  `source=upstream|fresh-cache|stale-cache|fail-open|failure-backoff`、`stale`、`reason`、缓存年龄和 deadline，
  方便前端区分旧数据与完全缺失。
- stale 与失败退避只由 `/risk/alerts` 显式启用；策略假设和个性化卡片仍保持原契约：
  只消费 fresh cache 或本次成功的上游响应，上游失败返回空列表，不静默复用旧事件。
- 事件源复用 `personalize._classify/_risk_level`。为保证持仓分析 deadline，风险路由只使用
  已缓存的 C 影响图谱补充间接波及标的，不会在请求内冷调用 industry-chain；事件直接关联标的语义不变。
- **V→Q 效果归因**：每项带 `feedback{useful,useless}`（该预警被标记的次数）；`effect` 是
  R→V 整体漏斗（曝光→点击→有用/没用→CTR）。**事件源**预警若被标记没用 ≥2 次且 ≥ 有用次数，
  `severity` 自动降一档（高→中/中→低）并在 `detail` 注明「灵敏度已下调」——**组合/影子/画像源永不抑制**。

### 4.30 GET /personalized/impact —— C 事件影响图谱（调试/验证）

事件 → 直连标的产业链上下游 + 同行业公司 的间接波及标的（`impact_codes`）。

| Query | 默认 | 说明 |
|---|---|---|
| `limit` | `5` | 返回事件数（1–50） |

```jsonc
// 200
{
  "as_of": "…", "count": 5,
  "events": [{
    "id": "ev-…", "tickers": [{ "name": "中芯国际", "code": "688981" }],
    "industries": ["半导体"], "direction": "利空", "summary": "…",
    "impact_codes": ["603986","688347", …],      // 间接波及标的（已过 _normalize_symbol 白名单，剔北交所/B股）
    "impact_industries": ["半导体"],
    "impact_by": ["688981 产业链: …", "行业「半导体」: 兆易创新(603986)/…"]   // 可读原因
  }]
}
```

- 数据源 = industry-chain `:8200`：`GET /graph/chain/{code}?depth_up=1&depth_down=1`（邻居）+ 
  `GET /companies?keyword={industry}&limit=50`（同行业）。每事件 ≤2 次子请求、`timeout=1.5`。
- TTL 300s 内存缓存；`:8200` 不可达 → 30s backoff 后跳过 → **优雅降级**：事件保持原样
  （`impact_codes` 为空、不 500、不拖慢）。该扩展已注入 `fetch_events`，
  **`/personalized/cards` 与 `/strategies/hypothesize` 自动吃到**，无需额外传参。

### 4.31 GET /personalized/profile —— K 画像增强（行为推断）

基础画像 + 近 `PERSONALIZED_BEHAVIOR_HOURS`(默认 168) 小时行为（R 埋点）推断的
`effective_aggression` 与关注/方向/策略亲和。

```jsonc
// 200
{
  "as_of": "…", "base_profile": "balanced", "profile_label": "稳健型",
  "base_aggression": 0.5, "effective_aggression": 0.5,
  "behavior": {
    "window_hours": 168, "views": 5, "clicks": 0,
    "focus_tickers": [{ "ticker": "600519", "count": 2 }],
    "direction_skew": null,                       // 无方向数据为 null；有则为 {利好, 利空, good_pct, bad_pct, delta}
    "aggression_delta": 0.0,                      // = clamp(点击方向 delta + 反馈 delta, ±0.15)
    "feedback": { "useful": 1, "useless": 0, "total": 1, "delta": 0.15 },
    "feedback_delta": 0.15,                       // 显式反馈方向修正（利空有用/利好没用=风险耐受，权重 0.15）
    "interest_tickers": [{ "ticker": "001382", "count": 1 }],
    "interest_industries": [{ "industry": "电力设备", "count": 1 }],
    "ignored_tickers": [],
    "industry_affinity": [{ "industry": "电力设备", "count": 1 }],  // 点击+反馈的行业偏好 top8
    "watchlist_tickers": ["600519", "000858", "300750"],            // 关注（自选）
    "trading_affinity": ["688981", "603986", "688347"],             // 交易代理：影子验证中策略标的
    "strategy_affinity": [{ "strategy_id": "…", "kind": "rsi_reversal", "name": "…", "count": 1 }],
    "notes": ["近168小时 5 次点击、1 次反馈；有用1/没用0，行为画像激进度+0.15"]
  },
  "notes": []
}
```

- `effective_aggression = clamp(画像基础激进度 + aggression_delta, 0, 1)`，O 打分用；
  `aggression_delta` 合并点击方向（`0.3×(利空占比-利好占比)`）与反馈方向（`0.15×反馈符号`），
  总上限 ±0.15。行为记录**无 `direction` 的历史数据按不参与**。
- L→K 四类输入：阅读(view/click 方向+行业)、显式反馈(useful/useless→interest/ignored)、
  关注(watchlist_tickers)、交易代理(trading_affinity)；供 O/P/Q 微调与 R→V 归因。

### 4.32 POST /personalized/feedback —— R 显式反馈（P→R 决策信号）

卡片或预警的「有用/没用」反馈，落行为库（`action=feedback`），服务端据此做
R→U→K 画像修正（feedback_delta / interest 集合）与 R→V 效果归因（卡片排序 boost、
事件预警灵敏度校准）。

```jsonc
// body
{ "card_id": "card-f87bec719", "sentiment": "useful",
  "meta": { "bucket": "strategy", "ticker": "688981",
            "strategy_id": "strat-b022a7436e", "direction": "利空",
            "industries": ["半导体"] } }
// 预警反馈：card_id 用 /risk/alerts 的 item.id，meta 带 {source, codes, title}
{ "card_id": "risk-abc123", "sentiment": "useless",
  "meta": { "source": "event", "codes": ["600519"], "title": "持仓利空事件" } }
// 200
{ "ok": true, "stored": true, "sentiment": "useful", "card_id": "card-f87bec719" }
```

- `sentiment` ∈ `useful`（有用/值得看）/ `useless`（没用/噪音）。
- 卡片反馈建议带 `meta{ticker, direction, industries}`（供画像归因）；
  预警反馈建议带 `meta{source, codes, title}`（`source` 决定是否触发 V→Q 灵敏度校准）。
- fire-and-forget：前端不 await、失败静默，绝不阻塞渲染。

### 4.33 GET /evolution/status —— 自进化闭环状态

闭环就绪度、生命周期、当前判定和最近自动应用记录。省略 `strategy_id` 时返回全局看板；
传入安全的 `strategy_id`（`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`，兼容 `strategy@v1` 修订号）时，只返回目标策略及解释
`mutated_from` 母子链所需的生命周期节点。目标不存在返回 `404`，非法标识返回 `422`，不会回退全局数据。

```json
// 200
{ "as_of": "2026-08-24 17:27:11", "days_of_data": 1, "min_days": 5,
  "ready": false,
  "counts": { "candidate": 1, "active": 1, "watch": 0, "retired": 0,
              "rejected": 0 },
  "lifecycle": { "active": [], "candidate": [], "retired": [], "watch": [], "rejected": [] },
  "per_strategy": [], "recent_applied": [], "last_applied_at": null,
  "closed_loop_enabled": false, "closed_loop_time": "15:35",
  "note": "影子净值仅 1 日，自进化待累积至 5 日" }
```

- `days_of_data`：shadow_equity 有效净值日数；`min_days`：进化阈值（默认 5，`EVOLVE_MIN_DAYS`）。
- `ready = days_of_data >= min_days`。不足时只出归因报告，`/evolution/run` 返回 `waiting_data` 不动作。
- `counts.watch` = 自进化降级观察中的策略；变异是来源标记（`source='evolution'`/`mutated_from`），变异候选按真实状态计入 `candidate`，无独立 `mutated` 计数。
- scoped `per_strategy` 只包含目标策略；非 active 策略返回 `decision=none` 和只读说明。
- scoped `recent_applied` 只保留 `sid` 命中目标或 `parent` 为目标的动作；读取和重新评估均不写策略、预案或执行记录。

### 4.34 GET /evolution/attribution —— S→T 策略归因（只读）

影子组合整体归因 + 每策略贡献分解（`GET`，永不写库）。可选 `strategy_id` 与 status 使用同一
安全校验；携带时 `days_of_data`、`overall` 和 `strategies` 全部仅由目标策略的有效影子证据计算。

```json
// 200
{ "as_of": "…", "days_of_data": 5, "min_days": 5, "data_note": null,
  "overall": { "start_nav": 1.0, "end_nav": 1.035, "return_pct": 3.5,
               "max_drawdown_pct": 0.0, "strategy_count": 2 },
  "strategies": [ { "strategy_id": "strat-b022a7436e", "name": "…",
                    "kind": "rsi_reversal", "status": "active",
                    "symbols": ["688981","603986","688347"],
                    "nav": 1.04, "return_pct": 4.0,
                    "max_drawdown_pct": 0.0, "closed_trades": 2,
                    "closed_win_rate_pct": 100.0, "closed_cum_return_pct": 5.0 } ] }
```

- 每策略 `return_pct` / `max_drawdown_pct` 基于该策略影子净值序列；`closed_*` 来自
  `shadows/trades:{sid}` 平仓记录。样本不足（<2 日）对应字段为 `null`，**不要渲染成 0**。
- `strategies` 已按影子收益降序；数据不足时 `data_note` 给提示、`overall`/`strategies` 仍返回当前可得值。

### 4.35 POST /evolution/run —— T→W→H 进化（升降级/淘汰 + 变异回流）

该接口保留给旧客户端和运维兼容流程；产品 UI 不调用 preview 或 run。生产写入由启用的统一自动闭环
调用 `evolve_auto()` 完成影子验证、归因、进化应用、候选验证与推送，并通过 `recent_applied` 留痕。
页面“重新评估”只是重新读取 scoped status/attribution，不生成预案、不应用动作，也不改变策略状态。

```json
// 请求
{ "apply": false }          // false=仅预览（默认）；true=写库执行
```

```json
// 200（apply=false 预览；数据不足时 status=waiting_data + count=0）
{ "as_of": "…", "days_of_data": 5, "min_days": 5, "applied": false,
  "status": "ready", "count": 4, "actions": [
    { "type": "promote", "sid": "strat-good", "from": "tier1", "to": "tier2",
      "reason": "影子净值 1.0400 ≥ 升级线 1.03" },
    { "type": "mutate", "parent": "strat-good", "sid": "strat-768b184ea0",
      "kind": "rsi_reversal", "params": {"n":10,"oversold":25,"overbought":65},
      "symbols": ["688981","603986","688347"],
      "name": "变体·strat-good·b1", "reason": "由升级策略 … 变异 → candidate 回流" },
    { "type": "retire", "sid": "strat-bad", "from": "active", "to": "retired",
      "reason": "平仓胜率 33% < 35%（已平 3 笔），影子表现不可靠" } ] }
```

**动作语义**（对应架构图 T→W→H）：

| type | 触发 | 效果 |
|---|---|---|
| `promote` | 影子 `nav ≥ EVOLVE_PROMOTE_NAV`（默认 1.03） | `evolve.tier=2` 高置信标记 |
| `demote` | 影子 `nav ≤ EVOLVE_DEMOTE_NAV`（默认 0.95） | `evolve.state=watch`：停止推荐、影子继续记账（可恢复） |
| `retire` | 影子 `nav ≤ EVOLVE_RETIRE_NAV`（默认 0.90）或平仓胜率 `< EVOLVE_RETIRE_CLOSED_WIN` 且 ≥3 笔 | `status→retired`：不再推荐、不再进影子 |
| `mutate` | 升级策略 + 样本外达标 + 变异冷却期外（`EVOLVE_MUTATE_COOLDOWN_DAYS`，默认 7） | 参数轻变异 + 标的子集 → 新 `candidate` 写回策略池（`source=evolution`、`mutated_from` 指向父），走既有 E→G→H→I 再验证 |

**护栏**：
- 数据不足（`days_of_data < min_days`）→ `status=waiting_data`、`preview_status=blocked`、`count=0`，
  不生成令牌，**永不写库**；就绪但无动作时为 `preview_status=empty`，同样不可应用。
- 变异只从「样本外 `win_rate_pct ≥ 50` + 影子升级」的 active 策略出发，小步参数扰动；
  同一父策略冷却期内不重复变异（幂等）。
- 阈值全部走 `.env`（`EVOLVE_*`，见 §6.12）；`apply=true` 后再次 dry-run 可见已生效状态。
- **R→S→U→K outcome 版**：`GET /personalized/profile` 的 `behavior.outcome` 即用户参与/激活策略的
  影子 outcome → `outcome_delta`（决策受验证→微调行为激进度），与 `/evolution/run` 相互独立。
- scoped 兼容调用可在 query 或请求体携带同一个安全 `strategy_id`；作用域不一致、标识非法或目标不存在时拒绝，绝不回退到全局执行。

---

## 5. 任务查询与结果

---

## 5. 任务查询与结果

六类任务共用 `/analyze/{task_id}` 前缀（与任务类型无关）。

### 5.1 GET /analyze/{task_id} —— 状态查询

```jsonc
// 200
{ "task_id": "…", "task_type": "stock | holdings | brief | backtest | strategy | shadow",
  "status": "running", "error": null }
// 404 { "detail": "任务不存在" }
```

`status` 枚举：`pending`（未查到时的兜底）/ `running` / `done` / `failed`。

### 5.2 GET /analyze/{task_id}/result —— 最终结果

- 任务不存在 → **404**
- 任务未完成 → **409** `{"detail": "任务尚未完成"}`
- 完成 → **200**，返回与 SSE `result` 事件完全一致的载荷（见 §3 各类结果结构）

### 5.3 SSE：GET /analyze/{task_id}/stream

**事件序列**：`pipeline* → stage*/trace*/progress* → result → done`；失败为 `… → error → done`。
15s 心跳（SSE 注释行 `: ping`，客户端应忽略）。

| event | data（JSON） | 说明 |
|---|---|---|
| `pipeline` | `{"phases":[…], "total_steps": N}` | 任务启动时一次，下发管道清单 |
| `stage` | 结构化：`{"node_id", "phase", "status", "step_index", "elapsed_ms"}`；旧式：`{"node", "message"}` | 节点完成（两种形态都透传） |
| `trace` | `{"content_preview", "content_len", …}` | agent 产出内容摘要 |
| `progress` | `{"percent": 42, "phase": "…"}` | 进度条百分比 |
| `result` | 完整结果对象（见 §3 各类型结构） | 只出现一次 |
| `error` | `{"message": "分析失败：…", "node_id": "…"}` | 引擎/任务异常（node_id 可选） |
| `done` | `{}` | 流结束 |
| `heartbeat` | `{}` | 15s 保活，忽略 |

```jsonc
// 原始 wire（sse-starlette，\r\n 分隔，event/data 字段）
event: pipeline
data: {"phases":["市场分析","基本面","决策"],"total_steps":8}

event: progress
data: {"percent": 25, "phase": "回测"}

event: stage
data: {"node_id": "market_analyst", "phase": "市场分析", "status": "done", "step_index": 1, "elapsed_ms": 1234}

event: result
data: {"signal":{...},"reports":{...},"performance_metrics":{}}

event: done
data: {}
```

> **晚订阅**：任务已完成且队列已空时，订阅者会立即收到一次 `result` + `done`（补发）。
> **向后兼容**：旧 str-based `stage`（`node`/`message`）仍透传；前端应同时兼容两种形态。

### 5.4 GET /reports —— 统一报告摘要列表

任务正常产出 `reports: Record<string, string>` 且至少一个分节正文非空时，适配器会在任务
进入 `done` 前，以 `task_id` 为稳定报告 ID 原子写入 `reports.json`。报告与进程内任务状态
分离，因此服务重启后仍然可查；无报告正文的成功任务不会生成空记录。

查询参数：

| 参数 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `limit` | integer | `20` | `1`～`200` |
| `task_type` | enum | 空 | `stock` / `holdings` / `brief` / `backtest` / `strategy` / `shadow` |

```jsonc
// GET /reports?limit=20&task_type=stock
{
  "count": 1,
  "items": [{
    "id": "3f9a2b8c1d0e4f5a6b7c8d9e0f1a2b34",
    "title": "个股分析报告 · 贵州茅台（600519）",
    "kind": "stock",
    "created_at": "2026-08-26T10:00:00+00:00",
    "summary": "贵州茅台（600519）",
    "task_id": "3f9a2b8c1d0e4f5a6b7c8d9e0f1a2b34"
  }]
}
```

HTTP 摘要是稳定前端 DTO：`kind` 对应磁盘记录的 `task_type`，`task_id` 与 `id` 相同；
不携带 `signal` 和 Markdown 正文，避免列表接口返回过大的报告内容。列表按
`created_at` 倒序；非法 `limit`、`task_type` 返回 **422**。

### 5.5 GET /reports/{report_id} —— 完整报告详情

`report_id` 必须是任务生成的 32 位小写十六进制 `task_id`；格式非法返回 **422**，合法但
不存在返回 **404**。成功时返回稳定详情 DTO，非空正文统一投影为有序 `sections`：

```jsonc
{
  "id": "3f9a2b8c1d0e4f5a6b7c8d9e0f1a2b34",
  "title": "个股分析报告 · 贵州茅台（600519）",
  "kind": "stock",
  "created_at": "2026-08-26T10:00:00+00:00",
  "summary": "贵州茅台（600519）",
  "task_id": "3f9a2b8c1d0e4f5a6b7c8d9e0f1a2b34",
  "sections": [
    {"key": "market", "title": "市场分析", "content": "# 市场分析\n…"},
    {"key": "risk", "title": "风险判断", "content": "# 风险判断\n…"}
  ]
}
```

磁盘记录内部仍完整保留 `task_type`、`subject`、`reference`、`section_keys`、`signal` 和
`reports`，HTTP 边界不直接泄漏该存储结构。读取时会再次校验 ID、任务类型、带时区时间、
分节列表与正文映射；损坏记录不会以伪造的空数据降级返回。

---

## 6. 数据结构速查（TypeScript 视角，供前端对齐）

### 6.1 统一任务结果

```ts
interface TaskResult {
  signal: Signal | HoldingsSignal | BriefSignal
  reports?: Record<string, string>          // 分步 Markdown 报告
  performance_metrics?: Record<string, unknown>
}
// backtest / strategy / shadow 任务的 result 是各自的结构（§6.6 / §6.9 / §6.10），无 signal 字段
```

### 6.2 个股 Signal

```ts
interface Signal {
  signal_type?: string        // "final"
  ticker?: string
  company_name?: string
  action?: string             // 买入 | 持有 | 卖出
  target_price?: number | null
  confidence?: number | null  // 0~1
  risk_score?: number | null  // 0~1
  reasoning?: string
  model_info?: string
  risk_profile?: string       // conservative | balanced | aggressive
  calibration?: boolean
  calibration_note?: string
}
```

### 6.3 持仓 Signal（字段含义见 §3.2，`per_stock` 每只股一个条目）

```ts
interface HoldingsSignal {
  signal_type?: string        // "portfolio"
  mode?: 'quick' | 'deep'
  risk_profile?: string
  total_market_value?: number
  total_cost?: number
  floating_pnl?: number
  floating_pnl_pct?: number
  weighted_risk_score?: number
  portfolio_annualized_vol?: number
  concentration_hhi?: number
  n_positions?: number
  sector_exposure?: Array<{ industry: string; weight: number }>
  risk_breaches?: Array<{ indicator: string; label?: string; value?: number; limit?: number; excess?: number }>
  rebalance_suggestions?: string[]
  per_stock?: Record<string, {
    name?: string; quantity?: number; cost_price?: number; last_price?: number
    market_value?: number; floating_pnl?: number; weight?: number
    annualized_vol?: number; max_drawdown?: number; beta?: number | null
    industry?: string; risk_score?: number | null; risk_level?: string
    action?: string | null; confidence?: number | null; reasoning?: string | null
  }>
}
```

### 6.4 简报 Signal

```ts
interface BriefOpportunity {
  kind?: string               // 见 §3.3 枚举
  risk_level?: '低' | '中' | '高'
  title?: string
  ticker?: string
}

interface BriefSignal {
  signal_type?: string        // "brief"
  period?: 'pre_market' | 'post_market' | 'now'
  trade_date?: string
  summary?: string            // Markdown 简报正文
  risk_profile?: string
  opportunities?: BriefOpportunity[]
}
```

### 6.5 回测聚合摘要（`compute_summary` 输出，`/backtest/*` 与策略回测共用）

```ts
interface BacktestSummary {
  engine_version: string            // "v1" | "strategy-v1" | "persisted"
  eval_window_days: number
  min_age_days?: number | null
  n_decisions_total: number
  n_candidates_evaluated: number
  n_evaluated: number               // 完整评估条数（outcome 计入）
  n_insufficient_data: number
  n_fetch_failed: number
  long_count: number
  cash_count: number
  win_count: number
  loss_count: number
  neutral_count: number
  direction_accuracy_pct: number | null
  win_rate_pct: number | null       // win/(win+loss)
  avg_stock_return_pct: number | null
  avg_simulated_return_pct: number | null
  sharpe_annualized: number | null
  max_drawdown_pct: number | null   // 逐笔复利峰谷（副口径；组合净值回撤看 portfolio.*）
  stop_loss_trigger_rate: number | null
  take_profit_trigger_rate: number | null
  ambiguous_rate: number | null
  avg_days_to_first_hit: number | null
  advice_breakdown: Record<string, { total: number; win: number; loss: number; neutral: number; win_rate_pct: number | null }>
  diagnostics: {
    eval_status: Record<string, number>
    first_hit: Record<string, number>
  }
}

interface PortfolioCurveStats {     // 策略回测的 `portfolio` 子对象（组合等权净值主口径）
  portfolio_return_pct: number | null
  portfolio_max_drawdown_pct: number | null   // 日频净值回撤（负 %）
  portfolio_sharpe: number | null             // 日收益 ×√252
}
```

### 6.6 回测单条决策（`/backtest/run` 的 `results[]`）

```ts
interface BacktestItem {
  key?: string                      // "{ticker}_{trade_date}"
  ticker?: string
  trade_date?: string
  company_name?: string
  decision_source?: 'structured' | 'text_inferred'
  action?: string                   // 买入 | 持有 | 卖出 | 观望
  confidence?: number | null
  target_price?: number | null
  direction_expected?: 'up' | 'down' | 'not_down' | 'flat'
  position_recommendation?: 'long' | 'cash'
  start_bar_date?: string           // 入场日（首个 date>=trade_date 且 close 有效）
  end_bar_date?: string
  n_forward_bars?: number
  entry_price?: number
  end_close?: number
  stock_return_pct?: number
  simulated_return_pct?: number     // 含止损/止盈兑现
  outcome?: 'win' | 'loss' | 'neutral' | null
  direction_correct?: boolean | null
  stop_loss?: number | null
  take_profit?: number | null
  hit_sl?: boolean | null
  hit_tp?: boolean | null
  first_hit?: 'stop_loss' | 'take_profit' | 'ambiguous' | 'neither' | 'not_applicable' | null
  first_hit_date?: string | null
  first_hit_days?: number | null
  exit_price?: number
  exit_reason?: string              // window_end | stop_loss | take_profit | ambiguous | cash | series_end | signal
  eval_status: 'evaluated' | 'insufficient_data' | 'fetch_failed'
  eval_error?: string | null
}
```

### 6.7 策略记录（`GET /strategies` 的 `items[]`、`GET /strategies/{sid}`）

```ts
type ProfileKey = 'conservative' | 'balanced' | 'aggressive'

interface StrategyRecord {
  id: string                        // "strat-" + md5[:10]
  name: string                      // "利好·momentum·600519" / "利空·rsi_reversal·600519+2"
  kind: 'ma_cross' | 'rsi_reversal' | 'momentum' | 'breakout' | 'bollinger' | 'volume_breakout'
  params: Record<string, number>    // ma_cross:{fast,slow} rsi_reversal:{n,oversold,overbought} momentum:{n} breakout:{n} bollinger:{n,k} volume_breakout:{n,vol_mult}
  symbols: string[]                 // 6 位 A 股代码（已剔北交所/B 股）
  direction: '利好' | '利空'
  hypothesis: string                // 假设因果一句话
  source_event_id: string
  source_event_summary: string
  holding_window_days: number
  status: 'candidate' | 'active' | 'rejected' | 'retired'
  backtest: StrategyBacktest | null // 未回测过为 null
  created_at: string                // "YYYY-MM-DD HH:MM:SS"
  updated_at: string
}

interface StrategyHypothesis {      // hypothesize 的 hypotheses[]
  event_idx: number
  symbols: string[]
  direction: '利好' | '利空'
  kind: 'ma_cross' | 'rsi_reversal' | 'momentum' | 'breakout' | 'bollinger' | 'volume_breakout'
  params: Record<string, number>
  rationale: string
  holding_window_days: number
}

interface StrategyBacktestResult {  // /strategies/run 的 result
  strategy_id: string
  status: string                    // active | candidate | rejected | retired
  backtest: StrategyBacktest
  symbol_errors: Record<string, string>
}

interface StrategyBacktest {
  in_sample: BacktestSummary & { portfolio: PortfolioCurveStats }
  out_of_sample: BacktestSummary & { portfolio: PortfolioCurveStats }
  thresholds_pass: boolean
  reason: string
  ran_at: string
  per_symbol: Record<string, {
    trades_in?: number
    trades_out?: number
    last_in_ret?: number | null
    last_out_ret?: number | null
    error?: string
  }>
  symbol_errors: Record<string, string>
}
```

### 6.8 影子验证

```ts
interface ShadowRunResult {         // /shadow/run 的 result
  skipped: boolean
  trade_date: string
  reason?: string                   // skipped 时：已运行 / 无 active 策略
  strategies?: Record<string, ShadowSnapshot>
  overall_nav?: number | null
  strategy_errors?: Record<string, string>
}

interface ShadowSnapshot {
  name: string
  kind: string
  symbols: string[]
  initial_capital: number
  equity: number
  nav: number | null                // equity / initial_capital
  track_from: string                // 开始跟踪日（激活不立即建仓）
  closed_count: number
  per_symbol: Record<string, {
    qty: number
    entry_price: number | null
    entry_date: string | null
    avg_cost: number | null
    cash: number
    last_price: number | null
    equity: number
    signal_intent: number           // 0/1 当前信号意图
  }>
  symbol_errors: Record<string, string>
}

interface ShadowPosition {          // /shadow/positions items[]
  strategy_id: string
  symbol: string
  qty: number
  entry_price: number | null
  entry_date: string | null
  avg_cost: number | null
  cash: number
  last_price: number | null
  last_update: string               // "YYYY-MM-DD HH:MM:SS"
}

// /shadow/equity items[]（两形态）
type ShadowEquityItem = { date: string; overall_nav: number | null }
  & ({ strategy_count: number } | { strategy: ShadowSnapshot })
```

### 6.9 KYC

```ts
interface KyAnswer { qid: string; label: string; score: number }  // score 1~5

interface KycView {                 // GET /kyc/profile
  status: 'not_started' | 'completed' | 'adjusted'
  inferred_profile?: ProfileKey | null
  effective_profile: ProfileKey
  effective_label: string
  score?: number | null
  answers?: KyAnswer[]
  manual_adjust?: { risk_tolerance: number; horizon_years: number; note: string } | null
  completed_at?: string | null      // ISO 8601
  method?: 'questionnaire' | 'voice' | null
  voice_source?: string | null
  last_profile?: ProfileKey | null
  tiers: { quick: string[]; full: string[] }
  question_bank: Record<string, {
    qid: string; title: string; options: { label: string; score: number }[]
  }>
  bands: Record<ProfileKey, { min: number; max: number; label: string; desc: string }>
  profile_labels: Record<ProfileKey, string>
  profiles_detail: Record<string, unknown>   // RISK_PROFILES（各档护栏/预算）
}

interface KycQuestionnaireResult {  // POST /kyc/questionnaire
  profile: ProfileKey
  label: string
  score: number
  inferred_profile: ProfileKey
  mapping: Record<ProfileKey, { min: number; max: number; label: string; desc: string }>
}

interface KycAdjustResult {         // POST /kyc/adjust
  profile: ProfileKey
  label: string
  manual_adjust: { risk_tolerance: number; horizon_years: number; note: string }
}

interface KycParseResult {          // POST /kyc/parse
  answers: KyAnswer[]
  text: string
  source: 'llm' | 'rules'
}
```

### 6.10 个性化右链（O/C/D/P/R/K，`/personalized/*`）

```ts
interface BehaviorProfile {         // K 画像增强（L→K）：GET /personalized/profile → behavior
  window_hours: number; views: number; clicks: number
  focus_tickers: { ticker: string; count: number }[]
  direction_skew: { 利好: number; 利空: number; good_pct: number
                    bad_pct: number; delta: number } | null
  aggression_delta: number          // clamp(点击方向 delta + 反馈 delta + outcome delta, ±0.15)
  feedback: { useful: number; useless: number; total: number; delta: number }
  feedback_delta: number            // 显式反馈方向修正（利空有用/利好没用=风险耐受）
  outcome: {                        // 自进化 outcome 版（R→S→U→K）：参与/激活策略的影子 outcome
    delta: number; engaged: number; samples: number
    avg_return_pct: number | null; note: string
  } | null                          // 数据不足（<2 日）或无样本时 delta=0 + note
  outcome_delta: number             // clamp(0.08 × 参与策略影子均收益, ±0.05)
  interest_tickers: { ticker: string; count: number }[]        // 你反馈有用的个股
  interest_industries: { industry: string; count: number }[]   // 你反馈有用的行业
  ignored_tickers: { ticker: string; count: number }[]         // 你反馈无用的个股
  industry_affinity: { industry: string; count: number }[]     // 点击+反馈行业偏好 top8
  watchlist_tickers: string[]                                  // 关注（自选）
  trading_affinity: string[]                                   // 交易代理：影子验证中策略标的
  strategy_affinity: { strategy_id: string; kind: string; name: string; count: number }[]
  notes: string[]
}

interface StrategyMatch {           // GET /personalized/matches → items[]
  strategy_id: string; name: string; kind: string; direction: string
  symbols: string[]; status: string
  nav: number | null; closed_count: number
  match_score: number; fits_profile: boolean; caution: string | null
  breakdown: Record<string, { score: number; notes: string[] }>   // 含 diversification（N→O）
  match_reasons: { dim: string; code: string; text: string; score: number }[]
}
// GET /personalized/matches 顶层额外：
//   effective_aggression: number, behavior: BehaviorProfile,
//   portfolio_concentration: { concentrated: boolean; n: number; hhi: number; limit: number | null; label: string | null }

interface PersonalizedCard {        // GET /personalized/cards → cards[]
  card_id: string; event_id: string; item_id: string
  bucket: 'holdings' | 'watchlist' | 'strategy' | 'fresh'
  relevance_score: number
  type: string; direction: string; title: string; summary: string
  time: string; source: string; url: string
  tickers: { name: string; code: string }[]; industries: string[]
  impact: {                          // C 事件影响图谱（:8200 挂掉时为空对象）
    codes: string[]; industries: string[]; by: string[]
  }
  matched: {
    holdings: string[]; watchlist: string[]
    strategies: { id: string; name: string; kind: string; direction: string
                  symbols: string[]; status: string; nav: number | null;
                  closed_count: number }[]
  }
  risk: { level: '高' | '中' | '低'; note: string }
  reasons: string[]
  llm_comment: string | null
  event: Record<string, unknown>    // 原事件字段（含 impact_codes/impact_by），前端可复用 drawer
}
// GET /personalized/cards 顶层额外：effective_aggression: number, behavior: BehaviorProfile

interface InteractionRecord {       // POST/GET /personalized/interactions
  card_id: string; action: 'view' | 'click'
  ts: string; meta?: Record<string, unknown>; server_ts?: string
}
// meta.direction: '利好' | '利空' | '' —— 前端补埋，供 K 方向偏差统计
// meta.industries: string[] —— 前端补埋，供行业亲和归因

interface FeedbackRecord {          // POST /personalized/feedback → 行为库 action=feedback
  card_id: string; sentiment: 'useful' | 'useless'
  ts: string; meta?: Record<string, unknown>; server_ts?: string
}
// 卡片反馈 meta 建议 { bucket, ticker, strategy_id, direction, industries }
// 预警反馈 meta 建议 { source, codes, title } —— source='event' 才触发 V→Q 灵敏度校准
```

### 6.11 风险预警中心（N+Q，`/risk/*`）

```ts
interface RiskBreach {              // GET /risk/portfolio → breaches[]
  indicator: 'single_stock_weight' | 'hhi' | 'portfolio_vol'
  label: string; value: number; limit: number; excess: number
  severity: '高' | '中' | '低'       // excess>1.5→高 / >1→中 / 其余低
}

interface RiskAlert {               // GET /risk/alerts → items[]
  id: string; source: 'portfolio' | 'shadow' | 'event' | 'profile'
  severity: '高' | '中' | '低'
  title: string; detail: string
  codes: string[]; strategy_id: string | null; ts: string
  feedback: { useful: number; useless: number }   // V→Q 归因：该预警被标记次数
}
// GET /risk/alerts 顶层额外：
//   degraded: boolean
//   upstreams: { market_watch_events: {
//     degraded: boolean; stale: boolean
//     source: 'upstream' | 'fresh-cache' | 'stale-cache' | 'fail-open'
//     reason: string | null; age_seconds: number | null; deadline_seconds: number
//   } }
//   effect: { window_hours: number; views: number; clicks: number;
//             useful: number; useless: number; ctr: number | null }  // R→V 整体漏斗
// 事件源预警 feedback.useless>=2 且 >=useful → severity 降一档（detail 注明「灵敏度已下调」）
```

### 6.12 自进化闭环（S_shadow→T→W→H + R→S→U→K outcome，`/evolution/*`）

```ts
interface EvolutionStatus {         // GET /evolution/status
  as_of: string; days_of_data: number; min_days: number; ready: boolean
  counts: { candidate: number; active: number; watch: number
            retired: number; rejected: number }   // 无独立 mutated（变异并入 candidate 等真实状态）
  note: string | null
  last_applied_at: string | null            // 最近一次自动应用进化时间（YYYY-MM-DD HH:MM:SS）
  closed_loop_enabled: boolean              // CLOSED_LOOP_ENABLED
  closed_loop_time: string                  // CLOSED_LOOP_TIME，默认 "15:35"
  per_strategy: EvolutionPerStrategy[]      // 各 active 策略当前判定（含行为/原因/净值）
  recent_applied: EvolutionApplied[]        // 最近 5 条自动进化应用记录（时间线）
  lifecycle: { active: EvolutionLifecycleEntry[]
              candidate: EvolutionLifecycleEntry[]
              retired: EvolutionLifecycleEntry[]
              watch: EvolutionLifecycleEntry[]
              rejected: EvolutionLifecycleEntry[] }
        // 各生命周期分组策略列表（供前端点开计数查看具体策略）；
        // 变异候选按真实状态（candidate/active）落桶，无独立 mutated 桶
}

// GET /evolution/status?strategy_id=<safe-id>：per_strategy 仅目标策略，recent_applied 仅相关动作，
// lifecycle 仅目标与必要母子链；GET /evolution/attribution 使用相同 scope。不存在返回 404。

interface EvolutionPerStrategy {            // /evolution/status → per_strategy[]
  strategy_id: string; name: string; kind: string; tier: number
  symbols: string[]; nav: number | null
  closed_win_rate_pct: number | null; closed_trades: number
  decision: 'promote' | 'demote' | 'retire' | 'none'
  behavior: string   // 升级 / 淘汰 / 降级观察 / 正常运行 / 待判定 / 已升级 / 降级观察中 / 升级+变异
  reason: string
}

interface EvolutionApplied {                // /evolution/status → recent_applied[]
  applied_at: string; count: number
  actions: { type: string; sid: string; reason: string }[]
}

interface EvolutionLifecycleEntry {        // /evolution/status → lifecycle.<group>[]
  strategy_id: string; name: string; kind: string; tier: number
  symbols: string[]; mutated_from?: string; source?: string
        // source==="evolution" + mutated_from=父策略 → 变异来源标记；按真实状态落 candidate/active 等桶
}

interface StrategyAttribution {     // GET /evolution/attribution → strategies[]
  strategy_id: string; name: string; kind: string; status: string
  symbols: string[]; nav: number
  return_pct: number | null; max_drawdown_pct: number | null
  closed_trades: number; closed_win_rate_pct: number | null
  closed_cum_return_pct: number | null
}
// GET /evolution/attribution 顶层：as_of, days_of_data, min_days, data_note,
//   overall: { start_nav, end_nav, return_pct, max_drawdown_pct, strategy_count }

interface EvolutionAction {         // POST /evolution/run → actions[]
  type: 'promote' | 'demote' | 'retire' | 'mutate'
  sid: string
  from?: string; to?: string                     // 升降级流转（promote/demote/retire）
  parent?: string; kind?: string; params?: object // 变异（mutate）
  symbols?: string[]; name?: string; reason: string
}
// POST /evolution/run 顶层：as_of, days_of_data, min_days, applied, status
//   ('ready' | 'waiting_data'), count, actions[], data_note?
```

产品合同：全局看板只读无 `strategy_id` 的 status/attribution；策略研究第 4 步只读携带同一
`strategy_id` 的 scoped status/attribution。`POST /evolution/run` 及 preview 仅为兼容合同，统一写入路径是
闭环调度器的 `evolve_auto()`；调度器按交易日门禁和分段异常隔离执行，并把已应用动作写入审计时间线。

**策略 `evolve` 字段**（写进 strategies 集合，前端 `GET /strategies` 可读）：
`{ state: 'active'|'watch'|'retired', tier: 1|2, updated_at, note?, mutated_at? }`。
- `state=watch`（降级观察）：`status` 仍 active → 影子继续记账（shadow runner 自读 status），
  但 **O 推荐侧（`/personalized/matches`、卡片 strategy 桶、事件→策略命中）过滤掉**（`_active_strategies`）；
- `state=retired` / `status=retired`：不再推荐、不再进影子；
- `source='evolution'` + `mutated_from=<父 id>` + `generation`：变异回流候选，走既有 E→G→H→I 再验证。

**进化阈值（`.env`）**：

| 变量 | 默认 | 说明 |
|---|---|---|
| `EVOLVE_MIN_DAYS` | `5` | 影子净值≥N 日才执行升降级/变异（不足只出归因） |
| `EVOLVE_PROMOTE_NAV` | `1.03` | `nav ≥` 升级线 → tier2 + 可变异 |
| `EVOLVE_DEMOTE_NAV` | `0.95` | `nav ≤` 观察线 → watch 降级 |
| `EVOLVE_RETIRE_NAV` | `0.90` | `nav ≤` 淘汰线 → retired |
| `EVOLVE_RETIRE_CLOSED_WIN` | `0.35` | 平仓胜率 < 此且 ≥3 笔 → retired |
| `EVOLVE_MUTATE_BRANCHES` | `2` | 每升级策略变异分支数 |
| `EVOLVE_MUTATE_COOLDOWN_DAYS` | `7` | 父策略变异冷却（幂等护栏） |

---

## 7. 与插件工具的映射

dsh 插件 `backend/dsh-trading-core/dsh-plugin/` 注册 20 个对话工具（`tc_` 前缀）：

**任务型**（POST 启动 → 轮询 `GET /analyze/{task_id}` → done 后取 result；超时返回 running 信封，
可用 `tc_task_status` 凭 `task_id` 续查）：

| dsh 插件工具 | 启动端点 | 结果 |
|---|---|---|
| `tc_analyze_stock` | POST `/analyze` | `{signal, reports, performance_metrics}` |
| `tc_analyze_holdings` | POST `/holdings/analyze` | `{signal, reports, performance_metrics}` |
| `tc_market_brief` | POST `/brief` | `{signal, reports, performance_metrics}` |
| `tc_backtest` | POST `/backtest/run` | `{summary, results, params, meta}` |
| `tc_strategy_run` | POST `/strategies/run` | `{strategy_id, status, backtest, symbol_errors}` |
| `tc_shadow_run` | POST `/shadow/run` | `{skipped, trade_date, strategies, overall_nav, strategy_errors}` |
| `tc_task_status` | GET `/analyze/{task_id}` | 状态续查 |

**同步只读**：

| dsh 插件工具 | 底层端点 |
|---|---|
| `tc_get_watchlist` | GET `/watchlist` |
| `tc_get_holdings` | GET `/holdings` |
| `tc_list_strategies` | GET `/strategies` |
| `tc_shadow_status` | GET `/shadow/status` |
| `tc_risk_alerts` | GET `/risk/alerts` |
| `tc_news_cards` | GET `/personalized/cards` |
| `tc_personalized_profile` | GET `/personalized/profile` |
| `tc_evolution_status` | GET `/evolution/status` |
| `tc_evolution_attribution` | GET `/evolution/attribution` |
| `tc_latest_brief` | GET `/brief/latest` |
| `tc_risk_profile` | GET `/risk_profile` |

**同步写**：

| dsh 插件工具 | 底层端点 |
|---|---|
| `tc_set_watchlist` | POST `/watchlist`（整体替换） |
| `tc_set_holdings` | POST `/holdings/save`（整体替换） |

> 二期端点（回测/策略/影子/个性化/风险/进化）在 0.2 前由 product 前端直连
> （`PA.api` + `PA.runTask`，走 task_id + SSE 协议）；自 dsh 插件落成起，同一批端点
> 以 `tc_*` 工具形式开放给对话流。两者并存，不影响前端。

---

## 8. 状态与数据持久化

- **任务**（task_id、进度队列、结果）：**仅内存**，适配器重启即失。
- **一期数据**：`watchlist` / `holdings` / `preferences`（`risk_profile`）/ `briefs` → 本地 JSON，
  位于 `data/adapter/*.json`，原子写、线程安全。
- **KYC**：`preferences.kyc`（原始记录：答案/得分/推断画像/微调）+ `preferences.last_profile`
  （变更前画像，供 UI 展示"发生了什么变化"）。
- **策略研究**：
  - `strategies`（策略记录，含 `backtest`）
  - `shadows`（`meta` / `pos:{sid}:{sym}` 持仓 / `trades:{sid}` 平仓台账）
  - `shadow_equity`（按 date 的净值快照）
  - `backtests`（回测运行记录）
  - `decisions`（评估结果写回 `eval_meta`，供 `/backtest/performance` 重算）
- **调度器**：`BRIEF_SCHEDULE_ENABLED`（简报 job）与 `SHADOW_SCHEDULE_ENABLED`
  （shadow_daily job，默认 false；手动 POST 永远可用）。
- **事件影响图谱（C）**：`:8200` 扩展结果在**进程内内存缓存**（TTL 300s，key=event id），
  重启即失 → 下一次 `fetch_events` 自动重建；`:8200` 不可达时 30s backoff 后优雅降级为空。
- **行为画像（L→K）**：`behavior.json`（环形缓冲）为唯一持久源，`/personalized/profile`
  每次实时重算（不落中间态）。
- 数据目录可随仓库整体迁移；`USE_MONGODB_STORAGE` 恒为 `false`（本项目固定 JSON 存储）。
