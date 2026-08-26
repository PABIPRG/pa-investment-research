# `@deepseek-ai/dsh-investment-industry-chain-bundle`

English | [中文](README.zh.md)

Patch-only Profile bundle that inserts [`@deepseek-ai/dsh-investment-industry-chain`](../../investment-research/industry-chain/README.md) as `investment-industry-chain`. The business plugin registers and leases the independent `industry-chain` backend and publishes its zero-tool readiness capability. This bundle contains no business routes or model tools.

It can be removed independently: the industry-chain lease and readiness contribution disappear while the shared Runtime, stock analysis, and market watch remain.

The bundle neither initializes Python nor downloads graph seed data. Product-page readiness and explicit first-use download continue through the Runtime's fixed `industry-chain.data-status` and `industry-chain.data-bootstrap` operations.

## Model Experience

None, as the bundle only inserts a lifecycle registration and adds no model-facing schema, prompt, message, or result.

#### KV Cache effect

The bundle does not change the model request prefix.

## Known Limitations and Deferred Work

- **Requires the Runtime bundle** — this patch deliberately does not duplicate the shared Python Runtime row.
