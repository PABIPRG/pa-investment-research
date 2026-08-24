# Investment research Python runtime

English | [中文](investment-research.zh.md)

This subsystem is the Host lifecycle capability between investment-research function plugins and their Python HTTP endpoints. [`@deepseek-ai/dsh-investment-python-runtime`](../../packages/investment-research/python-runtime/README.md) provides `ctx.investmentPythonRuntime`; stock analysis and market watch register backend definitions and hold leases, while the existing [`ctx.subprocess`](subprocess.md) provider owns process-tree primitives. The Runtime does not contain HTTP/SSE business clients or model-facing tools.

Source: [`packages/investment-research/python-runtime/src/types.ts`](../../packages/investment-research/python-runtime/src/types.ts)

## Backend identity and ownership mode

```ts type-equiv
/** Stable investment Python backend identifiers. */
type InvestmentBackendId = 'trading-core' | 'market-watch'
```

```ts type-equiv
/** Backend ownership modes selected by plugin configuration. */
type InvestmentBackendMode = 'managed' | 'external'
```

An id is the registry key and expected service identity. `managed` permits one local spawn only after an identity-aware health probe explicitly reports connection refused; a healthy pre-existing service becomes `attached`. `external` only verifies an HTTP(S) service. The ownership on a lease records what this Runtime instance may stop: only `owned`.

## Backend definitions

```ts type-equiv
/** Complete definition required to verify or start one Python backend. */
interface PythonBackendDefinition {
  /** Stable registry and diagnostic identifier. */
  readonly id: InvestmentBackendId
  /** Service identity required from the health response. */
  readonly service: InvestmentBackendId
  /** Whether dsh may own a child or only verify an external service. */
  readonly mode: InvestmentBackendMode
  /** HTTP base URL used by health checks and business clients. */
  readonly baseUrl: string
  /** Explicit absolute backend directory, when repository discovery is unavailable. */
  readonly projectDir?: string
  /** Backend directory components relative to a repository root. */
  readonly repositoryPath: readonly string[]
  /** Uvicorn application module. */
  readonly module: 'adapter.app:app' | 'market_watch.app:app'
  /** Health endpoint relative to the backend origin. */
  readonly healthPath: '/health'
  /** Additional response fields required for a healthy service. */
  readonly healthOk: Readonly<Record<string, string | boolean>>
  /** Platform-specific initialization command shown when the venv is absent. */
  readonly initCommand: Readonly<{ posix: './init.sh'; windows: 'init.bat' }>
  /** Explicit non-secret entries forwarded only to an owned child. */
  readonly managedEnv?: Readonly<Record<string, string | undefined>>
}
```

Definitions are complete registration facts. Multiple owners may register byte-identical facts under one id; a difference in any field is a startup conflict rather than a winner-selection rule. Managed URLs must be loopback HTTP. Path discovery starts at the installed Runtime package and walks upward for `repositoryPath`; it never derives a backend from the invoking working directory. An explicit `projectDir` must be absolute and exist.

## Leases

```ts type-equiv
/** One verified backend reference owned by its caller until release. */
interface PythonBackendLease {
  /** Backend definition id. */
  readonly id: InvestmentBackendId
  /** Verified base URL for the business client. */
  readonly baseUrl: string
  /** Process ownership established while acquiring this lease. */
  readonly ownership: 'owned' | 'attached' | 'external'
  /** Release this reference; repeated calls have no additional effect. */
  release(): Promise<void>
}
```

Concurrent `acquire(id)` calls share one per-id startup. Acquisition resolves only after the health response matches the registered service identity and required fields. Callers register tools after resolution and own exactly one release; repeated release is harmless. The last release terminates and joins an owned process tree, while attached and external services remain alive. Runtime disposal waits for in-flight acquisitions and owned teardown before settling.

## Runtime service

```ts public-api
/** Runtime service that verifies registered investment Python backends and leases their URLs. */
declare class InvestmentPythonRuntime extends Service {
  static inject;
  static Config: z<Config>;
  /**
   * Create and install the investment Python Runtime service.
   * @param ctx - Cordis context that owns this service.
   * @param config - deployment tunables used by managed lifecycle support.
   */
  constructor(ctx: Context, config: Config = {});
  /**
   * Register one backend definition.
   * @param definition - complete backend identity and launch definition.
   * @returns a disposer that removes this definition.
   */
  register(definition: PythonBackendDefinition): () => void;
  /**
   * Verify one registered backend and acquire a caller-owned lease.
   * @param id - registered backend id.
   * @param signal - optional health-check cancellation.
   * @returns a verified URL lease.
   */
  async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease>;
  /**
   * Read the mutable lifecycle relations consumed by the invariant companion.
   * @returns active backend entries and backend ids with in-flight acquisition.
   */
  invariantSnapshot(): ReturnType<InvestmentBackendManager['invariantSnapshot']>;
}
```

The Runtime records child output and an owner-only state file beneath `$DSH_HOME/investment-research/<id>/`. State is non-authoritative: stale or malformed records are diagnostics only and never cause PID adoption, signalling, or port takeover. Missing virtual environments fail with `./init.sh` or `init.bat` guidance; installation is not a startup side effect.

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxinvestmentpythonruntime--investmentpythonruntime"></a>

### `ctx.investmentPythonRuntime` — `InvestmentPythonRuntime`

Runtime service that verifies registered investment Python backends and leases their URLs.

```ts cordis-catalog
/**
 * Register one backend definition.
 * @param definition - complete backend identity and launch definition.
 * @returns a disposer that removes this definition.
 */
register(definition: PythonBackendDefinition): () => void

/**
 * Verify one registered backend and acquire a caller-owned lease.
 * @param id - registered backend id.
 * @param signal - optional health-check cancellation.
 * @returns a verified URL lease.
 */
async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease>

/**
 * Publish one backend capability after its business tools are registered.
 * @param definition - backend, tool count, and LLM relationship.
 * @returns idempotent disposer for the capability contribution.
 */
registerCapability(definition: InvestmentCapabilityDefinition): () => void

/**
 * Reject an operation that cannot safely use the active backend capability.
 * @param backendId - backend required by the operation.
 * @param use - operation's LLM relationship.
 */
assertCapability(backendId: InvestmentBackendId, use: InvestmentCapabilityUse): void

/**
 * Read the immutable, client-safe Runtime readiness projection.
 * @returns current backend, credential, and capability facts.
 */
@Remote('readiness') readiness(): InvestmentReadinessSnapshot

/**
 * Request the launcher to restart the complete application after the Remote acknowledgement is sent.
 * @returns an accepted result, or an actionable unavailable result when this launcher cannot restart.
 */
@Remote('request-restart') requestRestart(): InvestmentRestartResult

/**
 * Read the mutable lifecycle relations consumed by the invariant companion.
 * @returns active backend entries and backend ids with in-flight acquisition.
 */
invariantSnapshot(): ReturnType<InvestmentBackendManager['invariantSnapshot']>
```

Source: [`packages/investment-research/python-runtime/src/index.ts:55`](../../packages/investment-research/python-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
