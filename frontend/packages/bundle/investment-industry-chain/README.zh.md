# `@deepseek-ai/dsh-investment-industry-chain-bundle`

[English](README.md) | 中文

纯 patch Profile bundle，以 `investment-industry-chain` 行插入 [`@deepseek-ai/dsh-investment-industry-chain`](../../investment-research/industry-chain/README.md)。业务插件会注册并租用独立的 `industry-chain` 后端，同时发布零工具的就绪能力。本 bundle 不包含业务路由或模型工具。

它可以被独立移除：产业链租约与就绪贡献会消失，共享 Runtime、股票分析与盘中盯盘继续保留。

该 bundle 既不初始化 Python，也不下载图谱种子数据。产品页就绪状态与用户明确触发的首次下载继续通过 Runtime 固定的 `industry-chain.data-status` 和 `industry-chain.data-bootstrap` 操作完成。

## 模型体验

无，因为该 bundle 只插入生命周期注册，不会增加面向模型的 schema、提示词、消息或结果。

#### KV 缓存影响

该 bundle 不改变模型请求前缀。

## 已知限制与延后工作

- **依赖 Runtime bundle**：该 patch 有意不复制共享 Python Runtime 行。
