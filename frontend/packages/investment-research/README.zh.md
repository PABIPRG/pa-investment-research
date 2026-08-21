# investment-research 包

[English](README.md) | 中文

该组包含函数插件，它们通过外部运行的 Python HTTP endpoint 提供 A 股研究和市场观测操作。frontend 包持有 Cordis 工具注册、请求映射和展示；每个 endpoint 持有其领域执行和状态。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`stock-analysis/`](stock-analysis/README.md) | 注册流式股票、持仓和市场简报工具；将 SSE 进度映射到 agent 上下文，并支持可选的对话内简报轮询。 | （注册到 `ctx.tools`；使用 `ctx.agents`） |
| [`market-watch/`](market-watch/README.md) | 注册同步自选列表、预警、市场观测、新闻和每日简报工具。 | （注册到 `ctx.tools`） |

两个包都要求配置的 endpoint 在工具调用前已运行。两个包都不持有 Python 进程启动、监管、存储、外部投递或共享适配器客户端。
