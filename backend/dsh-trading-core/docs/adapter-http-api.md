# dsh-trading-core 适配器 HTTP API 文档

> 适配器（`adapter/`）是 `dsh-trading-core` 对外提供的无状态 FastAPI 服务，封装了 TradingAgents-CN 多智能体引擎、持仓风险分析、市场简报与本地持久化能力。
>
> 本文档由 `adapter/app.py` + `adapter/schemas.py` + 各 runner 的实际产出契约整理而成，是 HTTP 客户端（`adapter_client/`）的实现依据。

- 默认 Base URL：`http://127.0.0.1:8000`
- 内容类型：`application/json; charset=utf-8`（除 SSE 流外）
- 鉴权：无（仅监听 127.0.0.1，CORS 全开，供本机 dsh 插件 / 客户端调用）
- 时间单位：金额为「元」，风险分 / 权重 / 波动率为 0~1 小数，HHI 为 0~1 小数

---

## 1. 接口总览

| # | 方法 | 路径 | 说明 | 返回类型 |
|---|---|---|---|---|
| 1 | GET | `/health` | 健康检查 | JSON |
| 2 | POST | `/analyze` | 启动个股多智能体分析 → `task_id` | JSON |
| 3 | POST | `/holdings/analyze` | 启动持仓风险分析（quick/deep）→ `task_id` | JSON |
| 4 | POST | `/holdings/save` | 保存持仓到本地 store | JSON |
| 5 | GET | `/watchlist` | 读取自选列表 | JSON |
| 6 | POST | `/watchlist` | 整体替换自选列表 | JSON |
| 7 | GET | `/risk_profile` | 读取当前风险偏好画像 | JSON |
| 8 | POST | `/risk_profile` | 持久化全局风险偏好 | JSON |
| 9 | POST | `/brief` | 启动盘前/盘后简报生成 → `task_id` | JSON |
| 10 | GET | `/brief/latest` | 读取最近一份简报 | JSON |
| 11 | POST | `/brief/{brief_id}/dsh-pushed` | 标记简报已推送（幂等） | JSON |
| 12 | GET | `/analyze/{task_id}` | 查询任务状态 | JSON |
| 13 | GET | `/analyze/{task_id}/stream` | SSE 进度流（stage/result/error/done） | `text/event-stream` |
| 14 | GET | `/analyze/{task_id}/result` | 取最终结果（未完成返回 409） | JSON |
| 15 | GET | `/kyc/profile` | 读取 KYC 现状 + 题组 schema + 阈值 + 各档护栏 | JSON |
| 16 | POST | `/kyc/questionnaire` | 提交风险问卷 → 计分 → 写入生效画像 | JSON |
| 17 | POST | `/kyc/adjust` | 滑块微调已推断画像 | JSON |
| 18 | POST | `/kyc/parse` | 整段自然语言/语音转写 → 结构化问卷答案 | JSON |

> 三个长任务（`/analyze`、`/holdings/analyze`、`/brief`）共用同一套 `task_id` + SSE + status + result 基础设施，路径前缀均为 `/analyze/{task_id}/...`。

---

## 2. 通用约定

### 2.1 任务生命周期

```
POST 启动  →  { "task_id": "<32 hex>" }
              │
              ▼
status: pending(罕见) → running → done / failed
              │
              ▼
SSE 事件序列：stage* → result → done   （成功）
              stage* → error  → done   （失败）
```

- `task_id`：32 位 hex（`uuid4().hex`），任务存在内存中，服务重启即丢失。
- 晚到的 SSE 订阅者：任务已 `done` 时，流会直接补发 `result` + `done`。
- SSE 心跳：服务端每 15s 发一个 `ping` 注释帧（无 `event` 字段，客户端应忽略）。

### 2.2 错误响应

| HTTP 状态 | 场景 | body |
|---|---|---|
| 404 | 任务/简报不存在 | `{"detail": "任务不存在"}` / `{"detail": "简报不存在"}` |
| 409 | 结果未就绪（`/analyze/{id}/result` 提前取） | `{"detail": "任务尚未完成"}` |
| 409 | `/kyc/adjust` 但尚未完成问卷 | `{"detail": "尚未完成风险问卷，请先提交问卷再微调"}` |
| 422 | 请求体校验失败（Pydantic）/ 问卷答案非法 / 解析空文本 | FastAPI 标准 422 |
| 500 | 引擎异常（已被捕获转 `failed`，通常不抛 500） | — |

### 2.3 风险偏好

`risk_profile` 取值：`conservative`（保守）/ `balanced`（稳健）/ `aggressive`（进取）。

**解析优先级**：调用参数 > 已保存偏好（`store.preferences.risk_profile`）> `.env` 的 `RISK_PROFILE` > `balanced`。

---

## 3. 接口详情

### 3.1 GET `/health`

