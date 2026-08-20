# DSH Integration Boundary, Native Composition, and Python Runtime Design

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
- Use dsh Profiles, plugin Bundles, Cordis services, and Agent Presets as the composition model instead of introducing a parallel module launcher.
- Automatically start the Python services required by an active capability while retaining an external-service deployment mode.
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
│       │   ├── python-runtime/
│       │   ├── trading-adapter-client/
│       │   ├── stock-analysis-plugin/
│       │   └── market-watch-plugin/
│       ├── bundles/
│       │   └── investment-research/
│       ├── agent-presets/
│       │   ├── stock-research/
│       │   ├── market-monitor/
│       │   └── investment-full/
│       ├── scripts/
│       │   └── sync-profile.ts
│       ├── package.json
│       ├── pnpm-lock.yaml
│       └── pnpm-workspace.yaml
└── frontend/                            # DeepSeek Harness source workspace
```

The package names will be:

- `@pa-investment/trading-adapter-client`
- `@pa-investment/dsh-python-runtime`
- `@pa-investment/dsh-stock-analysis`
- `@pa-investment/dsh-market-watch`
- `@pa-investment/dsh-investment-research`

All packages are private workspace packages. The workspace pins its package manager and every dsh dependency to exact versions. The migration preserves the dsh version proven by the team's current working reference environment; version discovery is a preflight check, not an opportunity to upgrade. If the current version cannot be established reproducibly, implementation pauses for an explicit version decision.

### Dependency rules

```text
DSH Profile: investment-research
├── Host plane
│   ├── python-runtime
│   ├── trading-core backend definition
│   └── market-watch backend definition
└── Agent Presets
    ├── stock-research  ─> stock-analysis-plugin ─> trading-core
    ├── market-monitor ─> market-watch-plugin ────> market-watch
    └── investment-full
        ├── stock-analysis-plugin ────────────────> trading-core
        └── market-watch-plugin ──────────────────> market-watch

