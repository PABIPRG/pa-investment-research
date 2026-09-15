# Agent Note: Guided broker holdings synchronization

Status: implemented

English | [中文](2026-09-11-holdings-guided-sync.zh.md)

## Problem

The holdings workbench needed a broker-assisted replacement flow that could not silently clear or overwrite local positions. The original guided synchronization added preview-before-commit and platform-specific navigation, but macOS still lacked durable product consent, broker execution-time attribution, an in-flight cancellation contract, and a strict boundary preventing the renderer from obtaining backend preview credentials or bypassing native consent.

Tracked work: [PAB-16](https://linear.app/pabiprg/issue/PAB-16) and [PAB-25](https://linear.app/pabiprg/issue/PAB-25). Implementation context lives in the [PAB-16 handoff](../../../../../docs/superpowers/handoffs/2026-09-11-holdings-sync-implementation.md) and [PAB-25 plan](../../../../../docs/superpowers/plans/2026-09-15-pab25-macos-holdings-accessibility.md).

## Decision

### Platform and authorization

Windows retains its independent easytrader implementation and existing synchronization behavior. The PAB-25 change modifies and verifies only macOS Electron behavior; macOS verification is not presented as Windows regression evidence.

macOS performs no scheduled or background holdings reads. A read starts only from an explicit user click. Product consent can be per-read or durable: durable consent is established only after native confirmation, suppresses later prompts for user-initiated reads, can be revoked in Settings, and does not replace macOS Accessibility or Automation permission.

### Data and attribution

Every preview carries ticker, quantity, and cost. When the client exposes a complete trade table, positions also carry broker execution time, side, quantity, and price, with `broker_detail` provenance. When complete details are unavailable, the read timestamp is an explicit `read_fallback`; the user can edit it into `user_modified`, and later fallback-only reads preserve that manual value.

Snapshot identity includes the real or simulated account source. Repeated positions from the same account ignore a newly generated fallback read timestamp, but retain broker trades and user-modified attribution. An unchanged commit reuses the latest snapshot and returns `changed=false` instead of creating a duplicate business change.

### Host boundary and write safety

Electron rejects generic holdings preview and commit operations. The main process owns durable consent, the backend preview token, an opaque renderer session, and the final native replacement confirmation. Renderer messages are limited to fixed actions and cannot provide commands, URLs, client paths, operation ids, or backend tokens. The private backend route requires a host-only credential and an owned local backend.

Empty, partial, expired, canceled, conflicting, or already-consumed previews never replace local holdings. A successful commit validates account, provider, storage root, ticker-scoped time overrides, and the unchanged local baseline before the atomic write.

### Cancellation and focus

The renderer can cancel an active macOS read. The main process sends a private cancellation for its own operation id and aborts the request; the backend cancellation event stops AX traversal, and the production AppleScript fallback terminates its child process. Cancellation creates no renderer session and writes no holdings. The main process attempts to restore the investment application after success, failure, or cancellation.

## Testing

Backend tests pin preview/commit isolation, time provenance, manual-time preservation, cancellation, incomplete-table fallback, account-aware deduplication, and macOS parsing. Electron tests pin durable consent, revocation, foreground-only initiation, opaque sessions, native confirmation, cancellation, and focus restoration. Runtime and component tests pin the non-Remote boundary, the macOS manual-only interaction, editable fallback time, settings revocation, and unchanged-preview behavior.

Real signed-host validation against an installed and logged-in Tonghuashun client remains required for TCC ownership, actual AX labels, navigation, trade-table compatibility, cancellation, and focus restoration. Automated checks do not satisfy that UAT requirement; the current status and closing conditions are recorded in the [PAB-25 UAT handoff](../../../../../docs/superpowers/handoffs/2026-09-15-pab25-macos-holdings-uat.md).

## Alternatives considered

**Require a native prompt on every read.** This preserves a simple consent model but rejects the confirmed durable-authorization requirement. Durable consent is therefore product-scoped, explicitly revocable, and still cannot initiate a read by itself.

**Expose the backend preview token to the renderer and reuse generic sync.** This was rejected because an untrusted renderer could bypass the native consent and confirmation boundary. The main process instead maps each backend token to a short-lived opaque session.

**Use the read timestamp for every position.** This was rejected because broker execution time is required for attribution when details exist. Read time remains only a visible, editable fallback.

**Let the holdings reader send downstream notifications directly.** This was rejected because change detection and notification delivery have separate owners. The current baseline returns deterministic `changed` and `snapshot_id` facts; position-plan and notification-center integration must consume those facts without moving delivery ownership into this module.

## Consequences

The macOS workflow gains an explicit, revocable trust model, broker-first time attribution, idempotent snapshots, and a cancellable host-owned write boundary. It also depends on client accessibility labels that can vary by Tonghuashun release, and source-mode TCC ownership can differ from a signed application. Until real UAT records those facts, the macOS client compatibility claim remains unverified. Position-plan and notification-center consumers are not present in this baseline and remain a separate integration step; their absence does not permit duplicate events or direct notification delivery here.
