1. **角色分工（客户端 vs 服务端）**
   - `adapter/app.py` = 服务端（FastAPI 服务器）
   - `adapter_client/client.py` = 客户端（HTTP 调用者）

2. **调用顺序（时序图）**
   - 应用代码（调用 TradingCoreClient）→ HTTP 网络请求 → FastAPI 路由（app.py）→ TaskManager/Runner → HTTP 响应 → 客户端解析 SSE/JSON

3. **是否重复？为什么两边都要定义一遍接口？**
   - 表面上看两个文件都列出了相同的 12 个接口，似乎重复
   - 但本质是「两边视角不同、职责不同」：
     - app.py 是「实现」：注册 HTTP 路由、调用内部引擎、管理任务状态、发 SSE 帧
     - client.py 是「使用」：组装请求参数、发 HTTP 请求、解析 SSE 帧、封装错误、提供一站式阻塞 API
   - 类比：就像后端写了 REST API，前端还要写 fetch() 封装函数，不是重复，是双方都要知道契约

4. **对应关系一览（接口对照）**：把两边的接口做一个对照表格

5. **调用栈示意**：画一个时序调用流程
**不重复，一个是服务端、一个是客户端，职责完全不同。** 下面用分层架构 + 调用流程解释清楚。

---

## 一、角色分工（客户端 vs 服务端）

| 维度 | `adapter/app.py` 服务端 | `adapter_client/client.py` 客户端 |
|---|---|---|
| **位置** | 适配器进程内，跑 uvicorn | 调用方代码里（可以是另一个 Python 进程 / dsh 插件 / 测试脚本） |
| **职责** | 定义 HTTP 路由（FastAPI）、把请求派给内部引擎 `TaskManager`、管理任务状态、把进度打包成 SSE 帧下发 | 发 HTTP 请求、解析响应、把 SSE 字节流还原成 `SseEvent` 对象、提供一站式阻塞 API |
| **依赖** | FastAPI / uvicorn / sse-starlette | requests |
| **类比** | 餐厅后厨（接单、做菜、喊号） | 顾客或跑腿 App（下单、等叫号、取餐） |

---

## 二、调用顺序（时序流程）

```
调用方代码
   │
   ▼
TradingCoreClient.run_analysis("600519")     ← [client.py] 高层一站式方法
   │  ①  组装 AnalyzeParams body
   ▼
POST http://127.0.0.1:8000/analyze           ← [client.py] _request()
   │  ②  HTTP 请求走网络（TCP）
   ▼
@app.post("/analyze")  analyze(req)           ← [app.py L88]  路由
   │  ③  manager.start() → 扔进 worker 线程
   ▼
TaskManager / FakeRunner 或 EngineRunner      ← [app.py 内部] 真正干活
   │
   ▼
return {"task_id": "xxx"}                     ← [app.py L92]
   │  ④  HTTP 200 JSON 返回
   ▼
client 拿到 task_id
   │  ⑤  发起 SSE 长连接
   ▼
GET /analyze/{id}/stream                      ← [client.py L214 stream_task()]
   │  ⑥  HTTP 流式响应（每 15s ping）
   ▼
@app.get("/analyze/{id}/stream")  stream()     ← [app.py L173]
   │  EventSourceResponse(_sse_gen())
   │  持续推送：
   │    event: stage / data: {"message":"📊 市场分析师"}
   │    event: stage / data: {"message":"💬 社媒分析师"}
   │    ...
   │    event: result / data: {"signal": {...}}
   │    event: done  / data: {}
   ▼
client _iter_sse_frames() + _decode_event()   ← [client.py L340 L377]
   │  ⑦  把行文本解析成 SseEvent 对象
   ▼
_on_stage 回调 / 收集 final result            ← [client.py L309 _consume_until_result()]
   │  ⑧  超时或 error → 抛 AdapterTaskError
   ▼
return 最终 result 给调用方                    ← [client.py L265]
```

---

## 三、接口一一对应（不是重复，是契约落地）

看起来两边都写了 12 个接口，其实是**同一套契约的两边实现**：服务端"实现契约"，客户端"使用契约"。

| 功能 | client.py 方法 | → 调 → | app.py 路由 |
|---|---|---|---|
| 健康检查 | `health()` [L96](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L96) | → | `GET /health` [L81](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L81) |
| 启动个股分析 | `analyze_stock()` [L102](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L102) | → | `POST /analyze` [L88](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L88) |
| 启动持仓分析 | `analyze_holdings()` [L124](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L124) | → | `POST /holdings/analyze` [L96](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L96) |
| 保存持仓 | `save_holdings()` [L140](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L140) | → | `POST /holdings/save` [L102](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L102) |
| 读/写自选 | `get_watchlist()` / `set_watchlist()` | → | `GET/POST /watchlist` [L113-L119](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L113) |
| 风险偏好 | `get_risk_profile()` / `set_risk_profile()` | → | `GET/POST /risk_profile` [L126-L134](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L126) |
| 市场简报 | `generate_brief()` / `get_latest_brief()` / `mark_brief_pushed()` | → | `POST /brief` 等 [L144-L163](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L144) |
| 查任务状态 | `get_task_status(task_id)` [L203](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L203) | → | `GET /analyze/{id}` [L191](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L191) |
| 查最终结果 | `get_task_result(task_id)` [L208](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L208) | → | `GET /analyze/{id}/result` [L182](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L182) |
| **SSE 进度流** | `stream_task(task_id)` [L214](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L214) + `_iter_sse_frames()` [L340](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L340) **解帧** | → | `GET /analyze/{id}/stream` [L173](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L173) + `_sse_gen()` [L201](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter/app.py#L201) **组帧** |
| **一站式阻塞** | `run_analysis()` / `run_holdings_analysis()` / `run_brief()` [L243](file:///c:/Users/18681/Desktop/投顾智能体/pa-trading/pa-investment-research/backend/dsh-trading-core/adapter_client/client.py#L243) **启动+流消费+拿结果** | → | 组合调用 「启动路由」+「SSE 路由」 |

---

## 四、为什么绝对不是重复

1. **两边不可互相替代**。删掉 `app.py`，服务端就没人监听 8000 端口接请求；删掉 `client.py`，调用方就得自己写 requests、写 SSE 解帧、写超时处理，写一堆样板代码。

2. **关注点相反**。
   - `app.py` 关注 **入站请求**：怎么从 HTTP 请求里拿参数、怎么派活、怎么把内部事件**打包**成 SSE 帧
   - `client.py` 关注 **出站请求**：怎么把参数**组装**成 HTTP body、怎么把 SSE 字节流**拆包**回对象、怎么处理网络错误和超时

3. **代码实际上毫无重复内容**。
   - `app.py` 里是 `@app.get/post` 装饰器 + `TaskManager` + `EventSourceResponse`
   - `client.py` 里是 `requests.Session.request()` + `_iter_sse_frames()` 解帧 + `_consume_until_result()` 流消费
   - 两边只有**接口契约的路径和字段名**必须一致（这不是重复，是对接协议必须匹配）

4. **分层架构的标准模式**：服务端（Adapter 层）+ SDK/Client 层，就像
   - `boto3`（SDK） 对应 AWS HTTP API
   - `openai` Python 包 对应 OpenAI HTTP API
   - 不存在重复一说。

**一句话总结**：`app.py` 是"接口的服务端实现"，`client.py` 是"接口的客户端封装"，一个收请求、一个发请求，合起来才是完整的 HTTP 适配器闭环 —— **二者互补，完全不重复。**