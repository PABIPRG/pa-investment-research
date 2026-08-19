# dsh-trading-core · 适配器 API 接口文档

> 面向：后端联调 / 前端桥接层开发者 / 部署运维。
> 本文档描述 **Python 适配器（FastAPI，`adapter/app.py`）** 暴露的全部 HTTP 接口。
> 版本：适配器 0.1.0 · 覆盖代码当前实现（含 9 个插件工具对应的底层端点）。

---

## 1. 总体说明

### 1.1 架构与两种接口类型

```
前端 UI / dsh 插件（任何 HTTP 客户端）
        │  HTTP + SSE
        ▼
   FastAPI 适配器  (127.0.0.1:8000)
        ├─ 任务式接口：POST /analyze、/holdings/analyze、/brief
        │     → 返回 task_id → 轮询 /analyze/{id} 或 订阅 SSE /analyze/{id}/stream
        └─ 轻量接口：watchlist / risk_profile / holdings/save / brief/latest / health
              → 同步请求/响应，秒级返回
        │
        ▼
   TradingAgents-CN 引擎（ThreadPoolExecutor worker 线程，同步阻塞）
```

| 类型 | 端点 | 特点 |
|---|---|---|
| 任务式 | `/analyze`、`/holdings/analyze`、`/brief` | 异步长任务（单股分析 3–9 分钟），先拿 `task_id`，再轮询或订阅 SSE |
| 轻量 | `/watchlist`、`/risk_profile`、`/holdings/save`、`/brief/latest`、`/health` | 同步短请求，直接返回结果 |
| 流式 | `/analyze/{id}/stream` | SSE 进度流（`stage* → result → done`，失败为 `error → done`） |

### 1.2 通用约定

- **Base URL**：`http://127.0.0.1:8000`（可通过 `--host` / `--port` 修改；插件 `adapterBaseUrl` 配置指向它）
- **请求体**：`application/json`（Pydantic 校验，字段缺失/非法返回 `422`）
- **响应体**：`application/json`（中文已 `ensure_ascii=False`，UTF-8）
- **CORS**：`allow_origins=["*"]`，浏览器跨域可直接调用
- **错误格式**：FastAPI 标准错误 `{"detail": "..."}`；自定义错误码见下表
- **认证**：当前无鉴权（仅绑定 127.0.0.1 默认；对外部署需自行加反向代理/网关）
- **任务状态**：任务全部保存在**适配器进程内存**中（`TaskManager`），**进程重启后任务丢失**

### 1.3 错误码速查

| 状态码 | 场景 |
|---|---|
| 200 | 成功 |
| 404 | 任务不存在 / 简报记录缺失 / 标记简报不存在 |
| 409 | `GET /analyze/{id}/result` 任务尚未完成 |
| 422 | 请求体校验失败（字段缺失、非法枚举等） |
| 500 | 引擎异常（已由 `TaskManager` 捕获，任务标记 `failed`，SSE 会推 `error` 事件） |

### 1.4 风险偏好（risk_profile）贯穿所有任务

`conservative`（保守）/ `balanced`（稳健，默认）/ `aggressive`（进取）。
解析优先级：**请求参数 `risk_profile` > 已保存偏好（store）> `.env RISK_PROFILE` > `balanced`**。
引擎决策还会被"风险偏好护栏"修正（`calibration` / `calibration_note` 字段标注是否被校准）。

---

## 2. 端点总表

| # | 方法 | 路径 | 说明 | 类型 |
|---|---|---|---|---|
| 1 | GET | `/health` | 健康检查 + runner 列表 | 轻量 |
| 2 | POST | `/analyze` | 启动**个股多智能体分析** | 任务式 |
| 3 | POST | `/holdings/analyze` | 启动**持仓风险分析** | 任务式 |
| 4 | POST | `/holdings/save` | 保存/整体替换持仓 | 轻量 |
| 5 | GET | `/watchlist` | 读取自选列表 | 轻量 |
| 6 | POST | `/watchlist` | 整体替换自选列表 | 轻量 |
| 7 | GET | `/risk_profile` | 读取风险偏好 | 轻量 |
| 8 | POST | `/risk_profile` | 保存全局风险偏好 | 轻量 |
| 9 | POST | `/brief` | 启动**市场简报生成** | 任务式 |
| 10 | GET | `/brief/latest` | 最近一份简报 | 轻量 |
| 11 | POST | `/brief/{id}/dsh-pushed` | 标记简报已在对话内播报（幂等） | 轻量 |
| 12 | GET | `/analyze/{task_id}/stream` | **SSE 进度流**（三类任务共用） | 流式 |
| 13 | GET | `/analyze/{task_id}/result` | 最终结果（未完成 409） | 查询 |
| 14 | GET | `/analyze/{task_id}` | 任务状态查询 | 查询 |

---

## 3. 任务式接口

> 三步调用范式（三类任务一致）：
> 1. **启动**：POST 对应端点 → `{ "task_id": "..." }`
> 2. **订阅进度**：GET `/analyze/{task_id}/stream`（SSE）或轮询 GET `/analyze/{task_id}`
> 3. **取结果**：SSE 的 `result` 事件里自带最终结果；或任务 `done` 后 GET `/analyze/{task_id}/result`

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

| depth | max_debate_rounds | max_risk_discuss_rounds | online_news |
|---|---|---|---|
| quick / basic / standard | 1 | 1 | false |
| deep | 2 | 2 | false |
| full | 3 | 3 | true |

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
| `mode` | enum | | `quick`（仅定量，秒级）/ `deep`（逐股引擎，3–5 分钟），默认 `deep` |
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

---

## 4. 轻量接口

### 4.1 GET /health —— 健康检查

