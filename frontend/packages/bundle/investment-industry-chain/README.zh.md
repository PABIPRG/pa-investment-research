# `@deepseek-ai/dsh-investment-industry-chain-bundle`

[English](README.md) | 中文

该纯 patch profile bundle（组合包）以 `investment-industry-chain` 行插入 [`@deepseek-ai/dsh-investment-industry-chain`](../../investment-research/industry-chain/README.md)。业务插件通过 `ctx.investmentPythonRuntime` 注册并获取独立的 `industry-chain` backend。该组合包不包含进程或业务实现。

## 模型体验

### 模型可见内容

无直接内容。本包只贡献 Host 生命周期行。

### Token 影响

无直接 token 影响。

### KV Cache 影响

无直接 KV Cache 影响。

## 已知限制与延后工作

- 该组合包依赖前置投研 Runtime 层，不负责初始化 Python 环境。
