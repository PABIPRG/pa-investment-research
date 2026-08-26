# @deepseek-ai/dsh-investment-stock-analysis

[English](README.md) | 中文

该函数插件通过从 [`ctx.investmentPythonRuntime`](../python-runtime/README.md) 租用的 Python HTTP endpoint 注册股票分析工具。它持有 backend 定义、Cordis 注册、请求映射、SSE 消费和工具结果渲染；Runtime 持有生命周期验证，endpoint 持有行情数据、分析执行、存储以及任何外部投递。

## 工具

插件注册 `analyze_stock`、`analyze_holdings` 和 `market_brief`，用于流式分析或简报生成；还注册 `set_watchlist`、`set_holdings`、`get_watchlist`、`set_risk_profile`、`get_risk_profile` 和 `get_latest_brief`，用于由 endpoint 支持的已保存状态。只读工具 `investment_context` 让模型以 `portfolio`、`strategy`、`shadow`、`evolution`、`reports` 或 `industry` 领域枚举按需读取最新持久化上下文，不接收上下文 JSON、URL 或路径，也不读取浏览器本地状态。包插件声明其面向模型的 schema。

`analyze_stock` 暴露以下延迟与覆盖档位：

| 深度 | 分析师覆盖 | 多空与风险辩论轮次 | 相对延迟 |
|---|---|---:|---|
| `quick` | 市场 | 1 | 最低 |
| `basic` | 市场、基本面 | 1 | 较低 |
| `standard` | 市场、社媒、新闻、基本面 | 1 | 默认 |
| `deep` | 市场、社媒、新闻、基本面 | 2 | 较高 |
| `full` | 市场、社媒、新闻、基本面，并启用在线新闻 | 3 | 最高 |

`analyze_holdings` 保持两档契约：`quick` 只做定量风险，`deep` 则为每只持仓并行运行 `standard` 四分析师档位。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `backendMode` | `managed` | `managed` 只启动明确 connection-refused 的本地 backend；`external` 只验证服务。 |
| `backendBaseUrl` | `http://127.0.0.1:8000` | 注册到 Runtime，并通过 lease 提供给本插件的 backend URL。 |
| `backendProjectDir` | — | 无法从源码 checkout 自动发现时，显式指定绝对 `backend/dsh-trading-core` 目录。 |
| `streamTimeoutMs` | `600000` | 流式 endpoint 响应的最长等待时间。 |
| `enableInChatPush` | `false` | 开启轮询未推送的最新简报，并将其投递给选定的活跃 agent。 |
| `pushPollMs` | `120000` | 简报轮询间隔，单位为毫秒；插件强制最小值为 30 秒。 |
| `pushSessions` | `[]` | 接收对话内简报的活跃 agent id；空数组表示所有活跃根 agent。 |

## 后端行为与生命周期

`analyze_stock` 发起 `POST /analyze`；`analyze_holdings` 发起 `POST /holdings/analyze`；`market_brief` 发起 `POST /brief`。每个任务随后以 SSE 读取 `GET /analyze/<taskId>/stream`。插件通过 `exec.agent.inject()` 将 `stage` 消息映射为带插件来源的用户消息，且不唤醒 agent；它将 `result` 载荷保留为无损 JSON，并从该载荷渲染结果卡和 Markdown 报告。轻量状态工具通过 endpoint 的 JSON 路由访问自选列表、持仓、风险偏好和最新简报。`investment_context` 只访问代码内固定的 trading-core 路由，并以稳定资源名聚合后端返回值：组合域读取持仓与风险，策略域读取策略池，影子域读取状态、持仓和净值，自进化域读取状态与归因，报告域读取统一报告摘要，产业域读取事件影响。

插件激活时注册 `trading-core`，只把显式设置的 `ADAPTER_RUNNER` 转发给 owned managed 子进程，并在注册工具前获取经过验证的 lease。所有工具注册和可选的简报轮询定时器均位于 Cordis effect 中。dispose 时先移除它们，再释放 lease 并注销 backend 定义。进程创建与终止仍归 Runtime 持有。

## 失败与面向模型的行为

HTTP 响应失败时，工具调用会以 endpoint 状态和响应体拒绝。任务启动响应未提供 `task_id`、SSE HTTP 失败、SSE `error` 事件，或 SSE 流在未收到 `result` 时结束，也都会使工具调用拒绝。畸形 `stage` 或 `result` 帧不会变成结果；缺少结果仍会使调用失败。进度消息注入失败会被主动隔离，不会替换成功的工具结果。

模型会收到已注册的 schema、流式工具产生 `stage` 时注入的进度消息，以及数据驱动的渲染工具结果。启用的简报推送器会向配置的活跃 agent 发送以 `[插件播报 · <period>简报]` 开头的插件来源消息，并在简报成功投递后于 endpoint 标记它；endpoint 轮询失败和单个 agent 投递失败不会中断后续轮询。

## 测试

包测试刻画 HTTP 路径与请求体、SSE 分帧与失败处理、渲染器输出、可选简报轮询与 dispose、工具 schema，以及基于 Loader 的注册／dispose 组合。adapter e2e 测试保持 opt-in，且需要可访问的外部 endpoint。

## 模型体验

### 工具 schema 与结果

#### 模型可见内容

插件注册期间，模型会看到该包注册的 10 个 schema。流式调用还会追加 endpoint 提供的 `stage` 消息，每次完成的调用都会追加从 endpoint JSON 派生的渲染结果。`investment_context` 的 schema 只暴露领域枚举；调用结果才追加所选领域的最新后端上下文。[工具目录的包映射](../../../docs/tool-catalog.md#tool-package-map)记录生成目录的 `tool-*` 范围，该范围不包含本包。

#### Token 影响

可见 schema 增加固定的请求成本。进度、渲染结果和简报投递只会在产生它们的调用或启用的简报投递中增加数据驱动的留存 token。

#### KV Cache 影响

注册状态不变时，工具 schema 保持前缀稳定。进度、结果和简报投递追加在请求前缀之后，不会使已有 KV Cache 条目失效。

## 已知限制与延后工作

- **仓库之外的项目发现** — 不含源码 checkout 布局的 managed 部署必须配置绝对 `backendProjectDir`；缺少虚拟环境时会给出平台初始化命令并失败，绝不会自动安装。
- **endpoint 持有的持久化与投递** — 自选列表、持仓、风险偏好、简报和外部推送调度仍由 endpoint 持有；只有可选的对话内简报轮询由本插件持有。
- **生成工具目录的范围** — 生成的工具目录只枚举 `packages/*/tool-*` 包，因此这些 schema 由本包文档记录，而非目录条目。
