# Agent Note: Investment Runtime health freshness

Status: implemented

English | [中文](2026-08-24-investment-runtime-health-freshness.zh.md)

## Problem

Every acquisition of an already-active investment Python backend performs a new `/health` request. The opportunity-discovery and portfolio-analysis routes acquire the same backend for independent data requests, so three concurrent requests amplify into three health probes before their business requests begin. A slow or stalled health endpoint therefore adds repeated latency, and the probe has no Runtime-owned deadline.

## Decision

The Runtime keeps the time of the last successful health result for each active backend. A result remains reusable for `healthFreshnessMs` (default `5000`); after it expires, concurrent acquisitions share one per-backend probe. `healthFreshnessMs: 0` retains the previous always-probe behavior. Each health request is combined with a Runtime-owned `AbortController` and fails with an explicit timeout error after `healthTimeoutMs` (default `2000`). Both settings are documented in the package [README](../../../../packages/investment-research/python-runtime/README.md).

Freshness carries a generation. Owned-process exit, credential updates that require restart, teardown, disposal, and a non-healthy probe invalidate the reusable result. A probe started before an exit or restart invalidation cannot restore the older generation. Caller cancellation stops only that caller's wait; it does not cancel the shared probe needed by other acquisitions.

Focused Runtime tests pin concurrent sharing, expiry, freshness reuse, timeout cancellation, process-exit invalidation, restart invalidation, and non-healthy readiness.

## Alternatives considered

**Probe on every acquisition with only a shorter timeout.** This bounds one request but preserves request amplification and still puts health latency in front of every business call.

**Cache indefinitely until a request fails.** This minimizes probes but can lease a backend after its owned process exits or its credentials require restart.

**Cancel the shared probe when one caller cancels.** This makes unrelated acquisitions fail together and recreates duplicate probes when surviving callers retry.

## Consequences

For one active backend, `N` acquisitions inside the freshness window add zero probes. When the result is stale, `N` concurrent acquisitions add one probe rather than `N`; after that probe succeeds, later acquisitions inside the window again add zero. Slow probes now fail within the configured deadline with an actionable backend id and duration.

The Runtime may reuse a healthy result for at most `healthFreshnessMs`, except that lifecycle and readiness invalidations end the window immediately. This change does not alter Typert transport, Host protocol, workbench UI, chat behavior, backend business requests, or lease ownership.
