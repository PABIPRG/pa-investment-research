# Agent Note: Eight-area investment research workbench

Status: implemented

English | [中文](2026-08-25-investment-research-v002-workbench.zh.md)

## Problem

The investment profile previously exposed only a small subset of the product journey. Users could scan opportunities and inspect holdings, but they could not move through a coherent daily research flow that joined personalized events, analysis, monitoring, strategy development, shadow validation, evolution, personal research, and industry relationships.

Expanding the surface creates two constraints. The visual hierarchy and interactions must remain useful when backend resources settle at different times or return no records, and the browser must not invent research data merely to make a new area look complete. New entry points must also preserve the production conversation, approval, attachment, and model-selection behavior instead of creating a parallel assistant experience.

## Decision

The profile now uses an eight-area navigation grouped into Overview, Analysis and Monitoring, Strategy Loop, and Personal Research and Graph. Research Workbench is the default route; Intelligent Analysis, Real-time Monitoring, Strategy Research, Shadow Validation, Self-evolution, My Research, and Industry Chain remain one click away. A persistent floating assistant entry provides a consistent escape hatch without occupying another navigation row.

Pages use `InvestmentDataOperation` for real reads and fixed business workflows. Research Workbench combines holdings, risk alerts, personalized cards, strategy matches, and risk profile data and launches the full pre-market brief task. Intelligent Analysis launches stock, holdings, brief, and historical backtest tasks on the page. Strategy Research handles hypothesis previews, candidate persistence, out-of-sample backtests, and state transitions. Shadow Validation runs daily accounting and refreshes status, positions, and equity. Self-evolution previews actions and applies them only after confirmation. My Research provides holding saves and analysis, watchlist mutations, KYC questionnaire and adjustment, behavioral profile, and portfolio risk on its own page. Industry Chain uses a dedicated lifecycle plugin to provide company search, company and entity profiles, five-column chains, multi-level expansion, and the global network on its own page. Every region owns its loading, empty, error, retry, and refresh presentation so a slow or unavailable backend does not erase unrelated content.

The shared investment assistant handles only result interpretation and follow-up research. Every module AI action and the floating entry opens the production conversation area as a 390px fixed overlay beside the current business route without compressing the page. Each entry first creates an independent conversation and then prefills that conversation's composer with structured business data. Context combines the click-time page snapshot, a module backend snapshot, and compact overall data while explicitly excluding code and project-analysis semantics. Opening the assistant neither changes the business route nor reuses a historical conversation, and the user can still edit before sending. Empty states and disabled controls describe what can happen next without supplying fabricated securities, relationships, performance, or portfolio values.

The Host allowlist expands only through fixed operation definitions. Each definition binds one backend, method, and path and validates accepted input keys and bounds. The browser still cannot choose a backend origin, port, or arbitrary path.

The responsive layout keeps grouped navigation, compact summary cards, tables, status indicators, small-screen content reflow, visible keyboard focus, and explicit busy and alert states. Labels describe product actions and data states rather than internal implementation or review workflow.

## Alternatives considered

**Keep the previous navigation and place new actions inside the assistant.** This would preserve less code, but it would hide the daily research sequence and make persistent status such as shadow equity or evolution readiness difficult to scan.

**Let the browser call backend URLs directly.** This would reduce Host mapping work, but it would expose origins and arbitrary paths to untrusted client input and bypass lease, validation, and lifecycle guarantees.

**Populate unavailable areas with canned securities and performance.** This would make every panel look full, but users could mistake decorative values for research output. Explicit empty states and the shared assistant entry preserve the distinction between available data and requested analysis.

**Create a second assistant experience for the new workbench.** This would fragment conversation capabilities and duplicate message, attachment, approval, and model-selection behavior. Reusing the production conversation area beside the current route keeps one source of truth, while creating a fresh conversation for every entry isolates research tasks from different modules.

## Consequences

Users can now move through the full research loop from a stable default workbench and open an independent assistant conversation from every area without leaving the current page. Analysis, strategy, shadow, evolution, My Research, and Industry Chain workflows run directly on their own pages. Direct-data pages remain useful under partial loading and failure, and the assistant consumes obtained business context instead of substituting for backend workflows. The cost is a larger route and operation surface, more per-region state, and an ongoing requirement to add both a fixed Host operation and backend lifecycle integration before a new workflow can read backend data directly.

## Verification

`packages/client/ui-investment-research/tests/state.client.spec.ts` and `apply.client.spec.ts` cover the default route, grouped navigation, search clearing, the current-route assistant overlay, and a fresh session for every entry. `assistant-context.client.spec.ts` verifies overall and module snapshots and module routing. `my-research-page.client.spec.tsx` and `industry-chain-page.client.spec.tsx` cover holdings/KYC and industry-chain behavior. `v2-pages.client.spec.tsx` covers analysis tasks, briefs, strategy, shadow, and evolution workflows. Runtime, lifecycle plugin, bundle, profile, and sidecar tests verify every fixed route, third-backend loading, and invalid-input rejection before dispatch.
