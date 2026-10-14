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
| Intel Mac | passed | PR CI final ZIP check passes |
| Windows | blocked | Final ZIP check reached the job limit; corrected native acceptance is pending |

Local evidence is retained at `/tmp/pab34-desktop-final`: `acceptance.json`, `verification.json`, two process reports and screenshots. ZIP SHA-256 is `f160e516a621bad4c0437f36502453b0f4d5291b48e57f39a5c35d2057738238`. The first-run notice overlays the rendered workbench; this does not establish manual acceptance of every business interaction. The local candidate retains the alpha.3 baseline version and is not an alpha.4 release; the PR bumps the shared version to alpha.4, whose final artifacts still require every native check.

The Windows job in [run 38358166115](https://github.com/PABIPRG/pa-investment-research/actions/runs/38358166115) reached its 90-minute limit, with about 75 minutes inside final ZIP acceptance and no evidence files. The missing extraction deadline, close-event wait and delayed log writes prevented distinguishing extraction from startup. The follow-up bounds extraction and process exit, uses direct file output, retains stage/failure records, and applies CLI/workflow deadlines. A local process fixture proves that a descendant can keep a pipe open after its parent exits; it does not prove that this caused the Windows incident. Keep Windows release-blocking until the corrected native check passes.

Follow-up validation: 27 focused tests, strict type checking and focused lint pass. The corrected script also passes both launches of the CI-produced alpha.4 darwin-arm64 ZIP in about 41 seconds; extraction takes about 14 seconds. Evidence is retained at `/tmp/pab34-timeout-alpha4-evidence`, with ZIP SHA-256 `4b9451883617f4651b5a98fa3755f6384a9fe88aea41ec81838a3ef64459d4c4`. This verifies the new supervisor against an unchanged real application artifact; the corrected Windows path remains unverified until native CI runs.

PR #166 exposed a second Windows limitation: the real corrupt-ZIP regression reached Vitest’s default 5-second timeout during extraction, before application packaging. Its supervisor budget remained 10 minutes and cleanup could remove evidence before the extractor finished. The fixture now owns a 30-second extraction budget plus 3 seconds for termination and confirmation within a 45-second test; it requires a nonzero extractor exit, retains failures and has dedicated artifact upload. PowerShell logs readiness and extraction milestones. The 27 focused tests, strict type checking and lint pass locally; Windows must still validate this correction. Production extraction deadlines remain unchanged.

On PR #166 commit 2100885a81, Windows spawned PowerShell but produced no first readiness marker within 30 seconds. The supervisor terminated the corrupt-ZIP test and retained its evidence. This locates the failure in the extraction child without proving whether initialization, the scrubbed environment or output handles caused it. Windows extraction invokes system System32/tar.exe directly to remove that PowerShell dependency; this is a remedy, not a confirmed diagnosis of the original hang. macOS retains ditto, with unchanged deadlines and failure blocking. A real deflate ZIP fixture checks binary bytes, empty files, Unicode and paths containing spaces and special characters; corrupt archives must still return nonzero. All 47 focused tests, strict type checking and lint pass locally; local BSD tar also passes valid and corrupt ZIP probes with the same scrubbed environment. Native Windows tar execution and final ZIP double launch remain unverified and block alpha.4.

Windows evidence from commit 530eca2a46 confirms that tar starts but fails to open a valid ZIP whose Chinese path appears as ?? in its error log, returning nonzero after about 60ms. The Unicode regression remains required. Windows uses the already locked extract-zip 2.0.1 as an explicit root-workspace development dependency without updating other dependencies. Its CLI runs in a separate child of the current Node executable with literal ZIP and destination arguments; the parent retains logs, deadlines and termination instead of using a Promise timeout that cannot stop extraction. macOS retains ditto to preserve application bundle metadata. Platform-independent Node extractor tests directly cover Chinese ZIP names and output paths, deflated bytes, empty files, actual corrupt-archive errors and unchanged ZIP bytes. All 49 focused tests, strict type checking and lint pass locally. Native Windows final ZIP acceptance remains pending on the new commit and cannot be replaced by these local cross-platform tests.

On commit e770a4d038, Windows native regressions, application packaging, bundled Python checks and final ZIP extraction pass, but the first Electron launch exceeds 120 seconds. The artifact contains no internal application log, so it cannot distinguish native initialization, module imports or backend loading. Acceptance enables Electron native file logging in chromium-<iteration>.log. After main-module imports and isolated configuration, startup-phases.log synchronously records instance-lock, readiness, profile, window, renderer, business-acceptance and shutdown milestones. Records contain only fixed stage names, timestamps, PIDs and launch iterations, without business data or environment values. Existing artifact globs collect both logs; deadlines, the environment allowlist and normal launches are unchanged. Both desktop workflows run entry-milestone and restart regressions. All 54 focused tests, Host/Electron build and strict acceptance-script type checks pass. The other modified diagnostic files pass lint; two existing main.ts lint reports on await disposeHoldings reproduce against the baseline and remain outside this fix. Windows cause and remediation still require native logs; alpha.4 remains blocked.

Local real-application validation of the diagnostics passes: an existing CI Mac app is extracted into an isolated temporary directory, given the newly built Electron main process, re-signed and zipped as a diagnostic-only candidate. It completes two launches, three owned backends, business reads, alert persistence, exit and unchanged ZIP-byte checks. All 15 phases are present for each launch and both Chromium logs are nonempty. The screenshot confirms rendered navigation, not completed workbench data loading or full business interaction. Evidence resides under the temporary pab34-startup-trace-029kdjwq/evidence directory; candidate SHA-256 is 559a5c0984d8a9447c3a7bebe5585b4f12bdd7386c8d50c1006ace8c6a5aabd6. This is not a release artifact and cannot replace native Windows acceptance.

## Risks

This is deep cross-layer startup acceptance. Signing, notarization, download quarantine and manual interactions across every screen are not proven by startup. Layout, colors and interactions are unchanged; rendering checks focus on the normal entry, not unrelated filtering, destructive actions or responsive redesign. Process visibility never authorizes termination.

Rollback restores these changes and rebuilds; no data migration or irreversible configuration change is involved. Alpha.3 build success is insufficient startup evidence. Alpha.4 remains unreleasable until native acceptance completes.