健康检查，返回各任务 runner 的注册名。

**测试 curl**

```bash
curl http://127.0.0.1:8000/health
```

**响应** `200`

```json
{
  "status": "ok",
  "runners": {
    "stock": "tradingagents-cn",
    "holdings": "holdings-analyzer",
    "brief": "brief-engine"
  }
}
```

> `ADAPTER_RUNNER=fake` 时三者分别为 `fake` / `fake-holdings` / `fake-brief`，用于链路自测。

---

### 3.2 POST `/analyze` — 个股分析

启动多智能体个股分析（`analyze_stock` 工具）。引擎在 worker 线程同步执行，进度通过 SSE 推送。

**请求体** `AnalyzeRequest`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `ticker` | string | ✅ | — | 股票代码（`600519`）或名称（`贵州茅台`） |
| `date` | string | | `null` | 分析日期 `YYYY-MM-DD`，缺省取最近交易日 |
| `market` | string | | `"a_shares"` | 市场，缺省按代码自动识别 |
| `research_depth` | string | | `"standard"` | `quick`/`basic`/`standard`/`deep`/`full` |
| `config_overrides` | object | | `{}` | 会话级引擎配置覆盖（如 `max_debate_rounds`） |
| `risk_profile` | string | | `null` | `conservative`/`balanced`/`aggressive`，缺省用已保存偏好 |

`research_depth` → 引擎配置映射：

| depth | 分析师 | max_debate_rounds | max_risk_discuss_rounds | online_news | agent 节点预算 |
|---|---|---|---|---|---|
| quick | 市场 | 1 | 1 | false | 9 |
| basic | 市场、基本面 | 1 | 1 | false | 10 |
| standard | 市场、社媒、新闻、基本面 | 1 | 1 | false | 12 |
| deep | 市场、社媒、新闻、基本面 | 2 | 2 | false | 17 |
| full | 市场、社媒、新闻、基本面 | 3 | 3 | true | 22 |

adapter 分析的跨次记忆由 dsh 会话层持有，因此构图时固定 `memory_enabled=false`，不初始化 Chroma memory，也不发起 memory embedding 请求。

**测试入参**

```bash
# 场景1：最小入参（仅 ticker，其余用缺省）
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker":"600519"}'

# 场景2：完整入参（指定日期、深度、画像）
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "ticker":"600519",
    "name":"贵州茅台",
    "date":"2026-08-19",
    "market":"a_shares",
    "research_depth":"deep",
    "risk_profile":"balanced"
  }'

# 场景3：用名称代替代码 + quick 深度（快速验证链路）
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker":"贵州茅台","research_depth":"quick"}'

# 场景4：会话级覆盖（辩论 2 轮）
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "ticker":"000858",
    "config_overrides":{"max_debate_rounds":2,"max_risk_discuss_rounds":2}
  }'
```

> Windows PowerShell 用户请把单引号 `-d '...'` 改为双引号转义 `-d "{\"ticker\":\"600519\"}"`，或直接用 `curl.exe` 而非 `curl` 别名。

**响应** `200`

```json
{ "task_id": "9f3c1a2b4d5e6f7809a1b2c3d4e5f607" }
```

随后消费 `GET /analyze/{task_id}/stream` 取进度与最终结果。

---

### 3.3 POST `/holdings/analyze` — 持仓风险分析

启动持仓组合风险分析（`analyze_holdings` 工具）。

**两级分析：**
- **L1 定量（always）**：逐股 baostock 前复权日线 → 年化波动率 / 最大回撤 / β(vs 沪深300)；组合市值 / 成本 / 浮盈 / 权重 / 组合波动率 wᵀΣw / HHI 集中度 / 行业暴露。
- **L2 深度（`deep`）**：`ThreadPoolExecutor(3)` 并行逐股跑引擎 `quick` 深度 → 每股 `risk_score` / `action` / `confidence`。

**请求体** `HoldingsRequest`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `holdings` | `HoldingItem[]` | | `null` | 持仓列表；为空时回退已保存持仓 |
| `mode` | string | | `"deep"` | `quick`=仅定量风险(秒级) / `deep`=逐股引擎分析(慢) |
| `use_saved` | bool | | `true` | `holdings` 为空时是否回退到已保存持仓 |
| `risk_profile` | string | | `null` | `conservative`/`balanced`/`aggressive` |

**`HoldingItem`**

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `ticker` | string | — | 股票代码（`600519`） |
| `quantity` | number | `> 0` | 持仓数量（股） |
| `cost_price` | number | `>= 0` | 持仓成本价（元） |

**测试入参**

