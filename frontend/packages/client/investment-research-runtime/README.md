# @deepseek-ai/dsh-client-investment-research-runtime

English | [中文](README.zh.md)

This browser plugin owns the Client projection of investment Python Runtime readiness. It mounts the generated `@deepseek-ai/dsh-investment-python-runtime/remote` contribution and publishes `ctx.investmentResearchRuntimeClient` only after every generated method is ready. The investment Runtime bundle places this Client row immediately after the Host Runtime row; the ordinary Web bundle does not enable it.

The published facade is frozen and contains four operations:

- `getSnapshot()` returns the cached, client-safe `InvestmentReadinessSnapshot`. Its reference remains stable while the readiness facts remain equal.
- `subscribe(listener)` registers a snapshot listener. The first concurrent group of subscribers shares one initial read.
- `refresh()` reads readiness explicitly. The current flight rejects on a Remote or transport failure; a flight superseded by a newer refresh, or retired during disposal, settles without publishing or reporting a stale failure.
- `requestRestart()` forwards the generated restart request and returns the Host's `accepted` or `unavailable` result. This package does not call Electron or restart a process itself.

The facade refreshes after `credentials/updated('DEEPSEEK_API_KEY')` and `connection/reset`. Other credential references do not trigger a read. A changed response replaces the cached snapshot and notifies subscribers through the same source; an equal response preserves the snapshot reference. Initial and event-driven current failures are reported once, and a later subscription, event, or explicit refresh can read again.

The Remote only returns readiness DTOs and restart acknowledgements. The facade exposes no credential value, provider, Host service, generated Remote namespace, or lifecycle controller. Disposing the Client plugin removes both invalidation listeners, clears subscribers, withdraws the facade service, and unmounts the generated Remote contribution; in-flight work settles without publishing after disposal.

## Model Experience

### Browser readiness projection

#### What the model sees

Nothing. `ctx.investmentResearchRuntimeClient` contributes no model context, tool schema, prompt, or independent model request; it only projects Host readiness to browser consumers.

#### Token effect

Zero model-input and model-output tokens.

#### KV Cache effect

None; snapshot refreshes and restart acknowledgements do not change a model request or an already-reusable prefix.

## Known Limitations and Deferred Work

- **No presentation ownership** — this package publishes data and actions only. A separately composed investment settings plugin owns user-visible readiness, remediation, and restart controls.
- **Profile-scoped availability** — only compositions that include the investment Runtime Host row and this Client row provide the facade; the ordinary Web bundle intentionally has no investment readiness service.
- **No polling or automatic retry** — readiness changes arrive through the two invalidation signals or an explicit `refresh()`. A current background failure remains cached as the last successful snapshot until another trigger reads again.
