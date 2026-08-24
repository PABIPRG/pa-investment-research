# @deepseek-ai/dsh-investment-market-watch

[English](README.md) | 中文

该函数插件通过从 [`ctx.investmentPythonRuntime`](../python-runtime/README.md) 租用的 Python HTTP endpoint 注册同步盯盘工具。它持有 backend 定义、Cordis 注册、请求转发和结果渲染；Runtime 持有生命周期验证，endpoint 持有自选列表与预警状态、行情数据、预警调度和外部投递。

## 工具

插件注册 `watch_add`、`watch_remove` 和 `watch_list`，用于其独立自选列表；注册 `add_alert`、`list_alerts` 和 `remove_alert`，用于预警规则；注册 `scan_movers`、`watch_overview` 和 `tech_signal`，用于市场观测；并注册 `news_express` 和 `daily_brief`，用于新闻和简报。包插件声明其面向模型的 schema。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `backendMode` | `managed` | `managed` 只启动明确 connection-refused 的本地 backend；`external` 只验证服务。 |
| `backendBaseUrl` | `http://127.0.0.1:8100` | 注册到 Runtime，并通过 lease 提供给本插件的 backend URL。 |
| `backendProjectDir` | — | 无法从源码 checkout 自动发现时，显式指定绝对 `backend/market-watch` 目录。 |

## 后端行为与生命周期

每个工具都会向配置的 endpoint 转发同步 JSON 请求，并渲染返回的 JSON。插件不会消费 SSE、创建定时器或留存 endpoint 状态。它的独立自选列表不与股票分析自选列表或持仓共享。

插件激活时注册 `market-watch`，并在注册工具前获取经过验证的 lease。工具注册位于 Cordis effect 中。dispose 时先移除它们，再释放 lease 并注销 backend 定义。进程创建与终止仍归 Runtime 持有；Python scheduler 仍归 endpoint 持有。

## 失败与面向模型的行为

endpoint 响应失败时，工具调用会以其 HTTP 状态和响应体拒绝。其他情况下，插件会通过每个工具声明的输出 schema 返回 endpoint JSON。无论 endpoint 使用 LLM 路径还是数据模板回退，`daily_brief` 都会渲染 endpoint 结果。

模型会收到已注册的 schema 和数据驱动的渲染结果。该插件没有自有提示词区块、流式进度注入或自动对话内推送。

## 测试

包测试刻画 JSON 请求方法、路径与请求体；包括空字段在内的渲染器输出；工具 schema；以及基于 Loader 的注册／dispose 组合。

## 模型体验

### 工具 schema 与结果

#### 模型可见内容

插件注册期间，模型会看到该包注册的 11 个 schema。完成的调用会追加从 endpoint JSON 派生的渲染结果。[工具目录的包映射](../../../docs/tool-catalog.md#tool-package-map)记录生成目录的 `tool-*` 范围，该范围不包含本包。

#### Token 影响

可见 schema 增加固定的请求成本。渲染结果只会在调用完成后增加数据驱动的留存 token。

#### KV Cache 影响

注册状态不变时，工具 schema 保持前缀稳定。工具结果追加在请求前缀之后，不会使已有 KV Cache 条目失效。

## 已知限制与延后工作

- **仓库之外的项目发现** — 不含源码 checkout 布局的 managed 部署必须配置绝对 `backendProjectDir`；缺少虚拟环境时会给出平台初始化命令并失败，绝不会自动安装。
- **endpoint 持有的预警投递** — 预警调度、可选的 LLM 解读和外部投递仍由 endpoint 持有；该插件只创建、读取、移除并展示 endpoint 记录。
- **生成工具目录的范围** — 生成的工具目录只枚举 `packages/*/tool-*` 包，因此这些 schema 由本包文档记录，而非目录条目。
