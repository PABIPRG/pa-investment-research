# market-watch · 盯盘适配器 API 接口文档

> 面向：后端联调 / 前端桥接层开发者 / 部署运维。
> 本文档描述 **盯盘适配器（FastAPI，`market_watch/app.py`，端口 8100）** 暴露的全部 HTTP 接口。
> 版本：适配器 0.1.0 · 覆盖代码当前实现（自选 / 盯盘规则 / 扫描 / 技术信号 / 新闻 / 简报 / 调度器）。

---

## 1. 总体说明

### 1.1 架构与接口类型

```
前端 UI / dsh 插件（任何 HTTP 客户端）
        │  HTTP（同步，无 SSE）
        ▼
   FastAPI 盯盘适配器  (127.0.0.1:8100)
        │
        ▼
   行情/新闻/事件数据层（akshare + 东财直连 + 新浪 fallback，TTL 缓存）
```

| 类型 | 特点 |
|---|---|
| 全部同步 | 所有端点均为秒级返回（实时快照 TTL 缓存复用），**无任务式接口、无 SSE** |
| 读写混合 | 自选 / 规则为写操作（落本地 JSON store）；行情 / 新闻 / 简报为读或"生成"操作 |
| 自动降级 | 行情东财→新浪、新闻 LLM→模板、事件 LLM→规则，任何一层挂了接口仍可用 |

### 1.2 通用约定

- **Base URL**：`http://127.0.0.1:8100`（可通过 `--host` / `--port` 修改）
- **请求体**：`application/json`（Pydantic 校验，字段缺失/非法返回 `422`）
- **响应体**：`application/json`（中文已 `ensure_ascii=False`，UTF-8）
- **CORS**：`allow_origins=["*"]`，浏览器跨域可直接调用
- **错误格式**：FastAPI 标准错误 `{"detail": "..."}`；自定义错误码见下表
- **认证**：当前无鉴权（仅绑定 127.0.0.1 默认；对外部署需自行加反向代理/网关）
- **数据时区**：统一东八区（`TIMEZONE=Asia/Shanghai`），`as_of` / `trade_date` 均为 `YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS` 字符串
- **数值约定**：`price` 元、`pct_change` / `turnover` 为百分数数值（`5.32` 表示 +5.32%）、`amount_yi` 亿元、`volume_ratio` 量比。行情字段缺失时显式 `null`（如停牌 / 新浪源无量比）

### 1.3 错误码速查

| 状态码 | 场景 |
|---|---|
| 200 | 成功 |
| 400 | 业务校验失败（如非交易日调 `/brief/generate`） |
| 404 | 记录不存在（暂无新闻速递 / 简报 / 某代码无 K 线） |
| 422 | 请求体校验失败（非法代码、非法 kind、非法运算符等） |
| 503 | 行情/数据源暂不可用（部分端点降级为 422 提示"请稍后再试"） |
| 504 | K 线冷请求超过前台等待预算；已准入的后台刷新继续 |

### 1.4 数据源与降级策略

| 数据 | 主源 | 降级 |
|---|---|---|
| 实时快照 | 东财 push2（含量比/换手） | 新浪 hq（无量比/换手） |
| 异动榜单 | 东财 clist 服务端排序 | 新浪 Market_Center 排序 |
| 日 K | 新浪 | 东财 push2his → baostock 隔离子进程；TTL/stale cache + 有界 single-flight |
| 新闻速递 | 财联社 + 东财个股 | LLM 摘要失败 → 纯标题模板 |
| 结构化事件 | LLM 抽取 | 规则抽取（价格异动/涨停跌停关键词） |
| 触发解读 / 简报 | LLM | 确定性模板（正文末尾注明） |

---

## 2. 端点总表

