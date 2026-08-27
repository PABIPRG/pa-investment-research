/** Investment Python backend registration, verification, and lease service. @module @deepseek-ai/dsh-investment-python-runtime */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { InvestmentBackendManager } from './runtime.ts'
import { requestInvestmentData } from './data.ts'
import type {
  Config,
  InvestmentBackendId,
  InvestmentCapabilityDefinition,
  InvestmentCapabilityUse,
  InvestmentReadinessSnapshot,
  InvestmentDataRequest,
  InvestmentJsonValue,
  InvestmentRestartResult,
  PythonBackendDefinition,
  PythonBackendLease,
} from './types.ts'

export { checkBackendHealth } from './health.ts'
export type { BackendHealthOptions } from './health.ts'
export { resolveBackendAddress, resolveBackendPaths } from './path.ts'
export { verifyInvestmentRuntimeDescriptor } from './descriptor.ts'
export type {
  InvestmentRuntimeDescriptor,
  InvestmentRuntimeDescriptorOptions,
  InvestmentRuntimeFileDescriptor,
  VerifiedInvestmentRuntime,
} from './descriptor.ts'
export { InvestmentBackendManager } from './runtime.ts'
export type { InvestmentBackendManagerOptions } from './runtime.ts'
export { backendLogPaths, BackendLog, safeErrorMessage } from './log.ts'
export { clearOwnedBackendState, ownedBackendStatePath, readOwnedBackendState, writeOwnedBackendState } from './state.ts'
export type { BackendLogOptions, BackendLogPaths } from './log.ts'
export type { OwnedBackendState, OwnedBackendStateRead } from './state.ts'
export type { BackendPathResolutionOptions } from './path.ts'
export type {
  BackendHealthResult,
  Config,
  InvestmentBackendId,
  InvestmentBackendMode,
  InvestmentBackendReadiness,
  InvestmentCapabilityDefinition,
  InvestmentCapabilityReadiness,
  InvestmentCapabilityUse,
  InvestmentCredentialReadiness,
  InvestmentReadinessSnapshot,
  InvestmentDataOperation,
  InvestmentDataRequest,
  InvestmentJsonValue,
  InvestmentRuntimeAssetReadiness,
  InvestmentRestartResult,
  ManagedCredentialEnv,
  PythonBackendDefinition,
  PythonBackendLease,
  ResolvedBackendAddress,
  ResolvedBackendPaths,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    investmentPythonRuntime: InvestmentPythonRuntime
  }
}

/** Runtime service that verifies registered investment Python backends and leases their URLs. */
export class InvestmentPythonRuntime extends Service {
  static inject = ['credentials', 'subprocess']

  /** Visible binding consumed by Typert Gateway source-mode discovery. */
  readonly typertRemote = bindTypertRemote(this, 'investmentPythonRuntime')

  static Config: z<Config> = z.object({
    dshHome: z.string(),
    startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    healthPollMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(250),
    healthFreshnessMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(5_000),
    healthTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(2_000),
    shutdownGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
    logTailBytes: z.number().step(1).min(1).default(65_536),
    logMaxBytes: z.number().step(1).min(1).default(4_194_304),
  })

  private readonly manager: InvestmentBackendManager

  /**
   * Create and install the investment Python Runtime service.
   * @param ctx - Cordis context that owns this service.
   * @param config - deployment tunables used by managed lifecycle support.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'investmentPythonRuntime')
    this.manager = new InvestmentBackendManager({
      subprocess: ctx.subprocess,
      config,
      resolveCredential: ctx.credentials.resolve.bind(ctx.credentials),
      describeCredential: ctx.credentials.describe.bind(ctx.credentials),
    })
    ctx.on('credentials/updated', (ref) => { this.manager.credentialUpdated(ref) })
    ctx.effect(() => async () => this.manager.dispose(), 'investment Python runtime teardown')
  }

  /**
   * Register one backend definition.
   * @param definition - complete backend identity and launch definition.
   * @returns a disposer that removes this definition.
   */
  register(definition: PythonBackendDefinition): () => void {
    return this.manager.register(definition)
  }

  /**
   * Verify one registered backend and acquire a caller-owned lease.
   * @param id - registered backend id.
   * @param signal - optional health-check cancellation.
   * @returns a verified URL lease.
   */
  async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease> {
    return this.manager.acquire(id, signal)
  }

  /**
   * Publish one backend capability after its business tools are registered.
   * @param definition - backend, tool count, and LLM relationship.
   * @returns idempotent disposer for the capability contribution.
   */
  registerCapability(definition: InvestmentCapabilityDefinition): () => void {
    return this.manager.registerCapability(definition)
  }

  /**
   * Reject an operation that cannot safely use the active backend capability.
   * @param backendId - backend required by the operation.
   * @param use - operation's LLM relationship.
   */
  assertCapability(backendId: InvestmentBackendId, use: InvestmentCapabilityUse): void {
    this.manager.assertCapability(backendId, use)
  }

  /**
   * Read the immutable, client-safe Runtime readiness projection.
   * @returns current backend, credential, and capability facts.
   */
  @Remote('readiness')
  readiness(): InvestmentReadinessSnapshot {
    return this.manager.readiness()
  }

  /**
   * Execute one browser-safe, allow-listed investment data operation.
   * Backend origins and arbitrary paths never cross the Remote boundary.
   * @param request - Stable operation name and validated JSON input.
   * @returns The backend's lossless JSON response.
   */
  @Remote('request-data')
  requestData(request: InvestmentDataRequest): Promise<InvestmentJsonValue> {
    return requestInvestmentData(request, id => this.manager.acquire(id))
  }

  /**
   * Request the launcher to restart the complete application after the Remote acknowledgement is sent.
   * @returns an accepted result, or an actionable unavailable result when this launcher cannot restart.
   */
  @Remote('request-restart')
  requestRestart(): InvestmentRestartResult {
    const appRestartValue: unknown = this.ctx.get('appRestart')
    if (typeof appRestartValue !== 'function') {
      return { status: 'unavailable', reason: 'Application restart is unavailable from this launcher.' }
    }
    const appRestart = appRestartValue as () => void
    setImmediate(() => { appRestart() })
    return { status: 'accepted' }
  }

  /**
   * Read the mutable lifecycle relations consumed by the invariant companion.
   * @returns active backend entries and backend ids with in-flight acquisition.
   */
  invariantSnapshot(): ReturnType<InvestmentBackendManager['invariantSnapshot']> {
    return this.manager.invariantSnapshot()
  }
}

export default InvestmentPythonRuntime
