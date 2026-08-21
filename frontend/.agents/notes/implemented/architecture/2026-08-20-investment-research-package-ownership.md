# Agent Note: Investment-research packages own frontend tool integration

Status: implemented

English | [中文](2026-08-20-investment-research-package-ownership.zh.md)

## Problem

The A-share research and market-watch features need a frontend home that exposes their existing Python endpoint operations to the harness without making frontend packages responsible for backend process ownership or domain execution. The two integrations have distinct streaming and synchronous transport behavior, but both need workspace package identity, Loader composition, Cordis disposal, and model-facing tool registration.

## Decision

`packages/investment-research/stock-analysis` and `packages/investment-research/market-watch` are Host workspace function plugins. The stock-analysis package registers nine tools, maps its endpoint's HTTP-started SSE tasks into injected progress and rendered results, and owns its optional in-chat brief poller. The market-watch package registers eleven tools and maps synchronous JSON endpoint operations into rendered results. Each package owns its own endpoint client and package-local presentation code.

The frontend owns tool registration, configuration of the endpoint base URL, request mapping, model-visible rendering, and Cordis-effect disposal. The Python endpoints remain externally running processes. Frontend code does not start, stop, supervise, bundle, profile, or otherwise manage them, and the two packages do not introduce a shared adapter client.

## Package ownership

The mechanical package names are `@deepseek-ai/dsh-investment-stock-analysis` and `@deepseek-ai/dsh-investment-market-watch`. Their package manifests, Host TypeScript references, workspace discovery, invariants, Loader compositions, and generated dependency graph make them ordinary frontend workspaces. Their published function-plugin API remains `name`, `inject`, `Config`, and `apply`.

## Alternatives considered

- **Keep the endpoint-facing Node plugins backend-owned**: this leaves their Cordis registrations, workspace dependencies, Loader compositions, and disposal behavior outside the frontend package hierarchy. Workspace packages give the harness a direct owner for those responsibilities.
- **Put Python process management in each plugin**: this mixes transport integration with endpoint launch, supervision, configuration, and shutdown. The existing endpoint processes remain their own owners, while a tool call reports endpoint unavailability through its normal failure path.

## Consequences

- The packages can be loaded by name in frontend compositions and their registrations are removed with their Cordis effects.
- Deployments provide reachable endpoint URLs and operate the Python processes separately from the frontend packages.
- The stock-analysis and market-watch clients remain deliberately separate because their current endpoint protocols, including SSE versus synchronous JSON, have distinct package-local behavior.