```jsonc
// 200
{ "status": "ok", "runners": { "stock": "tradingagents-cn", "holdings": "holdings-analyzer", "brief": "brief-engine" } }
```

> `runners` 中的值随 `ADAPTER_RUNNER` 变化：`fake` 模式为 `fake` / `fake-holdings` / `fake-brief`。

### 4.2 GET /watchlist —— 读取自选列表

```jsonc
// 200
{ "tickers": ["600519", "000858", "300750"] }
```

### 4.3 POST /watchlist —— 整体替换自选列表

```jsonc
POST /watchlist
{ "tickers": ["600519", "000858"] }
// 200
{ "saved": 2 }
```

### 4.4 GET /risk_profile —— 读取风险偏好

```jsonc
// 200
{ "risk_profile": "balanced", "label": "稳健型" }
```

### 4.5 POST /risk_profile —— 保存风险偏好

```jsonc
POST /risk_profile
{ "risk_profile": "aggressive" }
// 200
{ "risk_profile": "aggressive", "label": "进取型" }
```

### 4.6 POST /holdings/save —— 保存持仓

```jsonc
POST /holdings/save
{ "holdings": [{"ticker": "600519", "quantity": 200, "cost_price": 1480}] }
// 200
{ "saved": 1, "mode": "manual" }
```

### 4.7 GET /brief/latest —— 最近一份简报

```jsonc
// 已有简报
{
  "id": "pre_market:2026-08-19",
  "period": "pre_market",
  "trade_date": "2026-08-19",
  "generated_at": "2026-08-19 08:51:03",
  "summary": "# 盘前简报 …",
  "opportunities": [],
  "scope": "all",
  "risk_profile": "balanced",
  "dsh_pushed": false
}
// 尚无简报（返回空记录，前端按"暂无简报"优雅处理，非 404）
{ "id": null, "period": null, "trade_date": null, "summary": null, "dsh_pushed": null }
```

### 4.8 POST /brief/{id}/dsh-pushed —— 标记已播报（幂等）

```jsonc
POST /brief/pre_market%3A2026-08-19/dsh-pushed
// 200
{ "id": "pre_market:2026-08-19", "dsh_pushed": true }
// 简报不存在 → 404 { "detail": "简报不存在" }
```

> `id` 需 URL 编码（含 `:` 与 `日期`）。用于"对话内播报去重"：播报成功后才标记，重启可重放。

---

## 5. 任务查询与结果

三类任务共用 `/analyze/{task_id}` 前缀（与任务类型无关）。

### 5.1 GET /analyze/{task_id} —— 状态查询

```jsonc
// 200
{ "task_id": "…", "task_type": "stock | holdings | brief", "status": "running", "error": null }
```

`status` 枚举：`pending`（未查到时的兜底）/ `running` / `done` / `failed`。

### 5.2 GET /analyze/{task_id}/result —— 最终结果

- 任务不存在 → **404**
- 任务未完成 → **409** `{"detail": "任务尚未完成"}`
- 完成 → **200**，返回与 SSE `result` 事件完全一致的载荷（见 §3）

### 5.3 SSE：GET /analyze/{task_id}/stream

**事件序列**：`stage* → result → done`；失败为 `stage* → error → done`。15s 心跳（SSE 注释行 `: ping`）。

| event | data（JSON） | 说明 |
|---|---|---|
| `stage` | `{"node": "…", "message": "🔍 市场分析师：分析技术趋势…"}` | 阶段进度（`node` 可为 null） |
| `result` | 完整结果对象 `{signal, reports, performance_metrics}` | 只出现一次 |
| `error` | `{"message": "分析失败：…"}` | 引擎/任务异常 |
| `done` | `{}` | 流结束 |

```jsonc
// 原始 wire（sse-starlette，\r\n 分隔，event/data 字段）
event: stage
data: {"node": "market_analyst", "message": "🔍 市场分析师：分析技术趋势（MA/MACD/RSI/BOLL）…"}

event: result
data: {"signal":{...},"reports":{...},"performance_metrics":{}}

event: done
data: {}
```

> **晚订阅**：任务已完成且队列已空时，订阅者会立即收到一次 `result` + `done`（补发）。
> **heartbeat**：事件类型为 `heartbeat` 的帧 data 为空，客户端应忽略并保持连接。

---

## 6. 数据结构速查（TypeScript 视角，供前端对齐）

### 6.1 统一任务结果

```ts
interface TaskResult {
  signal: Signal | HoldingsSignal | BriefSignal
  reports?: Record<string, string>          // 分步 Markdown 报告
  performance_metrics?: Record<string, unknown>
}
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

---

## 7. 与插件工具的映射

| dsh 插件工具 | 底层端点 |
|---|---|
| `analyze_stock` | POST `/analyze` + SSE |
| `analyze_holdings` | POST `/holdings/analyze` + SSE |
| `market_brief` | POST `/brief` + SSE |
| `set_watchlist` | POST `/watchlist` |
| `get_watchlist` | GET `/watchlist` |
| `set_holdings` | POST `/holdings/save` |
| `get_latest_brief` | GET `/brief/latest` |
| `set_risk_profile` | POST `/risk_profile` |
| `get_risk_profile` | GET `/risk_profile` |

---

## 8. 状态与数据持久化

- 任务（task_id、进度队列、结果）：**仅内存**，适配器重启即失。
- `watchlist` / `holdings` / `preferences`（risk_profile）/ `briefs`：**本地 JSON 文件**，位于 `data/adapter/*.json`，原子写、线程安全。
- 数据目录可随仓库整体迁移；`USE_MONGODB_STORAGE` 恒为 `false`（本项目固定 JSON 存储）。
