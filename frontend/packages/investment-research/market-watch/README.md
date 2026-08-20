# @deepseek-ai/dsh-investment-market-watch

English | [中文](README.zh.md)

This function plugin registers synchronous market-watch tools over an externally running Python HTTP endpoint. It owns Cordis registration, request forwarding, and result rendering; the endpoint owns watchlist and alert state, market data, alert scheduling, and external delivery.

## Tools

The plugin registers `watch_add`, `watch_remove`, and `watch_list` for its independent watchlist; `add_alert`, `list_alerts`, and `remove_alert` for alert rules; `scan_movers`, `watch_overview`, and `tech_signal` for market observation; and `news_express` and `daily_brief` for news and briefs. The package plugin declares their model-facing schemas.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `adapterBaseUrl` | `http://127.0.0.1:8100` | Base URL of the externally running market-watch endpoint. |

## Backend behavior and lifecycle

Every tool forwards a synchronous JSON request to the configured endpoint and renders the returned JSON. The plugin does not consume SSE, create timers, or retain endpoint state. Its independent watchlist does not share stock-analysis watchlists or holdings.

Tool registrations live in Cordis effects, so disposing the plugin removes them. The plugin does not start, stop, supervise, or otherwise manage the Python endpoint or its scheduler.

## Failures and model-visible behavior

An unsuccessful endpoint response rejects with its HTTP status and body. The plugin otherwise returns the endpoint JSON through each tool's declared output schema. `daily_brief` renders the endpoint result whether the endpoint used its LLM path or its data-template fallback.

The model receives the registered schemas and data-dependent rendered results. There is no plugin-owned prompt section, streaming progress injection, or automatic in-chat push.

## Tests

Package tests characterize JSON request methods, paths, and bodies; renderer output including empty fields; tool schemas; and Loader-based registration/disposal composition.

## Model Experience

### Tool schemas and results

#### What the model sees

The model sees this package's eleven registered schemas while the plugin is registered. A completed call appends the rendered result derived from the endpoint JSON. The [tool catalog's package map](../../../docs/tool-catalog.md#tool-package-map) records the generated catalog's `tool-*` scope, which excludes this package.

#### Token effect

Visible schemas add a fixed request cost. Rendered results add data-dependent retained tokens only after calls complete.

#### KV Cache effect

Tool schemas are prefix-stable while registration is unchanged. Tool results append after the request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **External endpoint lifecycle** — the package requires a separately running Python endpoint at `adapterBaseUrl`; it neither launches nor supervises that process, so an unavailable endpoint makes its tools fail.
- **Endpoint-owned alert delivery** — alert scheduling, optional LLM interpretation, and external delivery remain endpoint-owned; this plugin only creates, reads, removes, and presents endpoint records.
- **Generated tool catalog scope** — the generated tool catalog enumerates `packages/*/tool-*` packages, so these schemas remain documented by this package rather than a catalog entry.
