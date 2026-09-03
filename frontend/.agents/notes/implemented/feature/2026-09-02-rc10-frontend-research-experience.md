# Agent Note: rc.10 capability-led research experience

Status: implemented

English | [中文](2026-09-02-rc10-frontend-research-experience.zh.md)

## Problem

Several investment-research pages exposed implementation-oriented controls before the product had durable task-history contracts. Smart Analysis mixed capability discovery with direct task forms, Strategy Research devoted its first screen to lifecycle education and a global backtest window, and Market Watch allowed the floating assistant to cover the news rail without coordinating layout or focus. Research context also duplicated strategy selection even though the assistant only needs an analysis capability and an optional instrument.

The front end needed to implement the rc.10 information hierarchy without inventing backend task history, pagination, relationship provenance, or other unavailable facts.

## Decision

Smart Analysis is a capability overview backed by the view-independent `ANALYSIS_MODULES` catalog. Its four cards expose details and an assistant hand-off, while direct task forms, local progress simulation, and backend execution controls are absent. The same catalog drives the My Research composer module picker. Module selection and optional instrument selection remain independent; a module change replaces only an empty or still-automatic draft.

My Research keeps the conversation as its primary surface. Preference Review belongs to the Research Workbench and uses mounted sibling views so returning does not remount the workbench or repeat its initial data reads.

Market Watch derives `closed`, `docked`, or `overlay` assistant layout and `comfortable` or `compact` density at the page boundary. On desktop, a docked assistant reduces the available page width and hides the still-mounted news rail from interaction. Narrow screens use a modal backdrop and make the workbench inert. Closing restores the assistant launcher focus. Compact density removes secondary quote fields while preserving identity, price, and change.

Strategy Research keeps lifecycle education behind a keyboard-safe help dialog and removes page-level refresh and backtest-window controls. Until the backend task-history work is delivered, the existing run action retains the established two-year request rather than presenting a false history manager. The Evolution dashboard separates participation state, confidence tier, and mutation origin; mutation is not a countable lifecycle group.

Industry Chain distinguishes selection from recentering. A single node selection only changes focus and entity details; “set as center” reloads that company, keeps the current graph visible while loading, and atomically replaces accumulated graph state after success. A failed reload preserves the previous center and graph. One-, two-, and three-level controls reload the current center with matching request depth. The legend states both labels and the supplier-to-company-to-customer direction, so color is not the only carrier of meaning.

Transitions use short opacity and transform changes, preserve mounted data surfaces where state restoration matters, and are removed under `prefers-reduced-motion: reduce`.

## Deferred backend contracts

This decision does not add backtest or shadow-task history, artificial task progress, relationship-weight provenance, event pagination, impact expansion, risk-center data, or demo fixtures. Those surfaces remain deferred until their backend contracts exist.

## Alternatives considered

**Keep direct task forms on Smart Analysis.** This would preserve familiar controls but continue to mix capability discovery with execution and imply task state that rc.10 assigns to durable task history.

**Unmount the Market Watch news rail while the assistant is open.** This saves layout work but repeats news requests and loses scroll state when the user closes the assistant.

**Keep mutation as a lifecycle group.** A mutated candidate can also be active, watched, or retired, so counting mutation as participation duplicates strategies and hides the distinction between origin and current state.

**Accumulate every Industry Chain recenter operation into one graph.** This preserves exploration history but leaves the old root visually present and can misrepresent it as the current center after a reload.

**Mock missing backend history and pagination.** Placeholder records would make the interface appear complete while violating the product requirement that displayed investment facts come from real contracts.

## Consequences

The first screen of each research page now emphasizes the user's decision rather than backend mechanics. Assistant transitions retain context and accessibility state, and responsive density has explicit, testable states. Removing global backtest controls temporarily gives up user-selected windows on the legacy direct-run action; selectable windows return with the real task-history manager. A successful Industry Chain recenter operation intentionally replaces the old accumulated graph so the visible root and request object cannot diverge.