| # | 方法 | 路径 | 说明 | 类型 |
|---|---|---|---|---|
| 1 | GET | `/health` | 健康检查 | 轻量 |
| 2 | POST | `/watchlist/add` | 加入自选 | 读写 |
| 3 | POST | `/watchlist/remove` | 移出自选 | 读写 |
| 4 | GET | `/watchlist` | 读取自选列表 | 读写 |
| 5 | GET | `/alerts` | 读取盯盘规则列表 | 读写 |
| 6 | POST | `/alerts` | 创建盯盘规则 | 读写 |
| 7 | DELETE | `/alerts/{rule_id}` | 删除盯盘规则 | 读写 |
| 8 | GET | `/overview` | 盯盘面板（自选行情 + 规则命中/逼近） | 轻量 |
| 9 | POST | `/scan` | 盘中异动扫描 | 轻量 |
| 10 | POST | `/tech-signal` | 个股技术信号 | 轻量 |
| 11 | POST | `/news/express` | 跑一轮新闻速递并落库 | 读写 |
| 12 | GET | `/news/latest` | 最近一份新闻速递 | 轻量 |
| 13 | GET | `/news/flash` | 实时快讯流（跨源聚合） | 轻量 |
| 14 | GET | `/news/events` | 结构化投资事件（LLM 抽取） | 轻量 |
| 15 | GET | `/news/event-alerts` | 事件预警中心（命中自选/持仓） | 轻量 |
| 16 | POST | `/brief/generate` | 生成盘前/盘后简报 | 读写 |
| 17 | GET | `/brief/latest` | 最近一份简报 | 轻量 |
| 18 | GET | `/scheduler/status` | 调度器状态 | 轻量 |
| 19 | POST | `/scheduler/tick` | 手动跑一轮盯盘评估 | 轻量 |

---

## 3. 自选

### 3.1 GET /watchlist —— 读取自选列表

```jsonc
// 200
{
  "items": [
    { "code": "600519", "name": "贵州茅台", "added_at": "2026-08-20 09:12:33" }
  ],
  "count": 1
}
```

### 3.2 POST /watchlist/add —— 加入自选

**请求体（WatchAddRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | ✅ | 6 位数字代码（如 `600519`），非法返回 422 |
| `name` | string | | 显示名，缺省用行情快照自动补全，再兜底用代码 |

```jsonc
POST /watchlist/add
{ "code": "600519", "name": "贵州茅台" }
// 200（已存在时为 duplicate: true，不重复写入）
{ "ok": true, "duplicate": false, "code": "600519", "name": "贵州茅台" }
```

### 3.3 POST /watchlist/remove —— 移出自选

```jsonc
POST /watchlist/remove
{ "code": "600519" }
// 200（不存在时 removed: false）
{ "ok": true, "removed": true, "code": "600519" }
```

---

## 4. 盯盘规则（条件告警）

### 4.1 规则结构（AlertRule）

```jsonc
{
  "name": "涨超5%提醒",
  "ticker": "600519",            // 可空：空 = 作用于全部自选
  "enabled": true,
  "time_frame": "trading",       // trading（仅交易时段）/ anytime（全天）
  "combine": "and",              // and（全条件命中）/ or（任一命中）
  "conditions": [
    { "field": "pct_change", "operator": ">", "value": 5 }
  ],
  "cooldown_min": 30,            // 冷却分钟数（0 = 不限）
  "daily_cap": 5                 // 当日上限次数（0 = 不限）
}
```

`conditions[].field` 枚举：

| field | 中文 | 单位 |
|---|---|---|
| `price` | 现价 | 元 |
| `pct_change` | 涨跌幅 | % 数值 |
| `volume_ratio` | 量比 | 无量纲 |
| `amount` | 成交额 | 亿元 |
| `turnover` | 换手率 | % 数值 |

`operator` ∈ `>` `>=` `<` `<=`。

### 4.2 GET /alerts —— 读取规则列表

```jsonc
// 200
{ "items": [ { "id": "ab12cd34ef56", "created_at": "2026-08-20 10:00:00", "name": "涨超5%提醒", "...": "见上" } ], "count": 1 }
```

