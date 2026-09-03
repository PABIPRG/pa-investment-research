import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'

/** Stable investment Python backend identifiers. */
export type InvestmentBackendId = 'trading-core' | 'market-watch' | 'industry-chain'

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
  readonly status: 'stock-full' | 'market-template-only' | 'market-full' | 'industry-full' | 'unavailable'
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

/** Browser-safe, allow-listed investment backend operations. */
export type InvestmentDataOperation =
  | 'market-watch.overview'
  | 'market-watch.indices'
  | 'market-watch.security-search'
  | 'market-watch.security-detail'
  | 'market-watch.security-news'
  | 'market-watch.scan'
  | 'market-watch.tech-signal'
  | 'market-watch.news-flash'
  | 'market-watch.news-events'
  | 'market-watch.watchlist'
  | 'market-watch.watch-add'
  | 'market-watch.watch-remove'
  | 'market-watch.alerts'
  | 'market-watch.quotes-batch'
  | 'trading-core.analyze'
  | 'trading-core.watchlist'
  | 'trading-core.watchlist-save'
  | 'trading-core.holdings'
  | 'trading-core.holdings-save'
  | 'trading-core.holdings-analyze'
  | 'trading-core.risk-portfolio'
  | 'trading-core.risk-alerts'
  | 'trading-core.personalized-cards'
  | 'trading-core.personalized-feedback'
  | 'trading-core.local-learning-events'
  | 'trading-core.local-learning-status'
  | 'trading-core.local-learning-settings'
  | 'trading-core.local-learning-clear'
  | 'trading-core.local-learning-review'
  | 'trading-core.personalized-matches'
  | 'trading-core.personalized-impact'
  | 'trading-core.personalized-profile'
  | 'trading-core.risk-profile'
  | 'trading-core.kyc-profile'
  | 'trading-core.kyc-questionnaire'
  | 'trading-core.kyc-adjust'
  | 'trading-core.kyc-parse'
  | 'trading-core.brief-start'
  | 'trading-core.brief-run'
  | 'trading-core.reports'
  | 'trading-core.report'
  | 'trading-core.strategies'
  | 'trading-core.strategy-detail'
  | 'trading-core.research-chat-context'
  | 'trading-core.research-chat-context-save'
  | 'trading-core.strategies-hypothesize'
  | 'trading-core.strategy-transition'
  | 'trading-core.strategy-action'
  | 'trading-core.strategy-run'
  | 'trading-core.backtest-run'
  | 'trading-core.strategy-backtests'
  | 'trading-core.shadow-status'
  | 'trading-core.shadow-positions'
  | 'trading-core.shadow-equity'
  | 'trading-core.shadow-history'
  | 'trading-core.shadow-run'
  | 'trading-core.evolution-status'
  | 'trading-core.evolution-attribution'
  | 'trading-core.evolution-preview'
  | 'trading-core.evolution-run'
  | 'trading-core.task-status'
  | 'trading-core.task-result'
  | 'industry-chain.data-status'
  | 'industry-chain.data-bootstrap'
  | 'industry-chain.stats'
  | 'industry-chain.companies'
  | 'industry-chain.company'
  | 'industry-chain.entity'
  | 'industry-chain.single'
  | 'industry-chain.chain'
  | 'industry-chain.network'

/** Client-safe progress returned by the industry-chain seed-data lifecycle endpoints. */
export interface IndustryChainDataStatus {
  /** Local dataset lifecycle. Backend health remains independent from this value. */
  readonly status: 'missing' | 'downloading' | 'ready' | 'error'
  /** Files validated in the active download, or all files when ready. */
  readonly files_completed: number
  /** Fixed seed-file count. */
  readonly files_total: 5
  /** Bytes received by the active or completed bootstrap. */
  readonly downloaded_bytes: number
  /** File currently downloading, absent outside the downloading state. */
  readonly current_file: string | null
  /** Safe actionable detail for the error state. */
  readonly error: string | null
}

/** Lossless JSON value accepted across the generated Remote boundary. */
export type InvestmentJsonValue =
  | null
  | boolean
  | number
  | string
  | InvestmentJsonValue[]
  | { [key: string]: InvestmentJsonValue }

/** One allow-listed request from the investment Profile browser UI. */
export interface InvestmentDataRequest {
  /** Stable operation name; the Host maps it to one fixed backend and route. */
  readonly operation: InvestmentDataOperation
  /** Operation-specific JSON input. Unknown keys are rejected by the Host. */
  readonly input?: Readonly<Record<string, InvestmentJsonValue>>
}

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
  readonly module: 'adapter.app:app' | 'market_watch.app:app' | 'industry_chain.app:app'
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
  /** Duration that one successful active-backend health probe remains reusable. */
  healthFreshnessMs?: number
  /** Maximum duration of one backend health request in milliseconds. */
  healthTimeoutMs?: number
  /** Grace period before process-tree termination escalates. */
  shutdownGraceMs?: number
  /** Maximum in-memory diagnostic log tail in bytes. */
  logTailBytes?: number
  /** Maximum active backend log size before rotation in bytes. */
  logMaxBytes?: number
}

/** Resolved backend directory and platform interpreter. */
export type ResolvedBackendPaths =
  | Readonly<{
    /** Source checkout selected by the fixed resolver priority. */
    source: 'source'
    /** Absolute Python backend directory. */
    projectDir: string
    /** Absolute virtual-environment interpreter path. */
    pythonExecutable: string
  }>
  | Readonly<{
    /** Verified packaged sidecar selected by the fixed resolver priority. */
    source: 'bundled'
    /** Absolute Python backend directory. */
    projectDir: string
    /** Absolute virtual-environment interpreter path. */
    pythonExecutable: string
    /** Absolute import root for a bundled Runtime. */
    sitePackages: string
    /** Absolute writable backend root for a bundled Runtime. */
    stateDir: string
  }>

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
