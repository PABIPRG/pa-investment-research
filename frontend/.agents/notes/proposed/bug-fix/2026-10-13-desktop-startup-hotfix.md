# Agent Note: Desktop cold-start isolation and final ZIP acceptance

Status: proposed

English | [中文](2026-10-13-desktop-startup-hotfix.zh.md)

## Problem

DESKTOP-STARTUP-001 / [PAB-34](https://linear.app/pabiprg/issue/PAB-34) records alpha.3 health probes timing out after 2000ms. Its 19842-file descriptor took about 2779ms to verify synchronously on the affected machine, blocking timers. Long-lived source backends also occupied default ports. Import and integrity checks cannot prove the Electron tree, window, backends, exit and restart work together.

## Proposal

Reuse complete validation with event-loop yields between files and directories. Share one asynchronous verification and cache success or failure; readiness reads the result without a synchronous scan. Each individual file is still read and hashed together, so very large files can briefly block.

Electron managed children use three distinct ephemeral loopback ports, skip old-port probes and require a per-start health UUID. This UUID identifies a launch, not an access credential. Pass actual peer addresses to children while preserving DSH_HOME. Explicit external mode preserves configured addresses and ownership. Bind races after releasing reservations fail without adopting or killing a process by port or diagnostic PID; only in-memory owned handles authorize termination.

Retry probe timeouts and transient unavailability within the startup budget. Identity mismatch and child exit fail before exposing a lease. Active health failure invalidates the backend without automatic replacement.

Extract the final staged ZIP and launch it twice with disposable HOME, DSH_HOME and userData. Check three bundled identities, keyless business reads, persisted disabled alerts, rendered navigation and child exit. Retain reports, screenshots, logs and ZIP SHA-256. Failure blocks upload and publication; accepted assets are not rebuilt.

Artifact acceptance also exposed `public-observatory` waiting for disabled Web services. The Electron overlay disables that Web-only entry; healthy backends do not replace complete tree activation.

This partially extends [Python runtime lifecycle](../../implemented/architecture/2026-08-20-investment-python-runtime-profile.md) for desktop children and [desktop release acceptance](../../implemented/process/2026-09-07-investment-desktop-github-release.md). Other consumers and release identity locking retain those decisions; neither record is fully superseded.

## Implementation and validation sequence

1. Capture failing event-loop and stale-service regressions; implement runtime and health identity, then cover slow probes, mismatches, external mode and cleanup.
2. Build real Host/Electron and a native ZIP with isolated resources, without remote servers or shared services.
3. Run dual-launch acceptance and inspect rendering and persistence; rebuild and retest after failures.
4. Record local evidence and untested platforms. The PR prepares alpha.4; merging and publishing require separate authorization.

## Alternatives considered

**Increase the timeout only.** This removes neither event-loop starvation nor stale-service attachment.

**Skip integrity verification.** Damaged dependencies could reach startup, violating existing completeness guarantees.

**Automatically clear fixed ports.** Ports, service names and disk PIDs do not establish ownership and may identify unrelated development services.

**Only run Python import smoke.** Retain it as supporting evidence; it cannot exercise Electron composition, rendering or shutdown.

## Acceptance criteria

| Concern | Current status | Passing condition |
|---|---|---|
| Complete verification and timer liveness | passed | 19842 files in 2623ms with 125 timer ticks at 20ms; tampering and shared-cache regressions pass |
| Old ports and identity races | passed | Wrong UUID rejected; existing 8000/8100 listener PIDs remain 24703/24704; all owned children exit |
| Native final ZIP | passed | macOS arm64 window, bundled backends, business reads, persisted disabled alert, two launches, exit and post-run signature pass |
| Windows / Intel Mac | not-tested | Native CI runs the same ZIP check and blocks publication on failure |

Local evidence is retained at `/tmp/pab34-desktop-final`: `acceptance.json`, `verification.json`, two process reports and screenshots. ZIP SHA-256 is `f160e516a621bad4c0437f36502453b0f4d5291b48e57f39a5c35d2057738238`. The first-run notice overlays the rendered workbench; this does not establish manual acceptance of every business interaction. The local candidate retains the alpha.3 baseline version and is not an alpha.4 release; the PR bumps the shared version to alpha.4, whose final artifacts still require every native check.

## Risks

This is deep cross-layer startup acceptance. Signing, notarization, download quarantine and manual interactions across every screen are not proven by startup. Layout, colors and interactions are unchanged; rendering checks focus on the normal entry, not unrelated filtering, destructive actions or responsive redesign. Process visibility never authorizes termination.

Rollback restores these changes and rebuilds; no data migration or irreversible configuration change is involved. Alpha.3 build success is insufficient startup evidence. Alpha.4 remains unreleasable until native acceptance completes.