```bash
# 场景1：完整持仓 deep 分析（逐股引擎，慢）
curl -X POST http://127.0.0.1:8000/holdings/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "holdings":[
      {"ticker":"600519","quantity":100,"cost_price":1500},
      {"ticker":"000858","quantity":200,"cost_price":135},
      {"ticker":"300750","quantity":50,"cost_price":210}
    ],
    "mode":"deep",
    "risk_profile":"balanced"
  }'

# 场景2：quick 模式（仅定量风险，秒级，不跑引擎）
curl -X POST http://127.0.0.1:8000/holdings/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "holdings":[
      {"ticker":"600519","quantity":100,"cost_price":1500}
    ],
    "mode":"quick"
  }'

# 场景3：回退到已保存持仓（先调 /holdings/save 存一次）
curl -X POST http://127.0.0.1:8000/holdings/analyze \
  -H "Content-Type: application/json" \
  -d '{"mode":"quick","use_saved":true}'

# 场景4：保守画像下的多股 quick 分析
curl -X POST http://127.0.0.1:8000/holdings/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "holdings":[
      {"ticker":"601318","quantity":300,"cost_price":48.5},
      {"ticker":"600036","quantity":500,"cost_price":35.2}
    ],
    "mode":"quick",
    "risk_profile":"conservative"
  }'
```

**响应** `200`

```json
{ "task_id": "..." }
```

---

### 3.4 POST `/holdings/save` — 保存持仓

把持仓写入本地 store（`data/adapter/holdings.json` 的 `default` 键），供后续 `quick`/`deep` 分析 `use_saved` 回退使用。

**请求体**：同 `HoldingsRequest`（只用 `holdings` + `mode`）。

**测试入参**

```bash
# 场景1：保存 3 只持仓（之后可用 use_saved 回退）
curl -X POST http://127.0.0.1:8000/holdings/save \
  -H "Content-Type: application/json" \
  -d '{
    "holdings":[
      {"ticker":"600519","quantity":100,"cost_price":1500},
      {"ticker":"000858","quantity":200,"cost_price":135},
      {"ticker":"300750","quantity":50,"cost_price":210}
    ],
    "mode":"deep"
  }'

# 场景2：保存单只持仓
curl -X POST http://127.0.0.1:8000/holdings/save \
  -H "Content-Type: application/json" \
  -d '{"holdings":[{"ticker":"600519","quantity":100,"cost_price":1500}]}'

# 场景3：保存后立刻 quick 分析（一次保存 + 多次分析）
curl -X POST http://127.0.0.1:8000/holdings/save \
  -H "Content-Type: application/json" \
  -d '{"holdings":[{"ticker":"600519","quantity":100,"cost_price":1500}]}'
# 然后分析：
curl -X POST http://127.0.0.1:8000/holdings/analyze \
  -H "Content-Type: application/json" \
  -d '{"mode":"quick","use_saved":true}'
```

**响应** `200`

```json
{ "saved": 3, "mode": "deep" }
```

---

### 3.5 GET `/watchlist` — 读取自选

**测试 curl**

```bash
curl http://127.0.0.1:8000/watchlist
```

**响应** `200`

```json
{ "tickers": ["600519", "000858", "300750"] }
```

---

### 3.6 POST `/watchlist` — 替换自选

**请求体** `WatchlistRequest`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tickers` | string[] | ✅ | 自选股票代码列表（整体替换） |

**测试入参**

```bash
# 场景1：替换为 3 只白酒/新能源龙头
curl -X POST http://127.0.0.1:8000/watchlist \
  -H "Content-Type: application/json" \
  -d '{"tickers":["600519","000858","300750"]}'

# 场景2：单只自选
curl -X POST http://127.0.0.1:8000/watchlist \
  -H "Content-Type: application/json" \
  -d '{"tickers":["600519"]}'

# 场景3：清空自选（传空数组）
curl -X POST http://127.0.0.1:8000/watchlist \
  -H "Content-Type: application/json" \
  -d '{"tickers":[]}'
```

**响应** `200`

```json
{ "saved": 3 }
```

---

### 3.7 GET `/risk_profile` — 读取风险偏好

**测试 curl**

```bash
curl http://127.0.0.1:8000/risk_profile
```

**响应** `200`

```json
{ "risk_profile": "balanced", "label": "稳健型" }
```

三档 label：`conservative→保守型`、`balanced→稳健型`、`aggressive→进取型`。

---

### 3.8 POST `/risk_profile` — 设置风险偏好

持久化全局风险偏好（写入 `store.preferences.risk_profile`）。

**请求体** `RiskProfileRequest`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `risk_profile` | string | ✅ | `conservative`/`balanced`/`aggressive` |

**测试入参**

```bash
# 场景1：切换为保守型
curl -X POST http://127.0.0.1:8000/risk_profile \
  -H "Content-Type: application/json" \
  -d '{"risk_profile":"conservative"}'

# 场景2：切换为进取型
curl -X POST http://127.0.0.1:8000/risk_profile \
  -H "Content-Type: application/json" \
  -d '{"risk_profile":"aggressive"}'

