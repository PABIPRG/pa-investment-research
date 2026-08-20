# SSE 事件跟踪协议说明

> 本文档描述 `dsh-trading-core` 适配器 SSE 流的**节点跟踪增强协议**，是前端（dsh 插件 / 客户端）渲染分析进度条、步骤器、节点产出报告的实现依据。
>
> 基础 SSE 端点与任务生命周期见 [adapter-http-api.md §3.13](./adapter-http-api.md)，本文档聚焦增强后的**事件类型与字段契约**。

- SSE 端点：`GET /analyze/{task_id}/stream`
- 内容类型：`text/event-stream`
- 心跳：每 15s 一个 `ping` 注释帧（无 `event` 字段，客户端应忽略）
- 实现文件：`adapter/app.py` `_sse_gen` + `adapter/analyzer.py` `TaskManager` + `tradingagents/graph/trading_graph.py` `_send_progress_update`

---

## 1. 设计目标

```
用户视角                          系统视角
┌─────────────────────┐          ┌──────────────────────┐
│ 实时进度条 35%       │          │ pipeline manifest     │
│ 当前节点高亮         │  <─SSE─  │ stage(done)           │
│ 每步产出可展开       │          │ trace(content)        │
│ 辩论轮次可见         │          │ progress(percent)     │
│ 最终报告             │          │ result(signal+reports)│
└─────────────────────┘          └──────────────────────┘
```

- **节点透明**：用户知道当前分析到哪个 agent 节点
- **进度量化**：结构化百分比 + 步序号，支持进度条渲染
- **内容流送**：每个 agent 的产出（报告/辩论/决策）实时推送摘要
- **管道预声明**：任务启动时一次性下发完整管道清单，前端可预渲染步骤器

---

## 2. 事件类型总览

| 事件 | 触发时机 | 频次 | 说明 |
|---|---|---|---|
| `pipeline` | 任务启动时 | 1 次 | 下发管道清单（阶段/节点/总步数） |
| `stage` | 每个 agent 节点完成时 | 多次 | 节点状态 + 步序号 + 耗时 |
| `trace` | 节点产出内容时 | 多次 | agent 输出文本摘要（前 500 字） |
| `progress` | 每次节点完成时 | 多次 | 进度条百分比 + 当前阶段 |
| `result` | 全部分析完成 | 1 次 | 最终 Signal + 分步报告 |
| `error` | 引擎异常 | 0~1 次 | 错误信息 + 节点 ID |
| `done` | 流结束 | 1 次 | 流终止标记 |

**典型事件序列（成功）**：

```
pipeline → (stage → trace → progress)×N → result → done
```

**典型事件序列（失败）**：

```
pipeline → (stage → trace → progress)×K → error → done
```

---

## 3. 各事件字段详解

### 3.1 `pipeline` — 管道清单

任务启动时一次性下发，前端据此渲染步骤器 / 阶段面板。

```json
{
  "event": "pipeline",
  "data": {
    "ticker": "600519",
    "phases": [
      {
        "phase": "analysts",
        "label": "数据采集与分析师团队",
        "nodes": [
          {"id": "Market Analyst",       "label": "📊 市场分析师",   "type": "analyst"},
          {"id": "Social Analyst",       "label": "💬 情绪分析师",   "type": "analyst"},
          {"id": "News Analyst",         "label": "📰 新闻分析师",   "type": "analyst"},
          {"id": "Fundamentals Analyst", "label": "💼 基本面分析师",  "type": "analyst"}
        ]
      },
      {
        "phase": "research",
        "label": "多空辩论",
        "nodes": [
          {"id": "Bull Researcher",  "label": "🐂 看涨研究员", "type": "debater", "rounds": 1},
          {"id": "Bear Researcher",  "label": "🐻 看跌研究员", "type": "debater", "rounds": 1},
          {"id": "Research Manager", "label": "👔 研究经理",   "type": "judge"}
        ]
      },
      {
        "phase": "trader",
        "label": "交易决策",
        "nodes": [
          {"id": "Trader", "label": "📈 交易员", "type": "trader"}
        ]
      },
      {
        "phase": "risk",
        "label": "风险辩论",
        "nodes": [
          {"id": "Risky Analyst",   "label": "🔥 激进风险",  "type": "debater", "rounds": 1},
          {"id": "Safe Analyst",    "label": "🛡️ 保守风险", "type": "debater", "rounds": 1},
          {"id": "Neutral Analyst", "label": "⚖️ 中性风险",  "type": "debater", "rounds": 1},
          {"id": "Risk Judge",       "label": "🎯 风险经理", "type": "judge"}
        ]
      }
    ],
    "total_steps": 12
  }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ticker` | string | 股票代码 |
