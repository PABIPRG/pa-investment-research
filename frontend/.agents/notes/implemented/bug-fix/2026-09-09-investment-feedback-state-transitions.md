# Agent Note: Investment feedback state transitions

Status: implemented

English | [中文](2026-09-09-investment-feedback-state-transitions.zh.md)

## Problem

Three investment surfaces presented valid data but left the visible state behind the user's action. Opening a full security page hid the floating research window instead of ending it, so the retained route could revive the window without reliable controls. Strategy diagnosis buried cumulative return among secondary facts. A successful backup import updated durable Host state while mounted browser surfaces kept their pre-import snapshots.

## Decision

Opening full security detail from the floating research window consumes that window state and suppresses the one-shot Realtime Watch query restoration on return. Other security-detail entry points retain their existing return-query behavior.

Each strategy diagnosis row presents signed cumulative return as the primary right-aligned value. Positive values use the semantic red market token, negative values use the semantic green market token, and zero or missing values remain neutral; participation and confidence stay as subordinate text, and the expanded evidence keeps the same raw metric.

A successful portable-backup import calls a browser reload callback injected by the package registration after the Host confirms the import. Import failure does not reload and remains inside the existing dialog recovery path. The component does not broadcast an unowned custom event as a substitute for refreshing mounted data owners.

## Alternatives considered

**Suspend the research window across security detail.** This preserved fetched content but retained ownership after the user had explicitly left the window, which allowed route restoration to recreate the broken state.

**Refresh every investment store through a browser event.** No mounted owner subscribed to the old event, and adding distributed listeners would require every current and future data surface to coordinate cache invalidation. Reloading after a successful import gives all owners one authoritative restart boundary.

**Show return only in expanded evidence.** This kept the row visually quiet but hid the main comparison value and made scanning strategy performance unnecessarily slow.

## Consequences

The three actions now have explicit completion boundaries: detail navigation ends its source window, strategy rows expose comparable performance without removing diagnostic state, and import success rehydrates the full browser product. Reloading discards temporary presentation state such as scroll position and open dialogs, which is intentional after a broad data import; failed imports preserve that state for recovery.