Future standalone UI or host proxy
└── trading-adapter-client ─HTTP/SSE─> dsh-trading-core
```

- `trading-adapter-client` may depend on platform-neutral TypeScript libraries, but never on dsh packages, browser globals, React, or plugin lifecycle APIs.
- `stock-analysis-plugin` owns dsh registration, `agent.inject()`, rendering, and mapping transport progress into dsh progress events.
- `market-watch-plugin` remains a direct consumer of the market-watch API until reuse justifies a separate client package.
- `python-runtime` is a host-plane Cordis service. It owns Python process discovery, startup, health, logs, ownership, and disposal, but contains no business analysis logic.
- Model-facing business plugins are mounted by Agent Presets rather than globally by the Profile. A session therefore sees only the tools in its selected preset.
- The optional stock brief pusher is not allowed to enumerate and notify unrelated preset sessions from an agent-plane plugin. It moves to an explicit host-plane entry or remains disabled until it can target sessions by composed preset.
- Python services do not import, install, build, or launch the TypeScript workspace.
- `frontend/` does not depend on product-specific integration packages as part of this migration.

## DSH-Native Composition

### Deployment profile and bundle

The everyday entry point is the existing dsh CLI:

```sh
dsh --profile investment-research
```

The machine-local Profile lives at `$DSH_HOME/profiles/investment-research`. Its ordered bundle list includes the dsh base and Web application bundles plus `@pa-investment/dsh-investment-research`. The product bundle inserts only host-plane entries: the Python runtime service, backend definitions, and any explicitly host-scoped integrations. It does not globally insert model-facing stock or market-watch tools.

`integrations/dsh/scripts/sync-profile.ts` is an idempotent setup/update command, not an application launcher. It uses dsh's existing `plugin --profile` flow to create or reconcile the Profile, install the Web application and local product Bundle, and materialize the repository-owned Agent Preset templates into the dsh user preset root. Normal start, configuration dump, patch precedence, signal handling, and dsh shutdown remain owned by dsh.

Current dsh always supplies its own shipped preset root and appends `$DSH_HOME/.agent-presets` as the writable user root. It does not expose a bundle-contributed preset-root layer. Therefore the repository keeps canonical templates under `integrations/dsh/agent-presets`, while `sync-profile.ts` writes machine-local copies under `$DSH_HOME/.agent-presets`. Those copies use loader-resolvable package entries or URLs generated with `pathToFileURL`; committed templates contain no developer absolute path. Synchronization fails on a locally modified destination instead of overwriting user work silently.

### Agent presets

The initial preset catalog is:

| Preset | Model-facing business plugins | Python dependencies |
| --- | --- | --- |
| `stock-research` | stock analysis | `trading-core` |
| `market-monitor` | market watch | `market-watch` |
| `investment-full` | stock analysis and market watch | `trading-core`, `market-watch` |

The preset is selected when a new dsh session is created. It composes tools and prompt contributions through the existing agent scope chain. It does not own registries, persistence, Web infrastructure, or process-global services. A running session remains on the preset from which it was composed, matching dsh's existing semantics.

An Agent Preset is a complete `agent.cordis.yml`, not an overlay that inherits another preset. Each product preset therefore carries the pinned, reviewed dsh baseline capabilities it needs plus its business plugin rows. The synchronizer verifies the expected dsh baseline version and template fingerprint; a dsh upgrade requires an explicit preset regeneration and review instead of silently drifting from `standard`.

Adding a future capability means adding a plugin, a backend definition when required, and references from the presets that should expose it. It does not require another launcher flag or a new combined shell script.

## Python Runtime Service

`@pa-investment/dsh-python-runtime` provides the namespaced host service `ctx.paPythonRuntime`. Backend-definition entries register stable ids such as `trading-core` and `market-watch`. Agent-plane tool plugins inject the runtime service and acquire their backend id inside a Cordis effect before registering tools.

The first active preset that requests a backend triggers acquisition. Concurrent acquisitions are single-flight and share one process. A successful acquisition returns a lease containing the verified base URL; the business plugin passes that URL into its API client instead of rediscovering configuration. The plugin becomes ACTIVE only after health succeeds; an unavailable dependency fails preset composition instead of publishing tools that cannot work. Repeated sessions and presets share the healthy backend.

Releasing a lease decrements the backend reference count. The runtime stops an owned managed child only after its final lease is released or the host service is disposed; an attached external process is never stopped. Registering the same backend id with a conflicting command, health URL, or mode fails loudly during host composition.

Each backend definition supports two modes:

- `managed` is the current default. The runtime locates the project interpreter, starts the Python API, waits for health, captures logs, and stops only the child it owns.
- `external` never spawns or stops Python. It validates the configured base URL and allows the same tool plugin and preset to connect to a separately managed service.

`ADAPTER_RUNNER=fake|engine` remains an existing Python backend setting. It is passed to a managed child or configured in the external service; it is not promoted into a dsh Profile, Preset, or launcher dimension.

### Managed lifecycle

For a managed backend the service:

1. Resolves the repository and backend path from installed package metadata or the synchronized local workspace link, never from the caller's current directory.
2. Selects `env/bin/python` on macOS/Linux and `env\\Scripts\\python.exe` on Windows.
3. Checks the configured base URL before spawning. If an already-healthy service is present, it attaches without claiming process ownership.
4. If the port is occupied but health or service identity does not match, it fails without terminating the unknown process.
5. Spawns the API with an explicit working directory and child-only environment. Backend `.env` values are never merged into the parent dsh process.
6. Waits for health with a bounded timeout. Early exit or timeout preserves the relevant log tail, terminates the owned child, and rejects acquisition.
7. Registers asynchronous cleanup through `ctx.effect()`. Profile shutdown, dependency loss, or hot replacement waits for owned children to exit, escalating termination only after a bounded grace period.

The runtime records process state and logs under a machine-local dsh state directory. No absolute path, PID, secret, or generated profile is committed. Stale state is advisory only: process identity and health must be revalidated before any stop operation.

An unknown backend id, missing interpreter, malformed definition, external health failure, or managed startup failure is reported as a named capability-acquisition error. The message includes the backend id, attempted health URL, and an actionable initialization or log location, while excluding secrets and the full child environment. Preset mounting then follows dsh's existing fail-loud rollback behavior.

### Cross-platform repository rules

Backend initialization remains backend-owned. It creates the Python environment, installs `requirements.txt`, and creates a local `.env` from the example when absent. It must not run npm or pnpm.

The primary workflows are pnpm and dsh commands, not direct execution of shell files. Repository-level `.gitattributes` rules normalize source and shell scripts to LF and Windows batch files to CRLF. Any convenience wrappers contain no lifecycle or path logic, and the supported workflow works without `chmod`.

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

### Phase 2: Establish dsh-native composition and Python lifecycle

Create the investment-research Bundle, Profile synchronizer, three Agent Preset templates, and host-plane Python runtime service. Change the model-facing plugins to acquire their declared Python backend before tool registration. Keep the backend HTTP APIs unchanged.

Acceptance checks:

- `dsh --profile investment-research --dump-config` shows the Web application, product Bundle, Python runtime, and backend definitions without globally mounting business tools.
- A new `stock-research`, `market-monitor`, or `investment-full` session exposes exactly the tools declared by that Agent Preset.
- The first preset requiring a managed backend starts it automatically; concurrent requests do not spawn duplicates.
- `external` mode performs health validation without spawning or stopping the configured service.
- macOS and Windows both synchronize the Profile, discover Python, activate each preset, and shut down cleanly using the documented commands.
- Moving or cloning the repository to a path containing spaces requires no committed configuration edit.
- Starting dsh does not load backend `.env` values into the parent process implicitly.
- A busy port, missing virtual environment, failed backend health check, or failed child produces a clear composition failure and cleans up only owned children.
- Re-running Profile synchronization is idempotent and refuses to overwrite a locally modified Agent Preset.

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
| Profile synchronization | Required | Required |
| Cordis plugin URL when generated | `pathToFileURL` | `pathToFileURL` |
| Preset tool isolation | Required | Required |
| Managed fake-runner smoke test | Required | Required |
| Managed engine startup and health | Required | Required |
| External-service attach | Required | Required |
| Graceful dsh disposal and stale-state cleanup | Required | Required |

CI should run static checks and deterministic unit tests on both operating systems. Engine and dsh integration tests may require environment credentials and can run as an explicit smoke job, but the fake runner path must be credential-free.

## Documentation Ownership

- `backend/dsh-trading-core/README.md` documents only Python initialization, configuration, API startup, and API verification.
- `backend/market-watch/README.md` documents only the Python service.
- `integrations/dsh/README.md` documents pnpm setup, Profile synchronization, Bundle and Preset ownership, plugin development, Python lifecycle modes, generated state, and macOS/Windows commands.
- API/SSE contract details have one canonical source next to the Python adapter; the TypeScript package links to it and verifies compatibility in tests.

## Risks and Mitigations

- **Lost file history:** use `git mv` and keep Phase 1 mechanical so Git can detect renames.
- **Accidental dsh upgrade:** resolve and pin the already-proven version before changing runtime behavior.
- **Windows URL/path regressions:** use Node URL/path APIs and test a path containing spaces on Windows.
- **Preset-root limitation:** keep canonical templates in the repository and synchronize guarded copies to dsh's existing user preset root; never patch dsh core to invent another root mechanism in this migration.
- **Preset scope leakage:** keep model-facing registrations in the agent plane and move any process-wide polling or broadcast behavior to an explicit host-plane entry.
- **Stale child processes:** record ownership, validate process identity before stopping it, and clean state after exit.
- **Contract drift:** keep Python as the authoritative API and test the TypeScript client against captured contract fixtures plus a fake-runner smoke test.
- **Scope creep into frontend:** prohibit changes under `frontend/` unless a later, separately designed consumer integration requires them.

## Completion Criteria

The migration is complete when backend directories are Python-only under the definition above; the two business plugins, product Bundle, Python runtime, and Agent Presets live under `integrations/dsh`; the shared stock-analysis client is dsh-independent; no committed machine-specific path remains; each preset exposes only its declared tools; and managed plus external lifecycle checks succeed on both macOS and Windows through the native dsh Profile flow.