| `phases` | array | 阶段列表，按执行顺序 |
| `phases[].phase` | string | 阶段 ID：`analysts`/`research`/`trader`/`risk` |
| `phases[].label` | string | 阶段中文标签 |
| `phases[].nodes` | array | 该阶段的节点列表 |
| `phases[].nodes[].id` | string | 节点 ID（与 `stage` 事件的 `node_id` 对应） |
| `phases[].nodes[].label` | string | 节点中文标签（含 emoji） |
| `phases[].nodes[].type` | string | 节点类型：`analyst`/`debater`/`judge`/`trader` |
| `phases[].nodes[].rounds` | int | 辩论轮次（仅 `debater` 类型节点有此字段） |
| `total_steps` | int | 总步数（用于进度条分母） |

**`total_steps` 计算公式**：

```
total = 分析师数 + (max_debate_rounds × 2 + 1) + 1 + (max_risk_discuss_rounds × 3 + 1)
```

| 深度模式 | max_debate | max_risk | 分析师 | 研究 | 交易 | 风险 | total |
|---|---|---|---|---|---|---|---|
| quick/basic/standard | 1 | 1 | 4 | 3 | 1 | 4 | **12** |
| deep | 2 | 2 | 4 | 5 | 1 | 7 | **17** |
| full | 3 | 3 | 4 | 7 | 1 | 10 | **22** |

> 公式实现：`tradingagents/graph/trading_graph.py` `_compute_total_steps()`

---

### 3.2 `stage` — 节点完成事件

每个 agent 节点完成时发送（`updates` 流模式下，chunk 到达 = 节点完成）。

