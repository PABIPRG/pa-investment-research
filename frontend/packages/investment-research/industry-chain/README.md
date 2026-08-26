# @deepseek-ai/dsh-investment-industry-chain

English | [中文](README.zh.md)

Host plugin that registers the `industry-chain` Python backend with [`ctx.investmentPythonRuntime`](../python-runtime/README.md). It verifies or starts the service, holds one lifecycle lease, and publishes a zero-tool, no-LLM capability so readiness surfaces can report the backend accurately.

Browser-safe company, entity, five-column chain, multi-level chain, statistics, network-slice, data-status, and data-bootstrap requests continue through the Runtime's fixed Host allow-list. The plugin deliberately registers no model tools and does not duplicate the legacy backend plugin. Model-side industry context remains compatible with the existing `investment_context` tool using `domain: "industry"`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `backendMode` | `managed` | `managed` may start the local backend; `external` only verifies it. |
| `backendBaseUrl` | `http://127.0.0.1:8200` | Fixed backend origin registered with the Runtime. |
| `backendProjectDir` | — | Explicit absolute `backend/industry-chain` directory when repository discovery is unavailable. |

## Backend contract and lifecycle

The managed definition uses repository path `backend/industry-chain`, Uvicorn module `industry_chain.app:app`, and `/health`. A healthy response must contain both `ok: true` and `service: "industry-chain"`.

Activation registers the definition, acquires a verified lease, then publishes `{ backendId: "industry-chain", toolCount: 0, llm: "none" }`. Disposal preserves the common investment lifecycle order: tool boundary, capability, lease, then backend definition.

## Data bootstrap boundary

Service health is independent of graph-data readiness. Startup never downloads seed data. The product page first reads `industry-chain.data-status`; only an explicit user action invokes the fixed, input-free `industry-chain.data-bootstrap` operation. Download progress and failures remain backend-owned and are surfaced through those fixed Runtime operations.

## Model Experience

This Host-only registration adds no schema, prompt, automatic context, message, or result to a model request. The existing V2 assistant context path remains `investment_context` with `domain: "industry"`.

#### KV Cache effect

The package does not change the model request prefix.

## Known Limitations and Deferred Work

- **Backend data remains endpoint-owned** — graph construction, persistence, and query behavior stay in `backend/industry-chain`; this plugin only owns Host registration and lifecycle.
- Managed deployments outside the repository must set `backendProjectDir`; missing Python environments fail with the platform init command and are not installed automatically.