### 4.3 POST /alerts —— 创建规则

服务端补 `id`（uuid hex 12 位）与 `created_at`；`ticker` 非空时校验为 6 位代码；`time_frame` / `combine` / `field` / `operator` 非法均返回 422。

```jsonc
POST /alerts
{ "name": "涨超5%提醒", "combine": "and", "conditions": [{ "field": "pct_change", "operator": ">", "value": 5 }], "cooldown_min": 30 }
// 200
{ "ok": true, "id": "ab12cd34ef56", "rule": { "...": "完整规则对象（含 id / created_at）" } }
```

### 4.4 DELETE /alerts/{rule_id} —— 删除规则

```jsonc
DELETE /alerts/ab12cd34ef56
// 200（不存在时 removed: false）
{ "ok": true, "removed": true, "id": "ab12cd34ef56" }
```

---

## 5. 盯盘面板 / 扫描 / 技术信号

### 5.1 GET /overview —— 盯盘面板

返回自选实时行情，并逐一评估启用规则：`hit` 为命中该股票的规则，`near` 为"逼近"（未命中但任一条件达到阈值 90% / 110%）。资金流并发拉取，失败为 `null`。

```jsonc
// 200
{
  "as_of": "2026-08-24 14:02:11",
  "trade_date": "2026-08-24",
  "items": [
    {
      "code": "600519", "name": "贵州茅台",
      "price": 1560.5, "pct_change": 5.32, "volume_ratio": 2.1,
      "turnover": 1.8, "amount_yi": 45.6, "fund_flow_yi": 2.31,
      "hit": [
        {
          "id": "ab12cd34ef56", "name": "涨超5%提醒",
          "condition_text": "涨跌幅% 高于 5",
          "results": [
            { "ok": true, "field": "pct_change", "operator": ">", "value": 5.32, "threshold": 5.0, "text": "涨跌幅% 高于 5" }
          ]
        }
      ],
      "near": []
    }
  ]
}
```

> 单条件缺失行情字段时（`results` 里该项为 `null`）该条件本轮跳过，不影响 `combine` 判定其他可用条件。

### 5.2 POST /scan —— 盘中异动扫描

**请求体（ScanRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | enum | ✅ | `gainers`（涨幅榜）/ `volume_ratio`（量比）/ `limit`（涨跌停）/ `turnover`（换手）/ `amount`（成交额） |
| `top_n` | int | | 返回条数，默认 10 |
| `min_amount_yi` | float | | 仅 `amount` 有效：最低成交额（亿元）过滤 |

```jsonc
POST /scan
{ "kind": "gainers", "top_n": 10 }
// 200（非 limit 类）
{
  "kind": "gainers", "trade_date": "2026-08-24", "as_of": "2026-08-24T14:02:11",
  "items": [
    { "code": "300750", "name": "宁德时代", "price": 218.5, "pct_change": 10.01, "volume_ratio": 3.2, "amount_yi": 88.1, "turnover": 2.9 }
  ]
}
// 200（kind=limit，返回涨跌停两表）
{
  "kind": "limit", "trade_date": "2026-08-24", "as_of": "2026-08-24T14:02:11",
  "limit_up":  [ { "...": "同 items 条目" } ],
  "limit_down": [ { "...": "同 items 条目" } ]
}
// 422（非法 kind 或行情源暂不可用）
{ "detail": "kind 必须是 ('gainers', 'volume_ratio', 'limit', 'turnover', 'amount') 之一，收到 'xxx'" }
```

### 5.3 POST /tech-signal —— 个股技术信号

**请求体（TechSignalRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | ✅ | 6 位代码 |
| `lookback` | int | | 回看 K 线根数，30–500，默认 120 |

