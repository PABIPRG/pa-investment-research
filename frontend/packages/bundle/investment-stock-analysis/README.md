# `@deepseek-ai/dsh-investment-stock-analysis-bundle`

English | [中文](README.zh.md)

Patch-only profile bundle that inserts [`@deepseek-ai/dsh-investment-stock-analysis`](../../investment-research/stock-analysis/README.md) as `investment-stock-analysis`. The business plugin registers and acquires the `trading-core` backend through `ctx.investmentPythonRuntime` before exposing its ten tools. The bundle contains no business logic and keeps in-chat brief push disabled by the plugin default.

It can be removed independently from a profile: stock-analysis tools and the `trading-core` lease disappear while the runtime and market-watch capability remain.

## Model Experience

Indirectly, through the inserted stock-analysis plugin, which owns its nine schemas, streaming progress messages, rendered results, and optional brief delivery.

#### KV Cache effect

None directly; the inserted business plugin owns the schema and message effects.

## Known Limitations and Deferred Work

- **Requires the runtime bundle** — this patch deliberately does not duplicate or auto-insert the shared Python Runtime row.
