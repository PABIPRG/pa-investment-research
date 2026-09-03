# Agent Note: Read-only evolution dashboard, scoped strategy diagnostics, and one automatic loop

Status: implemented

English | [中文](2026-09-01-evolution-dashboard-strategy-diagnostics.zh.md)

> This decision partially supersedes the manual evolution preview and confirmation surface described by the [investment product lifecycle workbench](2026-08-26-investment-product-lifecycle-workbench.md). The old preview/run endpoints remain compatibility contracts, but they are no longer product UI actions.

## Problem

Evolution had two competing owners. The product invited an operator to generate and apply a preview, while the scheduler could independently run the closed loop. A global page also mixed portfolio-wide observation with one-strategy actions, so navigation could lose strategy scope and model context could read a pending preview that the product did not need. This made it unclear which path was authoritative and allowed a read-oriented research surface to appear capable of mutating lifecycle state.

## Decision

The sidebar Evolution entry is a global read-only dashboard. It reads only unscoped evolution status and attribution and presents the loop switch, participation groups, confidence tiers, mutation-origin markers, current decisions, active-strategy lineage, and recent automatically applied actions. Participation uses the product vocabulary “normal,” “watching,” “candidate,” “eliminated,” and “rejected”; tier 2 is shown independently as upgraded. Mutation is an origin marker and lineage input, never a separately counted participation group. Strategy rows, participation entries, lineage nodes, and history actions navigate to Strategy Research stage four with a controlled strategy id and optional return group.

Strategy Research stage four is a fixed one-strategy diagnostic. It reads scoped status and attribution using the same validated `strategy_id`, shows evidence, expected decision, lineage, and automatic history, and can return to the dashboard group that opened it. “Re-evaluate” means repeat those two reads; it does not request a preview, apply an action, or change strategy state. Only an active, non-archived strategy exposes that read-only refresh. AI context follows the same split: global and scoped evolution intents read status and attribution only.

The enabled scheduler is the sole product write path. Its unified automatic loop runs shadow validation, attribution, evolution application, candidate validation, and notification in order, isolates stage failures, and records applied actions for both dashboard and scoped inspection. Preview/run and scoped run behavior remain secured and tested solely for compatibility.

## Alternatives considered

**Keep manual preview and automatic application as equal product paths.** Two authorities can evaluate different state versions and make the audit trail ambiguous.

**Make the sidebar dashboard switch between global and strategy scope.** Scope switching hides navigation state inside an observation page and duplicates the strategy research stage.

**Treat re-evaluation as a dry-run preview.** A preview creates mutable token state and implies a later operator apply action; repeating scoped reads gives the requested fresh diagnosis without creating write-adjacent state.

## Consequences

The product has one visible observation model and one execution authority. Global and scoped requests cannot silently fall back into each other, non-active strategies remain inspectable, and model context cannot introduce a hidden preview workflow. The compatibility API remains larger than the product surface and therefore still needs security and regression tests. Operators who previously expected a confirmation button must instead inspect the automatic audit history and control the loop through deployment configuration.