```jsonc
POST /tech-signal
{ "code": "600519", "lookback": 120 }
// 200
{
  "code": "600519", "name": "贵州茅台", "as_of": "2026-08-24 14:02:11",
  "bars": 120,
  "last": { "date": "2026-08-24", "open": 1530.0, "close": 1560.5, "high": 1570.0, "low": 1520.0, "volume": 3200000, "amount": 4900000000 },
  "indicators": {
    "ma":       { "ma5": 1542.0, "ma10": 1528.0, "ma20": 1505.0, "ma60": 1480.0, "trend": "多头排列" },
    "macd":     { "dif": 0.82, "dea": 0.55, "hist": 0.54, "cross": "金叉" },
    "rsi":      { "rsi14": 58.3, "state": "正常" },
    "kdj":      { "k": 68.2, "d": 61.5, "j": 81.6, "cross": null },
    "boll":     { "upper": 1580.0, "mid": 1505.0, "lower": 1430.0, "band_pos": 0.72, "state": "轨道内" },
    "support_resistance": { "support": 1430.0, "resistance": 1580.0, "pos": 0.72 },
    "pattern":  { "pattern": null, "vol_ratio": 1.2 }
  },
  "signals": [ "MA 多头排列（5/10/20/60: 1542.0/1528.0/1505.0/1480.0）", "MACD 金叉（DIF 0.82 / DEA 0.55）", "支撑 1430.0 / 压力 1580.0（区间位置 0.72）" ]
}
// 404（无 K 线数据）
{ "detail": "600519 无 K 线数据" }
```

> 各指标子对象字段不足数据时自动置 `null` / 默认文案（`trend: "数据不足"` 等），`signals` 数组为人类可读信号行（供直接渲染 / LLM 上下文）。
>
> K 线按 `code+lookback` 使用 60 秒 fresh cache、30 分钟 stale cache 和 single-flight。stale 命中会立即返回并后台刷新；无缓存冷请求最多前台等待 2.5 秒，超时返回 `504`，唯一后台刷新仍会继续，稍后重试可命中缓存。后台最多准入 4 个不同 key，容量已满且没有 stale 时返回 `503`，不会进入无界队列。baostock fallback 在独立子进程运行，超过 2 秒会被父进程终止。技术信号名称补全最多另等 0.3 秒，超时仅使 `name` 为空，不阻塞指标返回。

---

## 6. 新闻

### 6.1 POST /news/express —— 跑一轮新闻速递

财联社要闻 + 自选股个股新闻 → LLM 摘要 → 落库（`news/{id}` + `latest` 指针）。LLM 不可用降级纯标题模板。**推送由调度侧负责，本端点不推送。**

```jsonc
POST /news/express
// 200
{
  "id": "20260824140211",
  "generated_at": "2026-08-24 14:02:11",
  "trade_date": "2026-08-24",
  "digest": "## 市场要闻总览\n……（Markdown）",
  "global_count": 8, "stock_count": 3,
  "items": {
    "global": ["标题1", "标题2"],
    "stocks": { "600519": ["茅台相关新闻标题"] }
  }
}
```

### 6.2 GET /news/latest —— 最近一份速递

```jsonc
// 200：同 POST /news/express 记录结构
// 404（尚未生成）
{ "detail": "暂无新闻速递，先调 POST /news/express" }
```

### 6.3 GET /news/flash —— 实时快讯流

**Query**：`limit`（5–100，默认 30）、`enrich`（0/1，默认 0）、`personal`（0/1，默认 0）。

- `enrich=0`：基础首屏档，只拉新浪财经与财联社；1.5 秒总体 deadline 到达时返回已完成来源，不进入 LLM
- `enrich=1`：显式完整档，访问全部配置来源，每项附加 `event`（结构化事件，如已抽取）与 `matched`（命中自选/持仓时为 `"hit"`，否则 `""`），可能等待可选 LLM
- `personal=1`：命中项置顶（个性化排序），须配合 `enrich=1` 才有意义

