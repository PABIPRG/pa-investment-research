# @deepseek-ai/dsh-investment-python-runtime

English | [中文](README.zh.md)

Host Service for registering, verifying, and leasing the Python endpoints used by investment-research plugins. `ctx.investmentPythonRuntime` centralizes backend identity, path resolution, health checks, subprocess ownership, diagnostics, and teardown; business plugins register complete definitions and use the verified `baseUrl` from a lease instead of starting Python or reading ports themselves.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME`, else `~/.dsh` | Root for owner-only logs and runtime state. |
| `startupTimeoutMs` | `30000` | Maximum managed startup duration. |
| `healthPollMs` | `250` | Delay between startup health probes. |
| `shutdownGraceMs` | `5000` | Grace passed to the subprocess tree termination ladder. |
| `logTailBytes` | `65536` | Maximum retained diagnostic tail included in startup errors. |
| `logMaxBytes` | `4194304` | Active backend log size that triggers one-file rotation on the next start. |

## Backend lifecycle

`managed` is the default business-plugin mode. The runtime validates a loopback HTTP URL, resolves the backend directory without using the caller's working directory, verifies the project virtual-environment interpreter, and probes `/health`. It starts Uvicorn only when the probe is explicitly connection-refused; an unknown network failure, occupied endpoint, or service-identity mismatch fails startup without touching the process that answered. A healthy service found before spawn is `attached`, while a child started through `ctx.subprocess` is `owned`.

`external` accepts HTTP or HTTPS, verifies the configured health identity, and returns an `external` lease. It never starts, signals, or stops the service. Releasing the last lease stops only an in-memory `owned` handle; attached and external services survive. Runtime disposal rejects new work, waits for in-flight acquisitions, and then joins every owned process tree. State files are diagnostic records and never authorize PID or port takeover.

Concurrent acquisitions for one backend id share one startup. Identical registrations are reference-counted; conflicting command, URL, mode, identity, or path definitions fail. Business tools are registered only after acquisition succeeds and are removed before their lease is released.

## Credentials and readiness

The investment profile reuses the Models settings page as the only product input for `DEEPSEEK_API_KEY`. The credential provider resolves that reference only while an `owned` managed child is being spawned, and the Runtime forwards it only to backend definitions that explicitly allow it. The value is never copied into a backend `.env`, Runtime state, logs, readiness snapshots, or Client Remote data. An `attached` or `external` endpoint receives no local credential; its operator owns that service's credentials.

Readiness reports backend ownership, safe credential facts, capability level, tool count, restart requirement, and the diagnostic log path. Updating the Key marks active owned backends `restart-required`; new LLM-dependent tool calls fail preflight until the application completes a quiescent restart. Non-LLM operations remain available according to their capability declaration.

## Project discovery and initialization

Source launches discover `backend/dsh-trading-core` and `backend/market-watch` by walking upward from this installed package. Initialize both environments in fixed order with `pnpm run investment:python:init`, then run the read-only check with `pnpm run investment:python:verify`. The verify command reports each missing environment and its init command without installing anything. A deployment without the repository layout must set the business plugin's absolute `backendProjectDir`; relative paths and missing directories fail. The interpreter is `<projectDir>/env/bin/python` on POSIX and `<projectDir>\env\Scripts\python.exe` on Windows.

Resolution is strict and ordered: an explicit absolute project/interpreter pair wins, then a complete source checkout with both Python environments, then an Electron `Resources/investment-python/runtime.json` sidecar. An invalid explicit candidate fails instead of falling through. A bundled descriptor is a closed manifest: every regular file must be listed with its SHA-256, paths must stay below the sidecar root, and a missing, extra, symlinked, or modified file reports the installation as damaged before Python starts. Packaged startup is offline and never installs or repairs dependencies.

The trading backend forwards an explicitly set `ADAPTER_RUNNER` to its owned child. Backend scheduler and push settings remain Python-owned; the shipped profile leaves stock-analysis in-chat push disabled (`enableInChatPush: false`) and does not reinterpret those settings as profile composition.

## Logs and state

Each backend writes `$DSH_HOME/investment-research/<id>/backend.log`, rotating an oversized file to `backend.previous.log`. Owned process metadata is atomically written to `runtime.json` with private permissions and removed only when it still matches the exact in-memory owned process. Startup diagnostics redact explicitly forwarded environment values.

Bundled application resources are read-only. For an owned bundled child, the Host sets `DSH_INVESTMENT_STATE_DIR=$DSH_HOME/investment-research/<id>` and derives backend data, cache, logs, state, and user configuration from that writable directory. Source mode keeps the existing repository-local defaults when that variable is absent.

## Model Experience

None, as this Host lifecycle service registers no prompt, tool schema, session event, or result.

#### KV Cache effect

None; business plugins own every model-visible contribution after their backend lease succeeds.

## Known Limitations and Deferred Work

- **Supported packaged targets are finite** — the lock currently builds macOS arm64, macOS x64, and Windows x64 sidecars; other targets use source or explicit configuration.
- **Dependency distribution hashes are deferred hardening** — target files pin every installed version and are themselves hashed, while individual wheel/sdist hashes remain a follow-up release-supply-chain gate.
- **State is diagnostic, not recovery authority** — a restarted dsh instance reports stale state but never adopts or kills a PID from disk; use `external` for independently supervised services.
- **One active and one previous log** — rotation is size-based at open time; long-running children do not rotate mid-process.
