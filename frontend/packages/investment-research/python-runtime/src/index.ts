/** Investment Python backend registration, verification, and lease service. @module @deepseek-ai/dsh-investment-python-runtime */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { InvestmentBackendManager } from './runtime.ts'
import type {
  Config,
  InvestmentBackendId,
  PythonBackendDefinition,
  PythonBackendLease,
} from './types.ts'

export { checkBackendHealth } from './health.ts'
export type { BackendHealthOptions } from './health.ts'
export { resolveBackendAddress, resolveBackendPaths } from './path.ts'
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
  static inject = ['subprocess'] as const

  static Config: z<Config> = z.object({
    dshHome: z.string(),
    startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    healthPollMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(250),
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
    this.manager = new InvestmentBackendManager({ subprocess: ctx.subprocess, config })
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

  /** Mutable lifecycle snapshot consumed by the invariant companion. */
  invariantSnapshot(): ReturnType<InvestmentBackendManager['invariantSnapshot']> {
    return this.manager.invariantSnapshot()
  }
}

export default InvestmentPythonRuntime