# 场景3：切回稳健型
curl -X POST http://127.0.0.1:8000/risk_profile \
  -H "Content-Type: application/json" \
  -d '{"risk_profile":"balanced"}'
```

**响应** `200`

```json
{ "risk_profile": "aggressive", "label": "进取型" }
```

---

### 3.9 POST `/brief` — 生成市场简报

启动盘前/盘后简报生成（`market_brief` 工具）。流程：拉数据 → 规则挖机会点 → LLM 生成 Markdown → 落 store（`(period, trade_date)` 幂等）。

> ⚠️ 请**串行**调用（akshare 的 py_mini_racer V8 并发会崩适配器）。

**请求体** `BriefRequest`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `period` | string | | `"now"` | `pre_market`=盘前 / `post_market`=盘后 / `now`=盘中 |
| `scope` | string | | `"all"` | `market`/`industry`/`concept`/`news`/`watchlist`/`all` |
| `tickers` | string[] | | `null` | 覆盖自选股；为空用已保存 watchlist |
| `risk_profile` | string | | `null` | `conservative`/`balanced`/`aggressive` |

**测试入参**

```bash
# 场景1：盘后简报（最常用，all 范围）
curl -X POST http://127.0.0.1:8000/brief \
  -H "Content-Type: application/json" \
  -d '{"period":"post_market","scope":"all"}'

# 场景2：盘前简报
curl -X POST http://127.0.0.1:8000/brief \
  -H "Content-Type: application/json" \
  -d '{"period":"pre_market","scope":"all"}'

# 场景3：盘中简报（缺省即 now）
curl -X POST http://127.0.0.1:8000/brief \
  -H "Content-Type: application/json" \
  -d '{}'

# 场景4：仅自选股简报（覆盖 tickers）
curl -X POST http://127.0.0.1:8000/brief \
  -H "Content-Type: application/json" \
  -d '{"period":"post_market","scope":"watchlist","tickers":["600519","000858"]}'

# 场景5：保守画像下的盘后简报
curl -X POST http://127.0.0.1:8000/brief \
  -H "Content-Type: application/json" \
  -d '{"period":"post_market","scope":"all","risk_profile":"conservative"}'
```

> ⚠️ 请**串行**调用，不要并发跑多个 brief 任务（akshare 的 py_mini_racer V8 并发会崩适配器）。

**响应** `200`

```json
{ "task_id": "..." }
```

---

### 3.10 GET `/brief/latest` — 最近简报

**测试 curl**

```bash
curl http://127.0.0.1:8000/brief/latest
```

**响应** `200`

有简报时：

```json
{
  "id": "now:2026-08-19",
  "period": "now",
  "trade_date": "2026-08-19",
  "generated_at": "2026-08-19 15:30:00",
  "summary": "# 盘中简报 · 2026-08-19\n...",
  "opportunities": [
    { "kind": "northbound", "risk_level": "低", "title": "..." }
  ],
  "scope": "all",
  "risk_profile": "balanced",
  "dsh_pushed": false
}
```

无简报时（id=null，优雅降级）：

```json
{ "id": null, "period": null, "trade_date": null, "summary": null, "dsh_pushed": null }
```

记录存在但内容缺失：`404 {"detail": "简报记录缺失"}`。

---

### 3.11 POST `/brief/{brief_id}/dsh-pushed` — 标记已推送

幂等标记某份简报已在 dsh 对话内播报过（供 `brief-pusher` 去重）。

**路径参数**：`brief_id` = 简报 `id`（如 `now:2026-08-19`）。

**测试入参**

```bash
# 场景1：标记盘中简报已推送（先 GET /brief/latest 拿 id）
curl -X POST http://127.0.0.1:8000/brief/now:2026-08-19/dsh-pushed

# 场景2：标记盘后简报已推送
curl -X POST http://127.0.0.1:8000/brief/post_market:2026-08-19/dsh-pushed

# 场景3：幂等验证（重复调用应返回相同结果）
curl -X POST http://127.0.0.1:8000/brief/now:2026-08-19/dsh-pushed
```

> PowerShell 下 URL 中的 `:` 可能被解析，建议用引号包裹 URL：`curl.exe -X POST "http://127.0.0.1:8000/brief/now:2026-08-19/dsh-pushed"`。

**响应** `200`

```json
{ "id": "now:2026-08-19", "dsh_pushed": true }
```

不存在：`404 {"detail": "简报不存在"}`。

---

### 3.12 GET `/analyze/{task_id}` — 任务状态

**测试 curl**

```bash
# 场景1：查询任务状态（用 POST /analyze 返回的 task_id 替换）
curl http://127.0.0.1:8000/analyze/9f3c1a2b4d5e6f7809a1b2c3d4e5f607