```json
{
  "event": "stage",
  "data": {
    "node_id": "Market Analyst",
    "node_label": "📊 市场分析师",
    "phase": "analysts",
    "status": "done",
    "step_index": 1,
    "total_steps": 12,
    "elapsed_ms": 8200,
    "message": "📊 市场分析师",
    "ts": 1724083208.2
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `node_id` | string | 节点 ID（与 pipeline manifest 的 `id` 对应） |
| `node_label` | string | 节点中文标签（含 emoji） |
| `phase` | string | 所属阶段：`analysts`/`research`/`trader`/`risk` |
| `status` | string | 节点状态：当前固定为 `"done"`（`updates` 模式下 chunk 到达即完成） |
| `step_index` | int | 当前步序号（1-based，全局递增） |
| `total_steps` | int | 总步数（与 pipeline manifest 一致） |
| `elapsed_ms` | int | 本节点耗时（毫秒，≈ 上一个 chunk 到本 chunk 的间隔） |
| `message` | string | 人类可读消息（向后兼容字段，等于 `node_label`） |
| `ts` | float | Unix 时间戳 |

> **关于 `status`**：当前实现中 `updates` 流模式只在节点完成时产出 chunk，因此 `status` 始终为 `"done"`。前端可据 `pipeline` manifest + 当前 `step_index` 推断下一个节点处于"运行中"状态。

> **跳过的节点**：工具节点（`tools_market` 等）和消息清理节点（`Msg Clear Market` 等）不发 `stage` 事件，避免重复。

---

### 3.3 `trace` — agent 产出内容

节点完成且其 state_update 包含可提取的产出文本时发送。

```json
{
  "event": "trace",
  "data": {
    "node_id": "Market Analyst",
    "node_label": "📊 市场分析师",
    "content_type": "report",
    "content_preview": "## 技术指标分析\n\nMACD 金叉形成，RSI 62.3 偏强...",
    "content_len": 1523,
    "ts": 1724083208.2
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `node_id` | string | 节点 ID |
| `node_label` | string | 节点中文标签 |
| `content_type` | string | 内容类型：`report`/`debate`/`decision` |
| `content_preview` | string | 产出文本前 500 字符 |
| `content_len` | int | 产出全文长度（字符数） |
| `ts` | float | Unix 时间戳 |

**`content_type` 分类**：

| 类型 | 适用节点 | 前端渲染建议 |
|---|---|---|
| `report` | 4 个分析师 | 折叠报告卡片 |
| `debate` | Bull/Bear Researcher, Risky/Safe/Neutral Analyst | 辩论气泡（多空/风险三方面板） |
| `decision` | Research Manager, Trader, Risk Judge | 决策高亮卡片 |

**节点 → state 字段提取映射**：

| 节点 ID | 提取路径 | 说明 |
|---|---|---|
| `Market Analyst` | `market_report` | 直接取 state_update 字段 |
| `Fundamentals Analyst` | `fundamentals_report` | 直接取 |
| `News Analyst` | `news_report` | 直接取 |
| `Social Analyst` | `sentiment_report` | 直接取 |
| `Bull Researcher` | `investment_debate_state.current_response` | 嵌套取 |
| `Bear Researcher` | `investment_debate_state.current_response` | 嵌套取 |
| `Research Manager` | `investment_plan` | 直接取 |
| `Trader` | `trader_investment_plan` | 直接取 |
| `Risky Analyst` | `risk_debate_state.current_risky_response` | 嵌套取 |
| `Safe Analyst` | `risk_debate_state.current_safe_response` | 嵌套取 |
| `Neutral Analyst` | `risk_debate_state.current_neutral_response` | 嵌套取 |
| `Risk Judge` | `final_trade_decision` | 直接取 |

> 提取实现：`tradingagents/graph/trading_graph.py` `_extract_node_output()`，映射表 `NODE_TRACE_MAP`

> **注意**：`trace` 的 `content_preview` 是截断摘要（前 500 字）。完整报告在 `result` 事件的 `reports` 字段中获取。

---

### 3.4 `progress` — 进度条百分比

每个节点完成时与 `stage`/`trace` 同批发送。

```json
{
  "event": "progress",
  "data": {
    "percent": 8,
    "phase": "analysts",
    "message": "📊 市场分析师",
    "step_index": 1,
    "total_steps": 12,
    "ts": 1724083208.2
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `percent` | int | 进度百分比（0~100） |
| `phase` | string | 当前阶段 |
| `message` | string | 当前节点标签 |
| `step_index` | int | 当前步序号 |
| `total_steps` | int | 总步数 |
| `ts` | float | Unix 时间戳 |

**百分比计算逻辑**（阶段区间内线性插值）：

| 阶段 | 百分比区间 |
|---|---|
| `analysts` | 0% ~ 36% |
| `research` | 36% ~ 64% |
| `trader` | 64% ~ 73% |
| `risk` | 73% ~ 100% |
| `done`（`__end__`） | 100% |

公式：`percent = lo + (hi - lo) × step / total`，其中 `(lo, hi)` 取自上表。

> 实现：`tradingagents/graph/trading_graph.py` `_compute_percent()` + `_PHASE_PERCENT` 常量

---

### 3.5 `result` — 最终结果

全部分析完成后发送，携带 Signal + 分步报告 + 性能指标。

```json
{
  "event": "result",
  "data": {
    "signal": {
      "signal_type": "final",
      "ticker": "600519",
      "company_name": "贵州茅台",
      "action": "买入",
      "target_price": 1560.0,
      "confidence": 0.75,
      "risk_score": 0.4,
      "reasoning": "...",
      "model_info": "...",
      "risk_profile": "balanced",
      "calibration": "...",
      "calibration_note": "..."
    },
    "reports": {
      "market": "...",
      "fundamentals": "...",
      "news": "...",
      "sentiment": "...",
      "debate": "...",
      "trader": "...",
      "risk": "..."
    },
    "performance_metrics": {
      "total_time": 45.2,
      "node_count": 12,
      "node_timings": {"...": 8.2},
      "category_timings": {"...": {}}
    }
  }
}
```

> `result` 字段结构不变，详见 [adapter-http-api.md §4](./adapter-http-api.md)。

---

### 3.6 `error` — 异常

```json
{
  "event": "error",
  "data": {
    "message": "DeepSeek API 超时",
    "node_id": "Market Analyst"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `message` | string | 错误描述 |
| `node_id` | string\|null | 出错时正在执行的节点（若可推断） |

---

### 3.7 `done` — 流结束

```json
{
  "event": "done",
  "data": {}
}
```

收到 `done` 后客户端应断开 SSE 连接。成功和失败都会发 `done`。

---

## 4. SSE 帧格式

sse-starlette 输出，`\n\n` 分隔：

```
event: pipeline
data: {"ticker":"600519","phases":[...],"total_steps":12}

event: stage
data: {"node_id":"Market Analyst","phase":"analysts","status":"done","step_index":1,"total_steps":12,"elapsed_ms":8200,"message":"📊 市场分析师","ts":1724083208.2}

event: trace
data: {"node_id":"Market Analyst","content_type":"report","content_preview":"## 技术指标分析...","content_len":1523,"ts":1724083208.2}

event: progress
data: {"percent":8,"phase":"analysts","step_index":1,"total_steps":12,"ts":1724083208.2}

event: result
data: {"signal":{...},"reports":{...},"performance_metrics":{}}

event: done
data: {}

```

---

## 5. 节点 ID 全表

| 节点 ID | 阶段 | 类型 | 标签 | trace 内容字段 |
|---|---|---|---|---|
| `Market Analyst` | analysts | analyst | 📊 市场分析师 | `market_report` |
| `Social Analyst` | analysts | analyst | 💬 情绪分析师 | `sentiment_report` |
| `News Analyst` | analysts | analyst | 📰 新闻分析师 | `news_report` |
| `Fundamentals Analyst` | analysts | analyst | 💼 基本面分析师 | `fundamentals_report` |
| `Bull Researcher` | research | debater | 🐂 看涨研究员 | `investment_debate_state.current_response` |
| `Bear Researcher` | research | debater | 🐻 看跌研究员 | `investment_debate_state.current_response` |
| `Research Manager` | research | judge | 👔 研究经理 | `investment_plan` |
| `Trader` | trader | trader | 📈 交易员 | `trader_investment_plan` |
| `Risky Analyst` | risk | debater | 🔥 激进风险 | `risk_debate_state.current_risky_response` |
| `Safe Analyst` | risk | debater | 🛡️ 保守风险 | `risk_debate_state.current_safe_response` |
| `Neutral Analyst` | risk | debater | ⚖️ 中性风险 | `risk_debate_state.current_neutral_response` |
| `Risk Judge` | risk | judge | 🎯 风险经理 | `final_trade_decision` |

**不发送事件的节点**（内部节点，前端无需渲染）：

| 节点 ID | 说明 |
|---|---|
| `tools_market` / `tools_social` / `tools_news` / `tools_fundamentals` | 工具执行节点 |
| `Msg Clear Market` / `Msg Clear Social` / `Msg Clear News` / `Msg Clear Fundamentals` | 消息清理节点 |

---

## 6. 向后兼容

### 6.1 旧 str 进度回调

旧的 `FakeRunner` / 旧引擎以**纯字符串**调用 `progress_callback`（如 `"📊 市场分析师"`）。`TaskManager._put_stage` 做双模式分发：

| 输入类型 | 输出事件 |
|---|---|
| `str`（旧） | `{"type":"stage", "node":null, "message":"📊 市场分析师", "ts":...}` |
| `dict`（新） | `{"ts":..., **event_dict}`（透传全部字段） |

旧格式 `stage` 事件经 `_sse_gen` 透传后，`data` 只有 `node` 和 `message` 两个字段（`node` 为 `null`）。

### 6.2 前端兼容建议

```typescript
// 兼容新旧 stage 事件的消费逻辑
function onStage(data: any) {
  // 新格式：有 node_id
  if (data.node_id) {
    highlightNode(data.node_id, data.status, data.elapsed_ms)
  }
  // 旧格式或兼容字段：用 message 显示文本
  if (data.message) {
    updateProgressText(data.message)
  }
}
```

---

## 7. 前端消费指南

### 7.1 完整消费流程

```
1. POST /analyze  →  { "task_id": "abc123" }
2. GET /analyze/abc123/stream
   ├─ pipeline   → 渲染步骤器（预声明全部节点）
   ├─ stage      → 标记对应节点为「已完成」，高亮下一节点为「运行中」
   ├─ trace      → 在对应节点下追加可展开的报告/辩论/决策卡片
   ├─ progress   → 更新进度条百分比
   ├─ result     → 缓存最终 Signal + 完整报告
   └─ done       → 断流
```

### 7.2 TypeScript 消费示例

```typescript
interface SseEvent {
  event: 'pipeline' | 'stage' | 'trace' | 'progress' | 'result' | 'error' | 'done'
  data: Record<string, any>
}

async function consumeSse(taskId: string, handlers: {
  onPipeline?: (m: PipelineManifest) => void
  onStage?: (s: StageEvent) => void
  onTrace?: (t: TraceEvent) => void
  onProgress?: (p: ProgressEvent) => void
  onResult?: (r: any) => void
  onError?: (msg: string) => void
}) {
  const resp = await fetch(`http://127.0.0.1:8000/analyze/${taskId}/stream`, {
    headers: { 'Accept': 'text/event-stream' }
  })
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // 按 \n\n 分割 SSE 帧
    const frames = buffer.split('\n\n')
    buffer = frames.pop() || ''

    for (const frame of frames) {
      const ev = parseSseFrame(frame)
      if (!ev) continue
      switch (ev.event) {
        case 'pipeline': handlers.onPipeline?.(ev.data); break
        case 'stage':    handlers.onStage?.(ev.data); break
        case 'trace':    handlers.onTrace?.(ev.data); break
        case 'progress':handlers.onProgress?.(ev.data); break
        case 'result':  handlers.onResult?.(ev.data); break
        case 'error':    handlers.onError?.(ev.data?.message); break
        case 'done':     return
      }
    }
  }
}

