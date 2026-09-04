# Agent Note: Investment research UAT navigation and layering

Status: implemented

[中文](2026-09-04-investment-uat-navigation-and-layering.zh.md)

## Problem

Real-product UAT exposed several related usability gaps in the investment research workspace: a strategy-scoped shadow view had no route back to the aggregate view, a report opened behind an already open strategy dialog, two adjacent context selectors could remain open at the same time while using different visual treatments, and evolution and backtest evidence exposed machine-oriented labels or dense card styling. The industry graph also described code-less entities as if a security profile existed, and the demo launcher split one release workflow across redundant top-level entries.

## Decision

The shadow scope bar now provides an explicit return to all strategies. Report and detail overlays share the same stack level, so the existing UI state and portal render order put the later-opened report above the retained detail dialog without destroying its state. Prompt-template and instrument selectors are controlled by one parent surface state and use the same menu surface treatment.

Backtest history is presented as responsive task cards. The evolution dashboard puts the actual lineage outcome first, followed by a compact runtime summary, state distribution, strategy diagnosis, and action history. Lifecycle detail lists remain reachable from their state totals but are height-bounded, so a large candidate pool cannot dominate the first screen. Evolution screens use neutral surfaces, deliberate spacing and human-facing strategy labels in the form `证券名称(代码) · 中文策略类型`; raw kinds and internal strategy identifiers remain available to the data layer but are not used as headings.

The report refresh action uses the existing primary-button contract with a larger full-width target. Smart Analysis and My Research both render the existing `InvestmentPromptTemplateSelect` with the same context appearance; this reuses the shared menu primitive instead of adding a parallel picker. Code-less industry entities say `未关联 A 股代码`. The release demo launcher exposes one top-level entry with a submenu for preparation, preflight, runbook, verification, and cleanup while retaining hidden command aliases for compatibility.

## Alternatives considered

**Close the strategy detail before opening a report.** Rejected because it discards useful context and is unnecessary: the product already models both overlays, and equal stack levels let later portal order express the intended foreground state.

**Give every popover its own open state and styling.** Rejected because adjacent selectors can overlap and drift visually. A shared controlled-surface contract makes exclusivity explicit while preserving escape, outside-click, and focus behavior in the existing menu primitives.

**Display backend strategy names verbatim.** Rejected because values such as `rsi_reversal` and opaque IDs are implementation vocabulary, not useful investment-research titles.

## Consequences

Users can recover from scoped views, keep their detail context while reading a report, scan evidence more quickly, and see truthful domain language. Evolution now communicates whether anything evolved before exposing operational detail, while preserving empty, disabled, partial-data, and history states without inventing activity. The UI owns a small, centralized projection from backend strategy kinds and security codes to human-facing labels; unknown kinds deliberately fall back to a generic description rather than leaking machine text. Overlay correctness depends on later-opened portals following document order at the shared stack level, which is covered by targeted UI and style tests.