基础档使用 15 秒 fresh cache 与 5 分钟 stale cache；过期但仍可用的缓存会立即返回，同时只启动一个后台 refresh。refresh 在首屏 deadline 发布部分快照后仍保持 single-flight，直到固定来源池中的有时限 provider 全部结束；完整档同样使用独立 cache 和 10 秒首个快照 deadline。只有完整刷新能替换已有 stale cache，部分刷新不会删除旧缓存中的来源，也不会伪装成完整结果。应用关闭时会停止准入并等待这些有界 worker 收敛。

```jsonc
GET /news/flash?limit=30
// 200
{
  "as_of": "2026-08-24 14:02:11",
  "sources": ["财联社", "新浪财经"],
  "tier": "base", "complete": true, "stale": false,
  "items": [
    { "id": "sina-123", "time": "2026-08-24 14:01:50", "tag": "新浪财经",
      "title": "快讯标题", "content": "快讯全文……", "source": "新浪财经", "url": "https://..." }
  ]
}
// enrich=1 时 items 条目追加
{ "event": { "id": "ev-...", "type": "价格异动", "tickers": [{"name": "宁德时代", "code": "300750"}], "direction": "利好", "summary": "..." }, "matched": "hit" }
```

### 6.4 GET /news/events —— 结构化投资事件

快讯 → LLM 抽取（类型/涉及个股/行业/方向/摘要），LLM 不可用自动降级规则抽取。`direction` ∈ `利好` / `利空` / `中性`。

```jsonc
GET /news/events?limit=30
// 200
{
  "as_of": "2026-08-24 14:02:11", "count": 5,
  "items": [
    { "id": "ev-a1b2c3d4e5", "item_id": "cls-abc", "type": "政策",
      "tickers": [ { "name": "宁德时代", "code": "300750" } ],
      "industries": ["电池"],
      "direction": "利好",
      "summary": "工信部发布锂电池行业新规",
      "title": "快讯标题", "time": "2026-08-24 14:01:50", "source": "财联社", "url": "" }
  ]
}
```

> `tickers[].code` 为名称解析结果；未指明公司时为 `""`。`type` 枚举：`公告` / `业绩` / `价格异动` / `政策` / `产业` / `合作` / `评级` / `宏观` / `相关` / `其他`。

### 6.5 GET /news/event-alerts —— 事件预警中心

命中自选（`watch`）/ 持仓（`hold`）的事件列表，时间倒序保留 50 条。持仓来源为 trading-core `:8000/holdings`（TTL 60s，失败降级为仅自选）。

```jsonc
GET /news/event-alerts
// 200
{
  "as_of": "2026-08-24 14:02:11",
  "items": [
    { "id": "ev-a1b2c3d4e5", "code": "300750", "name": "宁德时代",
      "event_type": "政策", "direction": "利好", "summary": "工信部发布锂电池行业新规",
      "time": "2026-08-24 14:01:50", "source": "财联社", "url": "",
      "hit": "watch" }        // watch / hold / both
  ],
  "watch": ["600519", "300750"],
  "hold": []
}
```

---

## 7. 简报

### 7.1 POST /brief/generate —— 生成盘前/盘后简报

**请求体（BriefRequest）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `period` | enum | ✅ | `pre`（盘前）/ `post`（盘后） |
| `manual` | boolean | | 绕过非交易日守卫（仅测试用），默认 `false` |

```jsonc
POST /brief/generate
{ "period": "pre" }
// 200
{
  "id": "pre-20260824-080233",
  "period": "pre",
  "generated_at": "2026-08-24 08:02:33",
  "trade_date": "2026-08-24",
  "content": "## 市场状态\n- 上证指数 3421.50（+0.31%）\n……（Markdown 简报）",
  "llm_used": true
}
// 422（非法 period）
{ "detail": "period 必须为 pre 或 post" }
// 400（非交易日且非 manual）
{ "detail": "非交易日，生成简报无意义；manual 可强制（仅测试）" }
```

