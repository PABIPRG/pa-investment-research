# investment-research packages

English | [中文](README.zh.md)

This group contains function plugins that expose A-share research and market-observation operations through externally running Python HTTP endpoints. The frontend packages own Cordis tool registration, request mapping, and presentation; each endpoint owns its domain execution and state.

| Package | Role | ctx key |
|---|---|---|
| [`stock-analysis/`](stock-analysis/README.md) | Registers streaming stock, holdings, and market-brief tools; maps SSE progress into agent context and supports optional in-chat brief polling. | (registers on `ctx.tools`; uses `ctx.agents`) |
| [`market-watch/`](market-watch/README.md) | Registers synchronous watchlist, alert, market-observation, news, and daily-brief tools. | (registers on `ctx.tools`) |

Both packages require their configured endpoint to be running before a tool call. Neither package owns Python-process startup, supervision, storage, external delivery, or a shared adapter client.