function parseSseFrame(frame: string): SseEvent | null {
  let event = 'message', data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return null
  return { event: event as SseEvent['event'], data: JSON.parse(data) }
}
```

### 7.3 进度条渲染建议

```
┌─ 分析进度 ────────────────────────────────────────┐
│ ████████████░░░░░░░░░░░░░  35%  基本面分析师运行中  │  ← progress.percent
│                                                    │
│ ● 市场分析师     ✅ 8.2s   [展开报告 ▾]            │  ← stage + trace
│ ● 情绪分析师     ✅ 6.1s   [展开报告 ▾]            │
 │ ● 基本面分析师   ⏳ 运行中...                      │  ← 推断：pipeline[step] 的高亮
│ ○ 新闻分析师     等待                              │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ 多空辩论 第1轮                                     │
│ ○ 看涨研究员     等待                              │
│ ○ 看跌研究员     等待                              │
│ ○ 研究经理       等待                              │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ ○ 交易员         等待                              │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ ○ 风险辩论       等待                              │
└────────────────────────────────────────────────────┘
```

- 收到 `pipeline` → 全部节点渲染为「等待」⚪
- 收到 `stage`（`status: done`）→ 对应节点标 ✅ + 显示 `elapsed_ms`
- `stage` 之后的下一节点（据 `pipeline` 顺序）标 ⏳「运行中」
- 收到 `trace` → 在对应节点下追加折叠卡片
- 收到 `progress` → 更新顶部进度条

### 7.4 辩论轮次渲染

`debater` 类型节点在 `pipeline` 中声明了 `rounds`。同一节点可能在不同轮次中多次产出 `stage`/`trace` 事件（`step_index` 不同但 `node_id` 相同）。前端应按 `step_index` 区分，而非用 `node_id` 去重。

```
多空辩论
├─ 第1轮
│  ├─ 🐂 看涨研究员  ✅  step=5  [展开论点 ▾]
│  └─ 🐻 看跌研究员  ✅  step=6  [展开论点 ▾]
├─ 第2轮（deep 模式）
│  ├─ 🐂 看涨研究员  ✅  step=7  [展开论点 ▾]
│  └─ 🐻 看跌研究员  ✅  step=8  [展开论点 ▾]
└─ 👔 研究经理      ✅  step=9  [展开决策 ▾]
```

---

## 8. curl 测试

### 8.1 完整 SSE 流（fake 模式）

```bash
# 1. 启动 fake 模式服务
ADAPTER_RUNNER=fake env/Scripts/python.exe -m uvicorn adapter.app:app --port 8000

