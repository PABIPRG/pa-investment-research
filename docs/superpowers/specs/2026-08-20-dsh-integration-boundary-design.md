# DSH Integration Boundary and Cross-Platform Runtime Design

## Status

Proposed for written-spec review. The architecture direction has been approved in conversation, but implementation does not begin until this document is accepted.

## Context

The repository currently stores two TypeScript dsh plugins inside Python backend projects:

- `backend/dsh-trading-core/dsh-plugin`
- `backend/market-watch/dsh-plugin`

This causes three concerns to overlap:

1. Python services own Node dependencies, TypeScript source, Cordis configuration, and npm lifecycle steps.
2. Local startup depends on operating-system-specific paths, Python virtual-environment layouts, shell permissions, and Cordis `file://` URLs.
3. The stock-analysis plugin client mixes transport logic with dsh-only APIs such as `agent.inject()`, preventing reuse by a normal browser or Node consumer.

The existing top-level `frontend/` directory is the DeepSeek Harness source workspace. It is not the ownership boundary for product-specific plugins or clients and must remain independent from this migration.

## Goals

- Keep backend application code Python-only.
- Give product-specific dsh integration code an explicit TypeScript workspace outside both backend services and the upstream-style frontend workspace.
- Make supported startup and verification flows equivalent on macOS and Windows.
- Provide one pure TypeScript HTTP/SSE client that can be reused by a dsh plugin and a future UI or host proxy.
- Preserve backend API behavior while changing ownership and physical layout.
- Make local paths and generated configuration machine-local rather than committed absolute paths.

“Python-only backend” means backend directories contain no TypeScript source, `package.json`, npm/pnpm lockfiles, `node_modules`, or Cordis/dsh plugin manifests. Small `.sh` and `.bat` wrappers may remain only when they operate the Python service itself; orchestration involving Node or dsh belongs under `integrations/dsh`.

## Non-goals

- Rewriting either Python service.
- Changing the stock-analysis or market-watch API contract during the directory move.
- Modifying the DeepSeek Harness source under `frontend/`.
- Introducing Docker as the primary local-development workflow.
- Extracting a shared market-watch client before a second real consumer needs it.
- Upgrading dsh as part of the boundary migration.

## Architecture Decision

Create an independent pnpm workspace at `integrations/dsh`:

```text
pa-investment-research/
├── backend/
│   ├── dsh-trading-core/                # Python service
│   │   ├── adapter/
│   │   ├── adapter_client/              # Existing Python client remains
│   │   ├── tradingagents/
│   │   ├── config/
│   │   └── requirements.txt
│   └── market-watch/                    # Python service
│       └── market_watch/
├── integrations/
│   └── dsh/                             # Product-owned TypeScript workspace
│       ├── packages/
│       │   ├── trading-adapter-client/
│       │   ├── stock-analysis-plugin/
│       │   └── market-watch-plugin/
│       ├── scripts/
│       │   └── runtime.ts
│       ├── package.json
│       ├── pnpm-lock.yaml
│       └── pnpm-workspace.yaml
└── frontend/                            # DeepSeek Harness source workspace
```

The package names will be:

- `@pa-investment/trading-adapter-client`
- `@pa-investment/dsh-stock-analysis`
- `@pa-investment/dsh-market-watch`

All three packages are private workspace packages. The workspace pins its package manager and every dsh dependency to exact versions. The migration preserves the dsh version proven by the team's current working reference environment; version discovery is a preflight check, not an opportunity to upgrade. If the current version cannot be established reproducibly, implementation pauses for an explicit version decision.

### Dependency rules

```text
Future UI or host proxy ─┐
                        ├─> trading-adapter-client ─HTTP/SSE─> dsh-trading-core
Stock analysis plugin ──┘

Market watch plugin ─────────────HTTP───────────────> market-watch
```

- `trading-adapter-client` may depend on platform-neutral TypeScript libraries, but never on dsh packages, browser globals, React, or plugin lifecycle APIs.
- `stock-analysis-plugin` owns dsh registration, `agent.inject()`, rendering, and mapping transport progress into dsh progress events.
- `market-watch-plugin` remains a direct consumer of the market-watch API until reuse justifies a separate client package.
- Python services do not import, install, build, or launch the TypeScript workspace.
- `frontend/` does not depend on product-specific integration packages as part of this migration.

## Cross-Platform Runtime Design

