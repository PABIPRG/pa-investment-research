# @deepseek-ai/dsh-host-deployment-capabilities

English | [中文](README.zh.md)

Host-owned deployment classification and capability projection. The plugin provides one immutable `ctx.deploymentCapabilities` snapshot derived from an explicit `surface` configuration (`cli`, `local-web`, `electron`, or `cloud-web`) and the Host platform. Consumers use that snapshot instead of inferring authority from browser globals, bind addresses, or operating-system strings.

The snapshot describes browser file transfer, Host directory browsing, native path opening, broker synchronization, native holdings access, and the allowed holdings-provider roster. `cloud-web` permits browser file transfer but denies every Host-path and local-broker capability; `electron` enables the complete local desktop set; `local-web` keeps browser transfer plus Host directory access; `cli` has no browser transfer.

See the [deployment support matrix](../../../docs/deployment-capabilities.md) and the [implementation Agent Note](../../../.agents/notes/implemented/architecture/2026-09-11-deployment-capabilities-and-web-file-transfer.md).

## Model Experience

### Deployment policy

#### What the model sees

Nothing. `ctx.deploymentCapabilities` controls Host and Client product capabilities and contributes no prompt, message, or tool schema.

#### Token effect

No tokens are added to a model request.

#### KV Cache effect

No model request content changes, so this package does not affect prompt caching.

## Known Limitations and Deferred Work

- The deployment surface is process-wide and immutable after composition. Per-user or per-session capability negotiation is intentionally unsupported.
- Container sandboxing and health/readiness behavior are owned by the deployment layer tracked separately from this capability declaration.
