# @deepseek-ai/dsh-investment-stock-analysis

English | [中文](README.zh.md)

This function plugin registers stock-analysis tools over an externally running Python HTTP endpoint. It owns the Cordis registrations, request mapping, SSE consumption, and tool-result rendering; the endpoint owns market data, analysis execution, storage, and any external delivery.

## Tools

The plugin registers `analyze_stock`, `analyze_holdings`, and `market_brief` for streaming analysis or brief generation, plus `set_watchlist`, `set_holdings`, `get_watchlist`, `set_risk_profile`, `get_risk_profile`, and `get_latest_brief` for endpoint-backed saved state. The package plugin declares their model-facing schemas.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `adapterBaseUrl` | `http://127.0.0.1:8000` | Base URL of the externally running stock-analysis endpoint. |
| `streamTimeoutMs` | `600000` | Maximum time for a streaming endpoint response. |
| `enableInChatPush` | `false` | Enables polling for an unpushed latest brief and delivering it to selected active agents. |
| `pushPollMs` | `120000` | Brief-poll interval in milliseconds; the plugin enforces a 30-second minimum. |
| `pushSessions` | `[]` | Active-agent ids that receive in-chat briefs; an empty array targets every active root agent. |

## Backend behavior and lifecycle

`analyze_stock` starts `POST /analyze`; `analyze_holdings` starts `POST /holdings/analyze`; and `market_brief` starts `POST /brief`. Each task then reads `GET /analyze/<taskId>/stream` as SSE. The plugin maps `stage` messages into plugin-sourced user messages through `exec.agent.inject()` without waking the agent, retains the `result` payload as lossless JSON, and renders result cards and Markdown reports from that payload. Lightweight state tools use the endpoint's JSON routes for watchlists, holdings, risk profiles, and the latest brief.

All tool registrations and the optional brief-poll timer live in Cordis effects, so disposing the plugin removes registrations and clears the timer. The plugin does not start, stop, supervise, or otherwise manage the Python endpoint.

## Failures and model-visible behavior

An unsuccessful HTTP response rejects with the endpoint status and body. A task-start response without `task_id`, an SSE HTTP failure, an SSE `error` event, or an SSE stream that ends without `result` also rejects the tool call. Malformed `stage` or `result` frames do not become a result; a missing result still fails the call. Progress-message injection failures are deliberately contained so they do not replace a successful tool result.

The model receives registered schemas, injected progress messages when streaming tools emit `stage`, and rendered data-dependent tool results. An enabled brief pusher sends a plugin-sourced message headed `[插件播报 · <period>简报]` to its configured active agents and marks a successfully delivered brief at the endpoint; endpoint polling and individual agent-delivery failures do not interrupt later polls.

## Tests

Package tests characterize HTTP paths and bodies, SSE framing and failure handling, renderer output, optional brief polling and disposal, tool schemas, and Loader-based registration/disposal composition. The adapter e2e test remains opt-in and requires a reachable external endpoint.

## Model Experience

### Tool schemas and results

#### What the model sees

The model sees this package's nine registered schemas while the plugin is registered. Streaming calls additionally append endpoint-provided `stage` messages, and every completed call appends the rendered result derived from the endpoint JSON. The [tool catalog's package map](../../../docs/tool-catalog.md#tool-package-map) records the generated catalog's `tool-*` scope, which excludes this package.

#### Token effect

Visible schemas add a fixed request cost. Progress and rendered results add data-dependent retained tokens only for the calls or enabled brief deliveries that produce them.

#### KV Cache effect

Tool schemas are prefix-stable while registration is unchanged. Progress, results, and brief deliveries append after the request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **External endpoint lifecycle** — the package requires a separately running Python endpoint at `adapterBaseUrl`; it neither launches nor supervises that process, so an unavailable endpoint makes its tools fail.
- **Endpoint-owned persistence and delivery** — watchlists, holdings, risk profiles, briefs, and external push scheduling remain endpoint-owned; only the optional in-chat brief polling is owned by this plugin.
- **Generated tool catalog scope** — the generated tool catalog enumerates `packages/*/tool-*` packages, so these schemas remain documented by this package rather than a catalog entry.
