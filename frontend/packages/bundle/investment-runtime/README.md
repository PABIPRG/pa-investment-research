# `@deepseek-ai/dsh-investment-runtime-bundle`

English | [中文](README.zh.md)

Patch-only profile bundle that inserts [`@deepseek-ai/dsh-investment-python-runtime`](../../investment-research/python-runtime/README.md) as `investment-python-runtime`. It owns no backend definition or business tool; later investment capability bundles inject the service, register their backend, and acquire a verified lease.

Place this bundle before every investment capability bundle. Omitting it makes those plugins remain unresolved on `ctx.investmentPythonRuntime` and causes profile activation to fail instead of publishing tools without a backend.

## Model Experience

Indirectly, through the business plugins that acquire the inserted runtime and own their tool schemas and results.

#### KV Cache effect

None directly; the inserted runtime contributes no request content.

## Known Limitations and Deferred Work

- **Ordering is part of the profile** — this patch does not insert any business capability, and a capability bundle without it cannot activate.
