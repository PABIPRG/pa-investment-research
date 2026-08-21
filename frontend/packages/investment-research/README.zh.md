# investment-research 包

[English](README.md) | 中文

该组包含通过 Python HTTP endpoint 提供 A 股研究和市场观测操作的 Host Runtime 与函数插件。frontend 包持有生命周期验证、Cordis 工具注册、请求映射和展示；每个 endpoint 持有其领域执行和状态。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`python-runtime/`](python-runtime/README.md) | 注册 backend 定义、验证或启动 Python endpoint、返回引用计数 lease，并且只拆除 owned 子进程树。 | `investmentPythonRuntime` |
| [`stock-analysis/`](stock-analysis/README.md) | 注册流式股票、持仓和市场简报工具；将 SSE 进度映射到 agent 上下文，并支持可选的对话内简报轮询。 | （注册到 `ctx.tools`；使用 `ctx.agents`） |
| [`market-watch/`](market-watch/README.md) | 注册同步自选列表、预警、市场观测、新闻和每日简报工具。 | （注册到 `ctx.tools`） |

两个业务插件都依赖 `ctx.investmentPythonRuntime`，注册完整 backend 定义，并在公开工具前获取经过验证的 URL。managed 模式会通过 Runtime 启动缺失的 backend；external 模式只验证独立监管的 endpoint。业务插件仍不持有进程原语、backend 存储、外部投递或共享适配器客户端。