`integrations/dsh/scripts/runtime.ts` is the single source of truth for combined local orchestration. Thin `start.sh`/`stop.sh` and `start.bat`/`stop.bat` wrappers may invoke the same pnpm scripts, but contain no path or lifecycle logic.

The primary documented interface is a pnpm command, not direct execution of a shell file. This avoids making the normal workflow depend on Git executable-bit behavior on Windows. Convenience shell wrappers are committed with the executable bit set and tested on macOS; batch wrappers are tested on Windows.

The runtime command supports `start`, `stop`, `status`, and `verify`, with `fake`, `engine`, and `dry-run` runner modes where applicable.

It is responsible for:

- Resolving the repository root from the script location rather than the caller's current directory.
- Selecting `env/bin/python` on macOS/Linux and `env\\Scripts\\python.exe` on Windows.
- Failing with a clear initialization command when the selected Python interpreter does not exist.
- Building plugin entry URLs with Node's `pathToFileURL`; string concatenation for `file://` URLs is forbidden.
- Generating a machine-local Cordis patch at `integrations/dsh/.runtime/cordis.local.yml`; `.runtime/` is ignored by Git.
- Passing an ordinary absolute path to dsh's `--patch` argument while storing plugin entry names inside the patch as valid `file://` URLs.
- Starting dsh from an OS temporary directory that does not contain the repository `.env`, so dsh cannot accidentally consume backend environment variables.
- Tracking child process IDs and logs under `.runtime/` and shutting down only processes it started.
- Checking port availability before startup and health endpoints after startup.
- Preserving actionable child-process errors and returning a non-zero exit code on partial startup.
- Handling `SIGINT`, `SIGTERM`, and Windows termination without leaving owned processes running.

Generated state is disposable. No absolute developer path, process ID, secret, or generated Cordis patch is committed.

Backend initialization remains backend-owned and platform-specific only at the wrapper edge. It creates the Python environment, installs `requirements.txt`, and creates a local `.env` from the example when absent. It must not run npm or pnpm.

Repository-level `.gitattributes` rules normalize source and shell scripts to LF and Windows batch files to CRLF. Scripts do not rely on shell syntax shared by name but interpreted differently across platforms. Permission repair instructions may be documented for exceptional checkouts, but the supported pnpm entry point must work without `chmod`.

## TypeScript Client Design

The reusable client is organized as:

```text
integrations/dsh/packages/trading-adapter-client/src/
├── contracts.ts
├── http.ts
├── sse.ts
└── tradingAdapterClient.ts
```

- `contracts.ts` defines request, response, progress-event, and normalized-error types that mirror the Python adapter contract.
- `http.ts` owns base-URL handling, JSON requests, HTTP status mapping, timeouts, cancellation, and error normalization.
- `sse.ts` is a transport-only incremental SSE decoder. It has no knowledge of stocks, dsh, or UI rendering.
- `tradingAdapterClient.ts` exposes domain methods such as `analyzeStock`, `analyzeHoldings`, `generateBrief`, and watchlist operations by composing `http.ts` and `sse.ts`.

The public client accepts an injected `fetch` implementation and base URL. This makes it usable in modern browsers and Node without coupling tests to a live server. It does not read `.env` or choose a production endpoint; the consumer supplies configuration.

### SSE contract

The client consumes the adapter's existing event names rather than inventing a parallel protocol.

- Success order: zero or more `stage` events, exactly one `result`, then `done` or stream close.
- Failure order: zero or more `stage` events, one `error`, then stream close.
- A stream that closes without either `result` or `error` is a normalized incomplete-stream error.
- An explicit `error` event wins over later malformed or trailing data.
- Cancellation and timeout errors remain distinguishable from HTTP, protocol, and backend errors.

The parser supports LF and CRLF line endings, arbitrary byte chunk boundaries, UTF-8 code points split across chunks, comments, multi-line `data:` fields, optional `event:` fields, and a final frame without a trailing blank line.

## Error Model

The TypeScript client exposes a stable error shape containing:

- `kind`: `http`, `backend`, `protocol`, `timeout`, `cancelled`, or `network`
- a human-readable message
- optional HTTP status
- optional backend error code and details
- the original cause when available

Expected statuses such as `404` and `409` are mapped without losing response details. Secrets, authorization headers, and full environment contents are never included in errors or logs.

## Migration Sequence

Each phase is a separate reviewable pull request. A later phase starts only after the previous phase passes its acceptance checks.

