# `@deepseek-ai/dsh-investment-market-watch-bundle`

[English](README.md) | 中文

纯 patch profile bundle（组合包），以 `investment-market-watch` 行插入 [`@deepseek-ai/dsh-investment-market-watch`](../../investment-research/market-watch/README.md)。业务插件在公开十一个工具前，会通过 `ctx.investmentPythonRuntime` 注册并获取独立的 `market-watch` backend。该 bundle 不包含业务逻辑或 scheduler（调度器）设置。

它可以从 profile 中独立移除：盘中盯盘工具与其 backend lease（租约）会消失，runtime 与股票分析能力继续保留。

## 模型体验

间接产生影响：所插入的盘中盯盘插件拥有十一个 schema 与渲染结果。

#### KV 缓存影响

无直接影响；所插入的业务插件拥有 schema 与结果影响。

## 已知限制与暂缓事项

- **依赖 runtime bundle**：该 patch 有意不复制或自动插入共享 Python Runtime 行。
