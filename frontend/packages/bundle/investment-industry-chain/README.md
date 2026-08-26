# `@deepseek-ai/dsh-investment-industry-chain-bundle`

English | [中文](README.zh.md)

Patch-only profile bundle that inserts [`@deepseek-ai/dsh-investment-industry-chain`](../../investment-research/industry-chain/README.md) as `investment-industry-chain`. The business plugin registers and acquires the independent `industry-chain` backend through `ctx.investmentPythonRuntime`. The bundle contains no process or business implementation.

## Model Experience

### What the model sees

Nothing directly. This package only contributes a Host lifecycle row.

### Token effect

No direct token effect.

### KV Cache effect

No direct KV-cache effect.

## Known Limitations and Deferred Work

- The bundle depends on the preceding investment Runtime layer and does not initialize the Python environment.