# 2. 启动分析任务
curl -s -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker":"600519"}'
# → {"task_id":"abc123..."}

# 3. 消费 SSE 流
curl.exe -N http://127.0.0.1:8000/analyze/abc123/stream
```

### 8.2 只看前 30 行（快速采样）

```bash
curl.exe -N http://127.0.0.1:8000/analyze/<task_id>/stream | head -n 30
```

### 8.3 超时限制

```bash
curl.exe -N --max-time 120 http://127.0.0.1:8000/analyze/<task_id>/stream
```

> Windows PowerShell 下请使用 `curl.exe` 而非 `curl` 别名，否则流式输出会被 `Invoke-WebRequest` 缓冲。

---

## 9. 实现架构

### 9.1 事件流路径

```
trading_graph._send_progress_update(chunk, progress_callback)
  │  chunk = {node_name: state_update}  （LangGraph updates 模式）
  │
  ├─ 提取 node_name → 查 NODE_META → 得 label/phase/type
  ├─ 计算 elapsed_ms = now - _progress_last_ts
  ├─ progress_callback(stage_dict)     ──┐
  ├─ 提取 content via _extract_node_output  │
  ├─ progress_callback(trace_dict)     ──┤  3 个 dict 事件
  └─ progress_callback(progress_dict)  ──┘
                    │
                    ▼
