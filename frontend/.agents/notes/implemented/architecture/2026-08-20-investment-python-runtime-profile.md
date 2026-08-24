# Agent Note: Investment Python Runtime and Electron profile composition

Status: implemented

English | [中文](2026-08-20-investment-python-runtime-profile.zh.md)

## Problem

The investment function plugins need two Python HTTP services, but plugin activation cannot safely infer process ownership from a port or PID. A product launch also needs the existing Electron renderer and native carrier without copying the Web composition or putting process logic into patch-only bundles. The [investment package ownership decision](2026-08-20-investment-research-package-ownership.md) keeps HTTP/SSE mapping and model-visible rendering in the business packages; this decision owns the lifecycle and application composition beside them.

## Decision

`@deepseek-ai/dsh-investment-python-runtime` provides the Host service `ctx.investmentPythonRuntime`. Business plugins register complete backend definitions and acquire verified URL leases before registering tools. Per-backend acquisition is single-flight and leases are reference-counted. `managed` may spawn Uvicorn through the existing [`ctx.subprocess`](../../../../packages/subprocess/subprocess/README.md) service only after an identity-aware health probe explicitly reports connection refused. A healthy pre-existing managed endpoint is attached. `external` verifies an HTTP(S) endpoint without starting or stopping it.

Process authority comes only from the live `SubprocessHandle` returned to this Runtime instance. The last lease release and Runtime disposal terminate and join only those owned handles. A responding port, a PID in `runtime.json`, or stale state never authorizes adoption, signalling, or cleanup. Unknown network failures, occupied endpoints, and mismatched service identities fail startup while the other process remains alive. Logs and owner-only state under `$DSH_HOME/investment-research/<id>/` provide diagnostics, not recovery authority.

The three investment bundles remain patch-only and independently composable. `investment-runtime` inserts the Host service; `investment-stock-analysis` and `investment-market-watch` insert one business plugin each. The shipped `investment-research` profile orders five layers: base, web-app, investment-runtime, investment-stock-analysis, and investment-market-watch. Removing a capability bundle removes that plugin's tools and lease without removing the other capability or Runtime.

Electron selects a profile before native specialization. `dsh electron --profile investment-research` passes the profile name to the main process, which calls `runProfile` for those five layers and then applies only the existing `electron.patch.yml`. That patch disables the Web server, static Web runtime, Web connection, adaptive directory picker, and client HMR, then inserts the native connection and directory-picker rows. `dsh electron` retains `web` as its default. Configuration inspection stays a separate non-product command: `dsh --profile investment-research --dump-default-config`.

Source checkouts discover the two backend directories upward from the installed Runtime package. Deployments without that repository layout configure an absolute `backendProjectDir`. A missing virtual environment produces the platform's `./init.sh` or `init.bat` instruction and performs no installation. Python scheduler and external push configuration remain backend-owned; stock-analysis in-chat push defaults to false.

## Alternatives considered

**Infer ownership from a healthy port, PID file, or process scan.** Rejected because identity cannot prove that the current dsh instance created the process. Adoption turns stale diagnostics and port reuse into authority to terminate unrelated work.

**Start Python directly from each business plugin or capability bundle.** Rejected because two consumers would duplicate health policy, path resolution, log retention, single-flight, and teardown. Patch-only bundles would also become lifecycle implementations instead of composition layers.

**Add a top-level investment launcher or synchronize another profile format.** Rejected because the existing profile template, bundle manifest, module fallback, and `runProfile` path already own installation and composition.

**Copy the Web profile into an Electron-specific investment tree.** Rejected because the renderer and Host rows would drift. Selecting the ordinary profile first and applying the existing native patch preserves one Web composition and one Electron specialization point, consistent with the [Electron carrier decision](2026-08-18-electron-desktop-carrier.md).

## Verification

Package coverage pins URL and path validation, identity-aware health classification, registration conflicts, single-flight, reference counts, owned/attached/external release, bounded logs, state matching, cancellation, startup failures, and quiescent disposal. Real Loader tests pin bundle removal and external attachment; keyless replay pins the assembled twenty-tool investment profile. macOS and Windows CI run a real managed fake backend from a path containing spaces and CJK characters, while the manual engine workflow initializes both backend virtual environments and checks the composed twenty-tool profile. CLI and Electron tests pin argv forwarding, the five bundle layers, the Web-carrier removals, and the native rows.

## Consequences

The design reuses the process seam and profile machinery, gives every termination an in-memory owner, and keeps business packages and bundles narrow. It also requires backend identity endpoints and explicit project directories outside the source layout. An independently supervised service must use `external`; stale state is intentionally insufficient for automatic recovery. Electron remains coupled to the Web renderer composition but not to its listening transport.