> 盘前 `pre`：指数状态 + 自选隔夜/实时涨跌 + 要闻 → LLM「今日关注点」；盘后 `post`：自选当日表现 + 当日触发记录 + 主力资金流 + 要闻 → LLM「复盘 + 明日关注」。LLM 不可用回退纯数据模板。结果落 `briefs/{id}` + `latest-{period}` 指针（按 period 分别存）。

### 7.2 GET /brief/latest —— 最近一份简报

**Query**：`period`（`pre` / `post`，默认 `pre`）。

```jsonc
GET /brief/latest?period=pre
// 200：同 POST /brief/generate 记录结构
// 404
{ "detail": "暂无 pre 简报，先调 POST /brief/generate" }
```

---

## 8. 调度器

### 8.1 GET /scheduler/status —— 调度器状态

```jsonc
// 200
{
  "running": true,
  "schedule_enabled": true,
  "jobs": [
    { "id": "watch-poll", "next_run": "2026-08-24 14:03:30+08:00" },
    { "id": "news-express", "next_run": "2026-08-24 15:00:00+08:00" },
    { "id": "pre-brief", "next_run": "2026-08-25 08:50:00+08:00" },
    { "id": "post-brief", "next_run": "2026-08-24 15:30:00+08:00" }
  ]
}
```

> 4 类定时 job 全部受交易日守卫、默认 OFF（`.env` 开启）：`watch-poll`（盘中轮询，`poll_interval` 秒）、`news-express`（新闻速递）、`pre-brief` / `post-brief`（简报 Cron）。

### 8.2 POST /scheduler/tick —— 手动跑一轮盯盘

绕时段守卫（夜间可测），冷却 / 当日上限仍生效。

```jsonc
POST /scheduler/tick
// 200（交易时段内）
{
  "evaluated": 12,
  "triggered": [
    { "date": "2026-08-24", "ts": "2026-08-24T14:03:30", "rule_id": "ab12cd34ef56",
      "rule_name": "涨超5%提醒", "code": "600519", "name": "贵州茅台",
      "value": 5.32, "price": 1560.5, "condition_text": "涨跌幅% 高于 5" }
  ],
  "skipped_cooldown": 0, "skipped_cap": 1,
  "push_results": []
}
// 200（非交易时段）
{ "evaluated": 0, "triggered": [], "skipped_cooldown": 0, "skipped_cap": 0, "push_results": [], "reason": "非交易时段" }
```

> 触发后推送（Server酱 / 企业微信）受 `MW_PUSH_ENABLED` 控制，`push_results` 为各通道推送结果。

---

## 9. 数据结构速查（TypeScript 视角，供前端对齐）

### 9.1 行情条目（QuoteRow）

```ts
interface QuoteRow {
  code: string
  name: string
  price: number | null            // 元
  pct_change: number | null       // 百分数数值（5.32 = +5.32%）
  volume_ratio: number | null     // 量比（新浪源为 null）
  turnover: number | null         // 换手率 %（新浪源为 null）
  amount_yi: number | null        // 成交额 亿元
  volume: number | null           // 成交量（东财=手，新浪=股，仅内部比较注意）
}
```

### 9.2 盯盘规则

```ts
interface AlertCondition { field: 'price' | 'pct_change' | 'volume_ratio' | 'amount' | 'turnover'; operator: '>' | '>=' | '<' | '<='; value: number }
interface AlertRule {
  id?: string
  name: string
  ticker?: string                 // 空 = 全部自选
  enabled: boolean
  time_frame: 'trading' | 'anytime'
  combine: 'and' | 'or'
  conditions: AlertCondition[]
  cooldown_min: number
  daily_cap: number
  created_at?: string
}
interface RuleHit { id: string; name: string; condition_text: string; results: Array<ConditionResult | null> }
interface ConditionResult { ok: boolean; field: string; operator: string; value: number; threshold: number; text: string }
```

### 9.3 快讯 / 事件

