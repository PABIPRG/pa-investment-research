# Agent Note: 投研分析深度持有明确的节点预算

Status: implemented

[English](2026-08-24-investment-analysis-depth-budget.md) | 中文

## Problem

投研 adapter 设置的是 `use_memory=false`，而 `TradingAgentsGraph` 读取 `memory_enabled`。因此每次分析仍会初始化 5 个 Chroma memory，也可能发起 embedding 请求，尽管跨次记忆应归 dsh 会话持有。`quick`、`basic` 和 `standard` 还选择相同的 4 个分析师及相同辩论轮次，选择更浅的深度并不会减少 graph 的 agent 节点预算。

## Decision

adapter 在合并基础配置与请求覆盖后固定设置 `memory_enabled=false`，并删除无效的旧 `use_memory` 键。adapter 分析不允许重新启用 graph memory，否则会重复 dsh 会话的持有职责，并使延迟取决于 embedding provider。

研究深度现在选择明确的分析师集合。`quick` 运行市场分析师，`basic` 运行市场和基本面分析师，`standard`、`deep` 和 `full` 保留市场、社媒、新闻和基本面分析师。`quick`、`basic` 和 `standard` 的辩论与风险讨论均保持 1 轮，`deep` 保持 2 轮，`full` 保持 3 轮。pipeline manifest 读取传给 `TradingAgentsGraph` 的同一份分析师配置，因此它声明的节点预算与实际构图一致。

持仓工具的 `deep` 模式明确把每只持仓交给引擎的 `standard` 档位。这样既保留原有的四分析师持仓覆盖，也不用承担引擎 `deep` 档位增加的辩论轮次。面向模型的 schema 会说明个股分析的所有档位以及持仓到 `standard` 的映射。

## Alternatives considered

**并行执行所有相互独立的分析师。** 并行 graph 状态合并会改变执行与进度语义，需要更广的 provider 和 state reducer 覆盖。本次修复使用 graph 现有的 `selected_analysts` 扩展点。

**将浅层深度的辩论轮次设为 0。** 当前 graph 总是先进入第一个 Bull Researcher 和 Risky Analyst，再由条件边判断轮次上限。0 不能稳定地跳过这些节点，还可能使 manifest 与实际执行不一致。

**跨任务复用同一 graph。** `TradingAgentsGraph` 持有可变的 ticker、current state 和 log state。共享它会用跨任务并发风险换取初始化延迟。

## Consequences

- 无网络节点预算为：`quick` 9、`basic` 10、`standard` 12、`deep` 17、`full` 22。与原先 12 节点的浅层 graph 相比，`quick` 减少 25% 的 agent 节点，`basic` 减少约 17%。
- `deep` 和 `full` 保留原有分析师覆盖与辩论语义。
- `quick` 不产生社媒、新闻和基本面报告；`basic` 不产生社媒和新闻报告。需要这些视角的调用方使用 `standard` 或更深档位。
- 持仓 `deep` 分析通过传入 `research_depth=standard` 保留四分析师覆盖；mocked runner 测试会锁定该委派契约。
- adapter 构图不再初始化 Chroma memory，也不发起 memory embedding 请求。mocked graph 测试在无网络条件下锁定 memory 不变量、分析师选择、manifest 内容、未知深度回退与节点预算。
