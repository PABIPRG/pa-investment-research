# `@deepseek-ai/dsh-investment-stock-analysis-bundle`

[English](README.md) | 中文

纯 patch profile bundle（组合包），以 `investment-stock-analysis` 行插入 [`@deepseek-ai/dsh-investment-stock-analysis`](../../investment-research/stock-analysis/README.md)。业务插件在公开九个工具前，会通过 `ctx.investmentPythonRuntime` 注册并获取 `trading-core` backend。该 bundle 不包含业务逻辑，并沿用插件默认值关闭对话内简报推送。

它可以从 profile 中独立移除：股票分析工具与 `trading-core` lease（租约）会消失，runtime 与盘中盯盘能力继续保留。

## 模型体验

间接产生影响：所插入的股票分析插件拥有九个 schema、流式进度消息、渲染结果与可选简报投递。

#### KV 缓存影响

无直接影响；所插入的业务插件拥有 schema 与消息影响。

## 已知限制与暂缓事项

- **依赖 runtime bundle**：该 patch 有意不复制或自动插入共享 Python Runtime 行。