```ts
interface FlashItem {
  id: string; time: string; tag: string
  title: string; content: string; source: string; url: string
  event?: EventItem | null        // enrich=1 时
  matched?: string                // enrich=1 时："hit" | ""
}
interface EventItem {
  id: string; item_id: string; type: string
  tickers: Array<{ name: string; code: string }>
  industries: string[]
  direction: '利好' | '利空' | '中性'
  summary: string; title: string; time: string; source: string; url: string
}
interface EventAlertItem {
  id: string; code: string; name: string
  event_type: string; direction: string; summary: string
  time: string; source: string; url: string
  hit: 'watch' | 'hold' | 'both'
}
```

### 9.4 简报 / 速递

```ts
interface ExpressRecord {
  id: string; generated_at: string; trade_date: string
  digest: string
  global_count: number; stock_count: number
  items: { global: string[]; stocks: Record<string, string[]> }
}
interface BriefRecord {
  id: string; period: 'pre' | 'post'
  generated_at: string; trade_date: string
  content: string                 // Markdown 简报正文
  llm_used: boolean
}
```

---

## 10. 与宿主工具 / 前端的映射

| 宿主侧 | 底层端点 |
|---|---|
| 自选增删查 | POST `/watchlist/add`、POST `/watchlist/remove`、GET `/watchlist` |
| 规则告警管理 | GET/POST `/alerts`、DELETE `/alerts/{id}` |
| 盯盘面板 | GET `/overview` |
| 异动扫描 | POST `/scan` |
| 技术信号 | POST `/tech-signal` |
| 新闻速递 | POST `/news/express`、GET `/news/latest` |
| 实时快讯流（首页 / 盯盘页轮询） | GET `/news/flash`（`enrich=1`） |
| 事件预警中心（首页） | GET `/news/event-alerts` |
| 事件源（供 trading-core 策略研究消费） | GET `/news/events` |
| 盘前/盘后简报 | POST `/brief/generate`、GET `/brief/latest` |
| 调度器状态 / 手动盯盘 | GET `/scheduler/status`、POST `/scheduler/tick` |

> **跨模块消费**：trading-core 的 `POST /strategies/hypothesize` 直接 HTTP 调本模块 `GET /news/events` 作为事件源（TTL 缓存，失败降级返回 0 候选）。持仓命中（`/news/event-alerts` 的 `hold`）来自 trading-core `:8000/holdings`。

### 10.1 dsh 插件工具（`backend/market-watch/dsh-plugin/`，`mw_` 前缀，全同步）

| dsh 插件工具 | 底层端点 |
|---|---|
| `mw_flash` | GET `/news/flash`（limit） |
| `mw_events` | GET `/news/events`（limit） |
| `mw_event_alerts` | GET `/news/event-alerts`（limit） |
| `mw_overview` | GET `/overview` |
| `mw_scan` | POST `/scan`（kind: gainers/volume_ratio/limit/turnover/amount） |
| `mw_tech_signal` | POST `/tech-signal`（code） |
| `mw_latest_brief` | GET `/brief/latest` |

---

## 11. 状态与数据持久化

- **内存态**：行情快照（TTL 默认 60s）、K 线、名称索引、事件 TTL 缓存、快讯 8s 缓存、持仓 60s 缓存 —— 重启即失，自动重建。
- **本地 JSON 文件**（`market-watch/data/*.json`，原子写、线程安全）：
  - `watchlist` → key `watchlist/default`
  - `alerts` → key `alerts/default`
  - `news/{id}` + `news/latest` 指针
  - `briefs/{id}` + `briefs/latest-pre` / `latest-post` 指针
  - `events/latest`（最近 60 条结构化事件）、`events/seen_ids`（去重游标，200 条）
  - `event_alerts/latest`（最近 50 条预警）
  - `state/data`（触发记录 / 冷却时间戳 / 当日计数）
- 数据目录随仓库整体迁移；`MW_*` 配置见 `market_watch/config.py`。