TaskManager._put_stage(task_id, event)
  │  isinstance(event, dict) → {"ts":now, **event}  （透传）
  │  isinstance(event, str) → {"type":"stage","node":None,"message":str,"ts":now}  （兼容）
  │
  └─ _put(task_id, ev) → loop.call_soon_threadsafe(queue.put_nowait, ev)
                    │
                    ▼
app._sse_gen(manager, task_id)
  │  async for ev in manager.stream_events(task_id):
  │    ev_type = ev["type"]
  │    data = {k:v for k,v in ev.items() if k != "type"}
  │    yield {"event": ev_type, "data": json.dumps(data)}
  │
  └─ sse-starlette EventSourceResponse → 客户端
```

### 9.2 关键文件

| 文件 | 职责 |
|---|---|
| `tradingagents/graph/trading_graph.py` | `_send_progress_update`：从 LangGraph chunk 提取节点信息，发 stage/trace/progress dict 事件 |
| `tradingagents/graph/trading_graph.py` | `NODE_META`/`NODE_TRACE_MAP`/`NODE_CONTENT_TYPE`：节点元数据常量表 |
| `adapter/analyzer.py` | `TaskManager._put_stage`：str/dict 双模式分发 + `_run_sync` 发 pipeline manifest |
| `adapter/app.py` | `_sse_gen`：dict 事件 → SSE 命名字段透传 |
| `adapter/engine_bridge.py` | `EngineRunner.pipeline_manifest()`：按 config 生成管道清单 |
| `adapter/runner.py` | `FakeRunner`：发结构化事件 + `pipeline_manifest()`，用于 fake 模式自测 |

### 9.3 线程模型

```
POST /analyze（FastAPI 事件循环线程）
    → TaskManager.start()
    → ThreadPoolExecutor worker 线程
        → runner.run(params, progress_cb)
            → trading_graph.propagate(progress_callback=progress_cb)
                → _send_progress_update(chunk, progress_cb)
                    → progress_cb(dict_event)  ← worker 线程
                        → _put_stage(task_id, dict)
                            → loop.call_soon_threadsafe(queue.put_nowait, ev)
                                ↑ 跨线程投递到事件循环
    → SSE generator（事件循环线程）
        → await queue.get()  ← 消费
        → yield {"event":..., "data":...}
```

引擎在 worker 线程同步执行，`call_soon_threadsafe` 跨线程投递到事件循环的队列，SSE generator 在事件循环线程消费。详见 [adapter-http-api.md §2.1](./adapter-http-api.md)。

---

## 10. 与旧协议的差异

| 维度 | 旧协议 | 新协议（本文档） |
|---|---|---|
| 事件类型 | 4 种（stage/result/error/done） | 7 种（+pipeline/trace/progress） |
| stage 字段 | `{node:null, message:"文本"}` | `{node_id, node_label, phase, status, step_index, total_steps, elapsed_ms, message}` |
| agent 产出 | 不推送（只在 result 中） | `trace` 事件实时推送前 500 字摘要 |
| 进度百分比 | 无 | `progress` 事件推送 0~100 |
| 管道预声明 | 无 | `pipeline` 事件一次性下发全量节点清单 |
| `node` 字段 | 始终 `null` | 新格式无此字段；旧格式仍为 `null` |
| 向后兼容 | — | 旧 str 进度回调经 `_put_stage` 包装后仍可消费 |

> **迁移策略**：前端可据 `data.node_id` 是否存在判断新旧格式，渐进式升级。旧前端只读 `data.message` 仍可正常工作。