### Phase 1: Correct physical ownership

Use history-preserving moves where possible:

- `backend/dsh-trading-core/dsh-plugin` to `integrations/dsh/packages/stock-analysis-plugin`
- `backend/market-watch/dsh-plugin` to `integrations/dsh/packages/market-watch-plugin`

Create the independent pnpm workspace, update package names and all repository references, and move dsh-specific documentation to the integration boundary. Remove npm installation from backend initialization. This phase must not refactor runtime behavior or the mixed client implementation; it establishes the correct ownership boundary first.

Acceptance checks:

- Both plugins build and their existing tests pass from `integrations/dsh`.
- Existing plugin smoke flows produce the same result as before the move.
- Backend initialization installs no Node dependencies.
- No TypeScript, Node package manifest, lockfile, Cordis patch, or dsh plugin directory remains below `backend/`.
- Documentation contains no obsolete repository path or Windows-only command presented as cross-platform.

### Phase 2: Centralize cross-platform runtime

Implement `runtime.ts`, thin platform wrappers, generated Cordis configuration, health checks, and process ownership. Replace broken or duplicated combined-start instructions with the workspace commands.

Acceptance checks:

- `dry-run` snapshots resolve valid macOS and Windows Python paths and plugin URLs without launching processes.
- macOS and Windows both complete `start`, `status`, `verify`, and `stop` using the documented commands.
- Moving or cloning the repository to a path containing spaces requires no committed configuration edit.
- Starting dsh does not load the backend `.env` implicitly.
- A busy port, missing virtual environment, failed backend health check, or failed dsh child produces a clear non-zero failure and cleans up owned children.

### Phase 3: Extract the reusable client

Move transport and contract logic out of the stock plugin into `trading-adapter-client`. Keep only dsh-specific injection and presentation in the plugin. Switch the plugin to the workspace client without changing the Python API.

Acceptance checks:

- The client package imports no dsh package and references no `agent.inject()` API.
- The stock plugin remains behaviorally equivalent in its smoke flow.
- Unit tests cover LF/CRLF, chunk boundaries, split UTF-8, multi-line data, final unterminated frames, `404`, `409`, backend error events, network failure, timeout, cancellation, and missing-result closure.
- Package type checks, builds, and tests pass from the workspace root.

## Verification Matrix

The minimum supported matrix is:

| Area | macOS | Windows |
| --- | --- | --- |
| Python environment discovery | `env/bin/python` | `env\\Scripts\\python.exe` |
| Repository path with spaces | Required | Required |
| Cordis plugin URL | `pathToFileURL` | `pathToFileURL` |
| Fake runner smoke test | Required | Required |
| Engine runner startup and health | Required | Required |
| dsh start from clean temporary cwd | Required | Required |
| Graceful stop and stale-state cleanup | Required | Required |

CI should run static checks and deterministic unit tests on both operating systems. Engine and dsh integration tests may require environment credentials and can run as an explicit smoke job, but the fake runner path must be credential-free.

## Documentation Ownership

- `backend/dsh-trading-core/README.md` documents only Python initialization, configuration, API startup, and API verification.
- `backend/market-watch/README.md` documents only the Python service.
- `integrations/dsh/README.md` documents pnpm setup, plugin development, generated runtime state, combined startup, and macOS/Windows commands.
- API/SSE contract details have one canonical source next to the Python adapter; the TypeScript package links to it and verifies compatibility in tests.

## Risks and Mitigations

- **Lost file history:** use `git mv` and keep Phase 1 mechanical so Git can detect renames.
- **Accidental dsh upgrade:** resolve and pin the already-proven version before changing runtime behavior.
- **Windows URL/path regressions:** use Node URL/path APIs and test a path containing spaces on Windows.
- **Stale child processes:** record ownership, validate process identity before stopping it, and clean state after exit.
- **Contract drift:** keep Python as the authoritative API and test the TypeScript client against captured contract fixtures plus a fake-runner smoke test.
- **Scope creep into frontend:** prohibit changes under `frontend/` unless a later, separately designed consumer integration requires them.

## Completion Criteria

The migration is complete when backend directories are Python-only under the definition above, the two dsh plugins build from `integrations/dsh`, the shared stock-analysis client is dsh-independent, no committed machine-specific path remains, and the documented lifecycle succeeds on both macOS and Windows with the same high-level commands.
