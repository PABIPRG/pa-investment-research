import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'

/** Stable investment Python backend identifiers. */
export type InvestmentBackendId = 'trading-core' | 'market-watch'

/** Backend ownership modes selected by plugin configuration. */
export type InvestmentBackendMode = 'managed' | 'external'

/** Capability facts published after one backend's business tools are registered. */
export interface InvestmentCapabilityDefinition {
  /** Backend whose tools implement this capability. */
  readonly backendId: InvestmentBackendId
  /** Complete number of tools published by the business plugin. */
  readonly toolCount: number
  /** How the capability uses the backend's declared LLM credential. */
  readonly llm: 'required' | 'enhancement' | 'none'
}

/** Synchronous capability use checked immediately before a business operation. */
export type InvestmentCapabilityUse = 'llm-required' | 'llm-enhancement' | 'non-llm'

/** Client-safe credential state captured when an owned child started. */
export interface InvestmentCredentialReadiness {
  /** Credential reference; never its value. */
  readonly ref: CredentialRef
  /** Whether the owned child received this credential, absent for externally managed credentials. */
  readonly configured?: boolean
  /** Provider source captured at owned spawn, absent while missing or externally managed. */
  readonly source?: string
  /** Provider writability captured at owned spawn, absent for externally managed credentials. */
  readonly writable?: boolean
  /** Safe credential lifecycle state. */
  readonly status: 'missing' | 'configured' | 'read-only' | 'restart-required' | 'external-managed'
}

/** Client-safe capability projection for one investment backend. */
export interface InvestmentCapabilityReadiness {
  /** Declared LLM relationship. */
  readonly llm: InvestmentCapabilityDefinition['llm']
  /** Complete registered tool count, including tools unavailable in the current credential state. */
  readonly toolCount: number
  /** User-visible capability level derived from backend and credential state. */
  readonly status: 'stock-full' | 'market-template-only' | 'market-full' | 'unavailable'
}

/** Serializable readiness facts for one registered investment backend. */
export interface InvestmentBackendReadiness {
  /** Stable backend identifier. */
  readonly backendId: InvestmentBackendId
  /** Current verified ownership, or `null` while stopped. */
  readonly ownership: PythonBackendLease['ownership'] | null
  /** Current backend lifecycle projection. */
  readonly backendStatus: 'stopped' | 'healthy-owned' | 'healthy-attached' | 'external' | 'failed'
  /** Credential references and non-secret facts captured for this backend. */
  readonly credentials: readonly InvestmentCredentialReadiness[]
  /** Published capability, or `null` before or after business-tool registration. */
  readonly capability: InvestmentCapabilityReadiness | null
  /** Whether an owned child must be replaced before another LLM-dependent call. */
  readonly restartRequired: boolean
  /** Active Runtime log path used by actionable diagnostics. */
  readonly runtimeLogPath: string
}

/** Synchronous, immutable, JSON-safe investment Runtime readiness projection. */
export interface InvestmentReadinessSnapshot {
  /** Local Python asset selected for owned managed backends. */
  readonly runtimeAsset: InvestmentRuntimeAssetReadiness
  /** Stable backend-id-sorted readiness entries. */
  readonly backends: readonly InvestmentBackendReadiness[]
}

/** Client-safe local Python asset state. */
export interface InvestmentRuntimeAssetReadiness {
  /** Source environment, verified bundled sidecar, or actionable installation failure. */
  readonly status: 'source-env-ready' | 'bundled-ready' | 'missing' | 'invalid'
  /** Safe recovery detail without environment or credential values. */
  readonly detail?: string
}

/** Client-safe result of a launcher-owned application restart request. */
export type InvestmentRestartResult =
  | Readonly<{ status: 'accepted' }>
  | Readonly<{ status: 'unavailable'; reason: string }>

/** One credential reference injected into an owned backend child environment. */
export interface ManagedCredentialEnv {
  /** Provider-managed credential reference resolved only for an owned child. */
  readonly ref: CredentialRef
  /** Child environment-variable target for the resolved credential value. */
  readonly env: string
  /** Capability importance consumed by the readiness layer. */
  readonly role: 'required' | 'enhancement'
}

/** Complete definition required to verify or start one Python backend. */
export interface PythonBackendDefinition {
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
  /** Credential references resolved only into an owned child environment. */
  readonly credentialEnv?: readonly ManagedCredentialEnv[]
}

/** One verified backend reference owned by its caller until release. */
export interface PythonBackendLease {
  /** Backend definition id. */
  readonly id: InvestmentBackendId
  /** Verified base URL for the business client. */
  readonly baseUrl: string
  /** Process ownership established while acquiring this lease. */
  readonly ownership: 'owned' | 'attached' | 'external'
  /** Release this reference; repeated calls have no additional effect. */
  release(): Promise<void>
}

/** Investment Python Runtime deployment configuration. */
export interface Config {
  /** Explicit Harness home for runtime logs and state. */
  dshHome?: string
  /** Maximum managed startup duration in milliseconds. */
  startupTimeoutMs?: number
  /** Delay between managed health probes in milliseconds. */
  healthPollMs?: number
  /** Grace period before process-tree termination escalates. */
  shutdownGraceMs?: number
  /** Maximum in-memory diagnostic log tail in bytes. */
  logTailBytes?: number
  /** Maximum active backend log size before rotation in bytes. */
  logMaxBytes?: number
}

/** Resolved backend directory and platform interpreter. */
export interface ResolvedBackendPaths {
  /** Deployment source selected by the fixed resolver priority. */
  readonly source: 'source' | 'bundled'
  /** Absolute Python backend directory. */
  readonly projectDir: string
  /** Absolute virtual-environment interpreter path. */
  readonly pythonExecutable: string
  /** Absolute import root for a bundled Runtime. */
  readonly sitePackages?: string
  /** Absolute writable backend root for a bundled Runtime. */
  readonly stateDir?: string
}

/** Validated network address used for health and Uvicorn arguments. */
export interface ResolvedBackendAddress {
  /** Original explicit base URL. */
  readonly baseUrl: string
  /** Host passed to Uvicorn in managed mode. */
  readonly host: string
  /** Port passed to Uvicorn in managed mode. */
  readonly port: number
}

/** Result of one identity-aware backend health probe. */
export type BackendHealthResult =
  | Readonly<{
    status: 'healthy'
    healthUrl: string
    httpStatus: number
  }>
  | Readonly<{
    status: 'refused'
    healthUrl: string
    error: unknown
  }>
  | Readonly<{
    status: 'occupied'
    healthUrl: string
    httpStatus: number
  }>
  | Readonly<{
    status: 'unavailable'
    healthUrl: string
    error: unknown
  }>
