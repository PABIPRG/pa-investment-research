# @deepseek-ai/dsh-investment-industry-chain

English | [中文](README.zh.md)

This function plugin owns the `industry-chain` backend definition and acquires its verified lease from [`ctx.investmentPythonRuntime`](../python-runtime/README.md). Browser-safe company, entity, five-column chain, multi-level chain, statistics, and network-slice reads are exposed by the Runtime data broker; this package owns only backend activation and teardown.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `backendMode` | `managed` | `managed` starts a connection-refused local backend; `external` only verifies it. |
| `backendBaseUrl` | `http://127.0.0.1:8200` | Backend URL registered with the Runtime. |
| `backendProjectDir` | — | Explicit absolute `backend/industry-chain` directory when source discovery is unavailable. |

## Lifecycle

Activation registers the fixed `backend/industry-chain` project, `industry_chain.app:app` module, `/health` identity, and platform init commands, then acquires one lease. Disposal releases the lease before removing the definition. The plugin registers no model tools or prompt sections.

## Model Experience

### Tool schemas and results

#### What the model sees

This package adds no model-visible schema or result. The investment UI calls the Host's fixed browser data operations, and assistant requests use the shared investment assistant.

#### Token effect

No direct token effect.

#### KV Cache effect

No direct KV-cache effect.

## Known Limitations and Deferred Work

- Managed deployments outside the repository must set `backendProjectDir`; missing Python environments fail with the platform init command and are not installed automatically.
