import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'

/** Stable investment Python backend identifiers. */
export type InvestmentBackendId = 'trading-core' | 'market-watch'

/** Backend ownership modes selected by plugin configuration. */
export type InvestmentBackendMode = 'managed' | 'external'

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
  /** Absolute Python backend directory. */
  readonly projectDir: string
  /** Absolute virtual-environment interpreter path. */
  readonly pythonExecutable: string
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
