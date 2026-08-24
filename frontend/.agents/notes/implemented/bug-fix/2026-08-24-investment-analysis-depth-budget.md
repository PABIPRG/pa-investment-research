# Agent Note: Investment analysis depth owns an explicit node budget

Status: implemented

English | [中文](2026-08-24-investment-analysis-depth-budget.zh.md)

## Problem

The investment adapter configured `use_memory=false`, while `TradingAgentsGraph` reads `memory_enabled`. Each analysis therefore initialized five Chroma memory objects and could issue embedding requests even though cross-run memory belongs to the dsh conversation. The `quick`, `basic`, and `standard` research depths also selected the same four analysts and the same debate rounds, so choosing a shallower depth did not reduce the graph's agent-node budget.

## Decision

The adapter enforces `memory_enabled=false` after applying base configuration and request overrides, and removes the ineffective legacy `use_memory` key. Adapter analyses cannot opt back into graph memory because that would duplicate dsh conversation ownership and make latency depend on an embedding provider.

Research depth now selects an explicit analyst set. `quick` runs the market analyst, `basic` runs market and fundamentals, and `standard`, `deep`, and `full` retain market, social, news, and fundamentals. Debate and risk-discussion rounds remain one for `quick`, `basic`, and `standard`, two for `deep`, and three for `full`. The pipeline manifest reads the same selected-analyst configuration passed to `TradingAgentsGraph`, so its declared node budget matches the graph construction.

## Alternatives considered

**Parallelize all independent analysts.** Parallel graph state merging changes execution and progress semantics and needs broader provider and state-reducer coverage. This fix uses the graph's existing `selected_analysts` extension point instead.

**Set debate rounds to zero for shallow depths.** The current graph always enters the first bull researcher and risky analyst before their conditional edges evaluate the round limit. A zero value would not be a reliable skip mechanism and could make the manifest disagree with executed nodes.

**Reuse one graph across tasks.** `TradingAgentsGraph` carries mutable ticker, current-state, and log state. Sharing it would exchange initialization latency for cross-task concurrency risk.

## Consequences

- The keyless node budget is 9 for `quick`, 10 for `basic`, 12 for `standard`, 17 for `deep`, and 22 for `full`. Compared with the previous 12-node shallow graph, this removes 25% of `quick` agent nodes and about 17% of `basic` agent nodes.
- `deep` and `full` preserve their analyst coverage and debate semantics.
- `quick` omits social, news, and fundamentals reports; `basic` omits social and news reports. Callers requiring those perspectives use `standard` or deeper.
- Adapter graph construction no longer initializes Chroma memory or issues memory embedding requests. Mocked graph tests enforce the memory invariant, analyst selection, manifest contents, fallback depth, and node budgets without network access.
