# `@deepseek-ai/dsh-investment-market-watch-bundle`

English | [中文](README.zh.md)

Patch-only profile bundle that inserts [`@deepseek-ai/dsh-investment-market-watch`](../../investment-research/market-watch/README.md) as `investment-market-watch`. The business plugin registers and acquires the independent `market-watch` backend through `ctx.investmentPythonRuntime` before exposing its eleven tools. The bundle contains no business logic or scheduler settings.

It can be removed independently from a profile: market-watch tools and its backend lease disappear while the runtime and stock-analysis capability remain.

## Model Experience

Indirectly, through the inserted market-watch plugin, which owns its eleven schemas and rendered results.

#### KV Cache effect

None directly; the inserted business plugin owns the schema and result effects.

## Known Limitations and Deferred Work

- **Requires the runtime bundle** — this patch deliberately does not duplicate or auto-insert the shared Python Runtime row.
