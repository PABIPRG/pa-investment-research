# @deepseek-ai/dsh-investment-python-runtime

English | [中文](README.zh.md)

Host Service for registering, verifying, and leasing the Python endpoints used by investment-research plugins. `ctx.investmentPythonRuntime` centralizes backend identity, path resolution, health checks, subprocess ownership, diagnostics, and teardown; business plugins register complete definitions and use the verified `baseUrl` from a lease instead of starting Python or reading ports themselves.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME`, else `~/.dsh` | Root for owner-only logs and runtime state. |
| `startupTimeoutMs` | `30000` | Maximum managed startup duration. |
| `healthPollMs` | `250` | Delay between startup health probes. |
| `healthFreshnessMs` | `5000` | Reuse window for a successful active-backend health probe; `0` disables reuse. |
| `healthTimeoutMs` | `2000` | Maximum duration of one backend health request. |
| `shutdownGraceMs` | `5000` | Grace passed to the subprocess tree termination ladder. |
| `logTailBytes` | `65536` | Maximum retained diagnostic tail included in startup errors. |
| `logMaxBytes` | `4194304` | Active backend log size that triggers one-file rotation on the next start. |

## Backend lifecycle

`managed` is the default business-plugin mode. The runtime validates a loopback HTTP URL, resolves the backend directory without using the caller's working directory, verifies the project virtual-environment interpreter, and probes `/health`. It starts Uvicorn only when the probe is explicitly connection-refused; an unknown network failure, occupied endpoint, or service-identity mismatch fails startup without touching the process that answered. A healthy service found before spawn is `attached`, while a child started through `ctx.subprocess` is `owned`.

`external` accepts HTTP or HTTPS, verifies the configured health identity, and returns an `external` lease. It never starts, signals, or stops the service. Releasing the last lease stops only an in-memory `owned` handle; attached and external services survive. Runtime disposal rejects new work, waits for in-flight acquisitions, and then joins every owned process tree. State files are diagnostic records and never authorize PID or port takeover.

Concurrent acquisitions for one backend id share one startup. Active acquisitions reuse a recent successful health result, while requests arriving after it expires share one health probe. Each probe has a bounded deadline; owned-process exit, restart-required credential updates, teardown, and non-healthy readiness invalidate the reusable result. Identical registrations are reference-counted; conflicting command, URL, mode, identity, or path definitions fail. Business tools are registered only after acquisition succeeds and are removed before their lease is released.

## Credentials and readiness

The investment profile reuses the Models settings page as the only product input for `DEEPSEEK_API_KEY`. The credential provider resolves that reference only while an `owned` managed child is being spawned, and the Runtime forwards it only to backend definitions that explicitly allow it. The value is never copied into a backend `.env`, Runtime state, logs, readiness snapshots, or Client Remote data. An `attached` or `external` endpoint receives no local credential; its operator owns that service's credentials.

Readiness reports backend ownership, safe credential facts, capability level, tool count, restart requirement, and the diagnostic log path. Updating the Key marks active owned backends `restart-required`; new LLM-dependent tool calls fail preflight until the application completes a quiescent restart. Non-LLM operations remain available according to their capability declaration, and a healthy `industry-chain` capability that declares `llm: none` reports `industry-full` without reading a model credential.

## Project discovery and initialization

Source launches discover `backend/dsh-trading-core`, `backend/market-watch`, and `backend/industry-chain` by walking upward from this installed package. Initialize all three environments in fixed order with `pnpm run investment:python:init`, then run the read-only check with `pnpm run investment:python:verify`. Industry-chain initialization and verification do not download seed data; first download remains a separate user-confirmed product action. The verify command reports each missing environment and its init command without installing anything. A deployment without the repository layout must set the business plugin's absolute `backendProjectDir`; relative paths and missing directories fail. The interpreter is `<projectDir>/env/bin/python` on POSIX and `<projectDir>\env\Scripts\python.exe` on Windows.

Resolution is strict and ordered for each backend: an explicit absolute project/interpreter pair wins, then the matching source-checkout backend and environment, then an Electron `Resources/investment-python/runtime.json` sidecar. An invalid explicit candidate fails instead of falling through. A bundled descriptor is a closed manifest containing exactly `trading-core` at `adapter.app:app`, `market-watch` at `market_watch.app:app`, and `industry-chain` at `industry_chain.app:app`; every regular file must be listed with its SHA-256, paths must stay below the sidecar root, and a missing, extra, symlinked, or modified file reports the installation as damaged before Python starts. Packaged startup is offline and never installs or repairs dependencies.

The trading backend forwards an explicitly set `ADAPTER_RUNNER` to its owned child. Backend scheduler and push settings remain Python-owned; the shipped profile leaves stock-analysis in-chat push disabled (`enableInChatPush: false`) and does not reinterpret those settings as profile composition.

## Logs and state

Each backend writes `$DSH_HOME/investment-research/<id>/backend.log`, rotating an oversized file to `backend.previous.log`. Owned process metadata is atomically written to `runtime.json` with private permissions and removed only when it still matches the exact in-memory owned process. Startup diagnostics redact explicitly forwarded environment values.

Bundled application resources are read-only. For an owned bundled child, the Host sets `DSH_INVESTMENT_STATE_DIR=$DSH_HOME/investment-research/<id>` and derives backend data, cache, logs, state, and user configuration from that writable directory. In particular, industry-chain seed data lives at `$DSH_HOME/investment-research/industry-chain/data/seed`. Source mode keeps the existing repository-local defaults when that variable is absent.

The sidecar does not redistribute industry-chain seed data and startup never downloads it. `industry-chain.data-status` reads the local `missing`, `downloading`, `ready`, or `error` state without network access. Only an explicit, user-initiated `industry-chain.data-bootstrap` starts the fixed five-file download. The backend bounds file sizes, validates JSON and minimum structure in a temporary directory, publishes only the complete dataset, cleans failed staging data, and deduplicates concurrent bootstrap requests.

## Browser-safe data operations

The Host's `request-data` Remote accepts only compile-time-enumerated operations and each operation's known input keys. The browser cannot supply a backend origin, arbitrary URL, or arbitrary path. Dynamic report, strategy, and task ids must match a restricted identifier format and pass through `encodeURIComponent` before joining a fixed route; unknown keys, invalid enums, out-of-range numbers, and unsafe ids are rejected before a backend lease is acquired.

The allowlist covers market observation in `market-watch`; personal research data plus analysis, brief, backtest, unified report list/detail, strategy hypothesis/transition/run, shadow status/positions/equity/run, evolution status/attribution/run, personalized matches/industry impact, and background-task status/result in `trading-core`; and the no-input `GET /data/status` and `POST /data/bootstrap` lifecycle routes, graph statistics, company search/detail, entity profiles, single-company views, multi-level chains, and filtered networks in `industry-chain`. Both lifecycle operations return `{ status, files_completed, files_total, downloaded_bytes, current_file, error }`; bootstrap is one long non-streaming request while status can be polled for progress. Entity business names may contain `/` and are encoded as one parameter, while traversal-like segments and unsafe identifiers are rejected. The browser cannot supply a download URL or body. The Host constructs write-operation JSON bodies from known keys, while reports and read-only state use fixed GET routes; it never exposes arbitrary backend access or synthetic results.

Personalized feedback and the five `trading-core.local-learning-*` operations are local-only. They accept only opaque object ids, enumerated actions and surfaces, and a fixed structured-context projection; search terms, prompts, titles, report content, holdings quantities or costs, URLs, paths, and credential-like fields have no protocol slot. Invalid values fail before acquisition. If a verified lease is `external`, the Host releases it and rejects the operation before `fetch`, so local preference facts cannot be forwarded to a configured remote trading service. An `owned` or `attached` local service assigns the authoritative timestamp and applies the retention policy.

## Model Experience

None, as this Host lifecycle service registers no prompt, tool schema, session event, or result.

#### KV Cache effect

None; business plugins own every model-visible contribution after their backend lease succeeds.

## Known Limitations and Deferred Work

- **Supported packaged targets are finite** — the lock currently builds macOS arm64, macOS x64, and Windows x64 sidecars; other targets use source or explicit configuration.
- **Dependency distribution hashes are deferred hardening** — target files pin every installed version and are themselves hashed, while individual wheel/sdist hashes remain a follow-up release-supply-chain gate.
- **State is diagnostic, not recovery authority** — a restarted dsh instance reports stale state but never adopts or kills a PID from disk; use `external` for independently supervised services.
- **One active and one previous log** — rotation is size-based at open time; long-running children do not rotate mid-process.
