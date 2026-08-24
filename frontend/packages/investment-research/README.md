# investment-research packages

English | [中文](README.zh.md)

This group contains the Host Runtime and function plugins that expose A-share research and market-observation operations through Python HTTP endpoints. The frontend packages own lifecycle verification, Cordis tool registration, request mapping, and presentation; each endpoint owns its domain execution and state.

| Package | Role | ctx key |
|---|---|---|
| [`python-runtime/`](python-runtime/README.md) | Registers backend definitions, verifies or starts Python endpoints, returns reference-counted leases, and tears down only owned subprocess trees. | `investmentPythonRuntime` |
| [`stock-analysis/`](stock-analysis/README.md) | Registers streaming stock, holdings, and market-brief tools; maps SSE progress into agent context and supports optional in-chat brief polling. | (registers on `ctx.tools`; uses `ctx.agents`) |
| [`market-watch/`](market-watch/README.md) | Registers synchronous watchlist, alert, market-observation, news, and daily-brief tools. | (registers on `ctx.tools`) |

Both business plugins require `ctx.investmentPythonRuntime`, register their complete backend definition, and acquire a verified URL before exposing tools. Managed mode starts a missing backend through the Runtime; external mode only verifies an independently supervised endpoint. The business plugins still own no process primitives, backend storage, external delivery, or shared adapter client.