# 场景2：轮询直到 done（bash while 循环）
TID=9f3c1a2b4d5e6f7809a1b2c3d4e5f607
while true; do
  S=$(curl -s http://127.0.0.1:8000/analyze/$TID | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  echo "status=$S"
  [ "$S" = "done" -o "$S" = "failed" ] && break
  sleep 2
done
```

**响应** `200`

```json
{
  "task_id": "...",
  "task_type": "stock",   // stock | holdings | brief
  "status": "running",     // pending | running | done | failed
  "error": null            // failed 时为错误信息
}
```

不存在：`404 {"detail": "任务不存在"}`。

---

### 3.13 GET `/analyze/{task_id}/stream` — SSE 进度流

`text/event-stream`，每 15s 心跳（`ping` 注释帧，无 `event`）。

**测试 curl**

```bash
# 场景1：消费完整 SSE 流（启动 /analyze 后立即订阅）
curl -N http://127.0.0.1:8000/analyze/9f3c1a2b4d5e6f7809a1b2c3d4e5f607/stream

# 场景2：限制最大等待时间 120s（避免长任务阻塞终端）
curl -N --max-time 120 http://127.0.0.1:8000/analyze/9f3c1a2b4d5e6f7809a1b2c3d4e5f607/stream

# 场景3：只看前 50 行（快速采样进度事件）
curl -N http://127.0.0.1:8000/analyze/9f3c1a2b4d5e6f7809a1b2c3d4e5f607/stream | head -n 50
```

> Windows PowerShell 下请使用 `curl.exe` 而非 `curl` 别名，否则 `-N` 流式输出会被 `Invoke-WebRequest` 缓冲：
> `curl.exe -N "http://127.0.0.1:8000/analyze/<task_id>/stream"`

**事件类型**

| event | data | 说明 |
|---|---|---|
| `stage` | `{"node": null, "message": "📊 基本面分析师：解读财报与估值… (node=fundamentals_analyst)"}` | 引擎进度消息（中文文本） |
| `result` | 最终结果载荷（见 §4） | 任务最终产出 |
| `error` | `{"message": "..."}` | 引擎异常信息 |
| `done` | `{}` | 流结束标记（成功/失败都发） |
| — (ping) | — | 心跳，忽略 |

**SSE 帧格式**（sse-starlette，`\n\n` 分隔）：

```
event: stage
data: {"node": null, "message": "🔍 市场分析师：分析技术趋势…", "ts": 1787107331.12}

event: result
data: {"signal": {...}, "reports": {...}, "performance_metrics": {}}

event: done
data: {}

```

**消费建议**：边收 `stage` 边回调（进度注入），收到 `result` 缓存最终结果，`done` 即可断流；`error` 抛错。晚到订阅者会立即收到 `result`+`done`。

不存在：`404 {"detail": "任务不存在"}`。

---

### 3.14 GET `/analyze/{task_id}/result` — 最终结果

**测试 curl**

```bash
# 场景1：取最终结果（任务 done 后才能取到，否则 409）
curl http://127.0.0.1:8000/analyze/9f3c1a2b4d5e6f7809a1b2c3d4e5f607/result

# 场景2：未完成时取（返回 409，配合轮询用）
TID=9f3c1a2b4d5e6f7809a1b2c3d4e5f607
while true; do
  R=$(curl -s -w "\n%{http_code}" http://127.0.0.1:8000/analyze/$TID/result)
  CODE=$(echo "$R" | tail -1)
  if [ "$CODE" = "200" ]; then echo "$R" | head -1; break; fi
  sleep 3
done
```

**响应** `200`：见 §4 各 `task_type` 的结果载荷。

**状态约束**：任务未完成返回 `409 {"detail": "任务尚未完成"}`；不存在返回 `404`。

> 推荐：优先消费 SSE 的 `result` 帧；`/result` 适合「事后取」场景（如简报拉取后回查）。

---

### 3.15 GET `/kyc/profile` — KYC 现状

返回 KYC 记录 + 题组 schema + 计分阈值 + 各档护栏，是产品壳 `#/kyc` 渲染的唯一事实源。

**测试 curl**

```bash
curl http://127.0.0.1:8000/kyc/profile
```

**响应** `200`

```jsonc
{
  "status": "not_started",          // not_started | completed | adjusted
  "inferred_profile": null,         // 问卷/语音推断画像（不被微调污染）
  "effective_profile": "balanced",  // 当前生效画像（risk_profile）
  "effective_label": "稳健型",
  "score": null,                    // 问卷原始总分
  "answers": [],
  "manual_adjust": null,            // 滑块微调记录
  "completed_at": null,
  "method": null,                   // questionnaire | voice
  "voice_source": null,
  "last_profile": null,             // 上次画像
  "tiers": { "quick": ["horizon", "loss_tolerance", "goal"], "full": [8 个 qid] },
  "question_bank": { "horizon": { "qid": "horizon", "title": "...", "options": [{"label", "score"}] }, ... },
  "bands": { "conservative": {"min": 1, "max": 18, ...}, "balanced": {...}, "aggressive": {...} },
  "profile_labels": { "conservative": "保守型", "balanced": "稳健型", "aggressive": "进取型" },
  "profiles_detail": { "conservative": { "label", "desc", "risk_budget", "risk_bands", "guardrail", "brief_max_risk" }, ... }
}
```

---

### 3.16 POST `/kyc/questionnaire` — 提交风险问卷

计分后写入 `preferences.kyc`（全新记录，清空此前滑块微调）并更新 `preferences.risk_profile`（即生效画像）。

**请求体** `KycQuestionnaireRequest`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `answers` | `KyAnswer[]` | ✅ | — | 覆盖该档全部题目的答案 |
| `tier` | string | ✅ | — | `quick`（3 题）/ `full`（8 题） |
| `method` | string | | `"questionnaire"` | `questionnaire` / `voice` |
| `voice_source` | string | | `null` | 语音作答时保存的原始转写 |

**`KyAnswer`**：`{ qid: string, label: string, score: 1-5 }`（`qid` 与 `label` 必须在题组内，否则 422）。

**测试 curl**（Windows 下可用 `curl.exe --data-binary @body.json` 传 UTF-8 中文，避免命令行编码问题）

```bash
# 场景1：三问速测（全部保守答案 → 保守型）
curl -X POST http://127.0.0.1:8000/kyc/questionnaire \
  -H "Content-Type: application/json" \
  -d '{
    "tier":"quick",
    "answers":[
      {"qid":"horizon","label":"3个月以内","score":1},
      {"qid":"loss_tolerance","label":"不能接受亏损，保本第一","score":1},
      {"qid":"goal","label":"本金安全，稳定跑赢存款","score":1}
    ]
  }'

# 场景2：完整 8 题（全部进取答案 → 进取型，满分 40）
curl -X POST http://127.0.0.1:8000/kyc/questionnaire \
  -H "Content-Type: application/json" \
  -d '{
    "tier":"full",
    "method":"voice",
    "voice_source":"我很能承担风险，全部选最激进",
    "answers":[{"qid":"horizon","label":"5年以上","score":5}, ... 其余 7 题同理 ...]
  }'
```

**响应** `200`

```json
{
  "profile": "conservative",
  "label": "保守型",
  "score": 3,
  "inferred_profile": "conservative",
  "mapping": { "conservative": {"min": 1, "max": 7}, "balanced": {"min": 8, "max": 11}, "aggressive": {"min": 12, "max": 15} }
}
```

答案缺题 / `qid`/`label`/`score` 非法：`422 {"detail": "问卷缺少题目: ..."}`。

---

### 3.17 POST `/kyc/adjust` — 滑块微调

在问卷推断画像基础上微调生效画像，保留 `kyc.inferred_profile`。需先完成问卷，否则 `409`。

**请求体** `KycAdjustRequest`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `risk_tolerance` | number | | `0.5` | 风险承受能力 0~1（0=保守 / 0.5=稳健 / 1=进取） |
| `horizon_years` | number | | `3` | 投资期限（年），辅助约束：<2 年最多到稳健，≥5 年至少稳健 |
| `note` | string | | `""` | 调整说明 |

**测试 curl**

```bash
# 场景1：偏激进（0.8 → 进取型）
curl -X POST http://127.0.0.1:8000/kyc/adjust \
  -H "Content-Type: application/json" \
  -d '{"risk_tolerance":0.8,"horizon_years":3,"note":"提高风险承受"}'

# 场景2：激进但仅 1 年（期限约束 → 封顶稳健型）
curl -X POST http://127.0.0.1:8000/kyc/adjust \
  -H "Content-Type: application/json" \
  -d '{"risk_tolerance":0.9,"horizon_years":1}'
```

**响应** `200`

```json
{ "profile": "aggressive", "label": "进取型", "manual_adjust": {"risk_tolerance": 0.8, "horizon_years": 3, "note": "提高风险承受"} }
```

未完成问卷：`409 {"detail": "尚未完成风险问卷，请先提交问卷再微调"}`。

---

### 3.18 POST `/kyc/parse` — 自然语言 → 问卷答案

把整段自然语言（语音转写 / 手打）解析为结构化问卷答案，供前端预填后由用户确认提交。有 `DEEPSEEK_API_KEY` 走 LLM，否则降级到中文关键词规则。

**请求体** `KycParseRequest`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✅ | 自然语言描述（非空） |

**测试 curl**

```bash
curl -X POST http://127.0.0.1:8000/kyc/parse \
  -H "Content-Type: application/json" \
  -d '{"text":"我的钱要放三年以上，能接受20%左右亏损，希望稳健增值，收入稳定，有三四年投资经验，亏了能拿住，比较懂股票风险，偏好股债均衡配置"}'
```

**响应** `200`

```jsonc
{
  "answers": [
    { "qid": "horizon", "label": "3-5年", "score": 4 },
    { "qid": "loss_tolerance", "label": "20%左右", "score": 4 },
    ...  // 无法判断的题目省略
  ],
  "text": "我的钱要放三年以上，...",
  "source": "llm"        // llm | rules
}
```

空文本：`422 {"detail": "文本不能为空"}`。

---

## 4. 结果载荷契约（`result` / `/result`）

所有 runner 产出统一三段式：`{ signal, reports, performance_metrics }`。

### 4.1 个股分析（`task_type=stock`，`signal.signal_type="final"`）

```jsonc
{
  "signal": {
    "signal_type": "final",
    "ticker": "600519",
    "company_name": "贵州茅台",
    "action": "买入",            // 买入 | 卖出 | 持有
    "target_price": 1560.0,      // 目标价（元）
    "confidence": 0.75,          // 置信度 0~1
    "risk_score": 0.4,           // 风险分 0~1
    "reasoning": "决策理由文本…",
    "model_info": null,          // 模型信息（可选）
    "risk_profile": "balanced",
    "calibration": false,        // 是否经风险偏好护栏修正
    "calibration_note": null     // 修正说明（修正时非空）
  },
  "reports": {                   // 各 agent 分步报告（Markdown 字符串，缺省键不出现）
    "market": "...",
    "fundamentals": "...",
    "news": "...",
    "sentiment": "...",
    "debate": "...",
    "trader": "...",
    "risk": "..."
  },
  "performance_metrics": {}
}
```

> 风险偏好护栏：保守档下「买入」且 `risk_score > buy_risk_score_max` → 降级为「持有」；进取档下「卖出」且 `risk_score < sell_risk_score_min` → 降级为「持有」。

### 4.2 持仓分析（`task_type=holdings`，`signal.signal_type="portfolio"`）

```jsonc
{
  "signal": {
    "signal_type": "portfolio",
    "holdings": [{"ticker": "600519", "quantity": 100, "cost_price": 1500}],
    "mode": "deep",
    "risk_profile": "balanced",
    "total_market_value": 200000.0,
    "total_cost": 180000.0,
    "floating_pnl": 20000.0,
    "floating_pnl_pct": 0.1111,
    "weighted_risk_score": 0.45,
    "portfolio_annualized_vol": 0.18,
    "concentration_hhi": 0.33,
    "sector_exposure": [{"industry": "食品饮料", "weight": 0.5}],
    "risk_breaches": [            // 超风险预算项
      {"indicator": "single_stock_weight", "label": "600519", "value": 0.5, "limit": 0.25, "excess": 0.25}
    ],
    "rebalance_suggestions": ["建议减持 600519，使权重降至 25% 以内（当前 50.0%）"],
    "n_positions": 3,
    "per_stock": {
      "600519": {
        "name": "贵州茅台",
        "quantity": 100,
        "cost_price": 1500,
        "last_price": 1560.0,
        "market_value": 156000.0,
        "floating_pnl": 6000.0,
        "weight": 0.78,
        "annualized_vol": 0.22,
        "max_drawdown": 0.35,
        "beta": 0.9,
        "industry": "食品饮料",
        "risk_score": 0.4,        // deep 才有，quick 为 null
        "risk_level": "中",        // 低 | 中 | 高（按画像 bands）
        "action": "买入",         // deep 才有
        "confidence": 0.7,        // deep 才有
        "reasoning": "..."        // deep 才有
      }
    }
  },
  "reports": { "portfolio": "# 持仓风险分析报告\n..." },
  "performance_metrics": {}
}
```

`risk_breaches.indicator` 取值：`single_stock_weight` / `beta` / `portfolio_vol` / `hhi`。

### 4.3 市场简报（`task_type=brief`，`signal.signal_type="brief"`）

```jsonc
{
  "signal": {
    "signal_type": "brief",
    "period": "now",
    "trade_date": "2026-08-19",
    "summary": "# 盘中简报 · 2026-08-19\n...",
    "opportunities": [
      {"kind": "northbound", "risk_level": "低", "title": "沪市净流入 25.3 亿"}
    ],
    "risk_profile": "balanced"
  },
  "reports": { "brief": "# 盘中简报 · 2026-08-19\n..." },
  "performance_metrics": {}
}
```

`opportunities.kind` 取值：`northbound` / `watchlist_move` / `sector` / `news_event` / `lhb` / `market_heat` / `market_risk`；
`risk_level`：低 / 中 / 高，已按画像 `brief_max_risk` 过滤（保守档只保留 ≤中）。

---

## 5. 风险偏好画像（参考）

| 档位 | label | 组合波动率上限 | HHI 上限 | 单股权重上限 | β 上限 | 简报最大风险 |
|---|---|---|---|---|---|---|
| conservative | 保守型 | 0.12 | 0.20 | 0.15 | 0.80 | medium(中) |
| balanced | 稳健型 | 0.18 | 0.30 | 0.25 | 1.00 | high(高) |
| aggressive | 进取型 | 0.30 | 0.50 | 0.40 | 1.50 | high(高) |

护栏：保守档 `buy_risk_score_max=0.50`；进取档 `sell_risk_score_min=0.30`。

---

## 6. 典型调用流程

### 6.1 个股分析（SSE 全流程）

```
1. POST /analyze  body={ticker:"600519", risk_profile:"balanced"}
   → {task_id}
2. GET /analyze/{task_id}/stream
   收 stage*  → on_stage(msg)  // 进度注入
   收 result  → 缓存 final
   收 done    → 断流
   （error   → 抛错）
3. final = {signal, reports, performance_metrics}
```

### 6.2 持仓快速体检（无 SSE 也可）

```
1. POST /holdings/save  body={holdings:[...], mode:"deep"}  // 一次保存
2. POST /holdings/analyze body={mode:"quick", use_saved:true} → {task_id}
3. GET /analyze/{task_id}/result  // 等 status=done 后取（或直接消费 SSE）
```

### 6.3 市场简报按需生成

```
1. POST /brief  body={period:"post_market", scope:"all"} → {task_id}
2. 消费 SSE 取 result.signal.summary  // 或 GET /brief/latest 回查
3. POST /brief/{brief_id}/dsh-pushed  // 标记已推送，避免重复
```

### 6.4 一键端到端测试脚本（bash）

把下面保存为 `e2e_test.sh`，启动适配器后执行 `bash e2e_test.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE=http://127.0.0.1:8000

echo "=== 1. 健康检查 ==="
curl -s $BASE/health; echo

echo "=== 2. 保存持仓 ==="
curl -s -X POST $BASE/holdings/save \
  -H "Content-Type: application/json" \
  -d '{"holdings":[{"ticker":"600519","quantity":100,"cost_price":1500}]}'; echo

echo "=== 3. 设置自选 ==="
curl -s -X POST $BASE/watchlist \
  -H "Content-Type: application/json" \
  -d '{"tickers":["600519","000858"]}'; echo

echo "=== 4. 切换风险偏好 ==="
curl -s -X POST $BASE/risk_profile \
  -H "Content-Type: application/json" \
  -d '{"risk_profile":"balanced"}'; echo

echo "=== 5. 启动个股分析 ==="
TID=$(curl -s -X POST $BASE/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker":"600519","research_depth":"quick"}' \
  | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)
echo "task_id=$TID"

echo "=== 6. 消费 SSE 进度流（max 60s）==="
curl -N --max-time 60 $BASE/analyze/$TID/stream | head -n 30

echo "=== 7. 查任务状态 ==="
curl -s $BASE/analyze/$TID; echo

echo "=== 8. 取最终结果 ==="
curl -s $BASE/analyze/$TID/result; echo

echo "=== 9. quick 持仓分析（用已保存持仓）==="
HTID=$(curl -s -X POST $BASE/holdings/analyze \
  -H "Content-Type: application/json" \
  -d '{"mode":"quick","use_saved":true}' \
  | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)
curl -N --max-time 30 $BASE/analyze/$HTID/stream | head -n 20

echo "=== 10. 生成盘后简报 ==="
BTID=$(curl -s -X POST $BASE/brief \
  -H "Content-Type: application/json" \
  -d '{"period":"post_market","scope":"all"}' \
  | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)
curl -N --max-time 60 $BASE/analyze/$BTID/stream | head -n 20

echo "=== 11. 取最近简报 ==="
curl -s $BASE/brief/latest; echo

echo "=== E2E 测试完成 ==="
```

> Windows 用户可在 PowerShell 下用 `curl.exe` 替代 `curl`，并手动设置 `$TID = ...` 变量。

---

## 7. Python 客户端

本仓库提供同步 HTTP 客户端模块 `adapter_client`（基于 `requests`，无新依赖），封装上述全部接口：

```python
from adapter_client import TradingCoreClient, HoldingItem

client = TradingCoreClient("http://127.0.0.1:8000")

# 一站式：启动 + 消费 SSE + 返回最终结果（阻塞）
result = client.run_analysis(
    ticker="600519", risk_profile="balanced",
    on_stage=lambda msg: print(msg), timeout=900,
)
print(result["signal"]["action"])

# 持仓
client.save_holdings([HoldingItem("600519", 100, 1500)], mode="deep")
task = client.run_holdings_analysis(mode="quick", use_saved=True)

# 简报
client.generate_brief(period="post_market")
client.get_latest_brief()
```

详见 [adapter_http_api.md](adapter-http-api.md) 与 `adapter_client/` 模块代码。
