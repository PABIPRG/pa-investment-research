/** Investment Python backend registration, verification, and lease service. @module @deepseek-ai/dsh-investment-python-runtime */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { checkBackendHealth } from './health.ts'
import { resolveBackendAddress } from './path.ts'
import type {
  Config,
  InvestmentBackendId,
  PythonBackendDefinition,
  PythonBackendLease,
} from './types.ts'

export { checkBackendHealth } from './health.ts'
export type { BackendHealthOptions } from './health.ts'
export { resolveBackendAddress, resolveBackendPaths } from './path.ts'
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
    startupTimeoutMs: z.number().step(1).min(1),
    healthPollMs: z.number().step(1).min(1),
    shutdownGraceMs: z.number().step(1).min(1),
    logTailBytes: z.number().step(1).min(1),
    logMaxBytes: z.number().step(1).min(1),
  })

  private readonly definitions = new Map<InvestmentBackendId, PythonBackendDefinition>()
  private readonly activeLeases = new Set<object>()

  /**
   * Create and install the investment Python Runtime service.
   * @param ctx - Cordis context that owns this service.
   * @param _config - deployment tunables used by managed lifecycle support.
   */
  constructor(ctx: Context, _config: Config = {}) {
    super(ctx, 'investmentPythonRuntime')
  }

  /**
   * Register one backend definition.
   * @param definition - complete backend identity and launch definition.
   * @returns a disposer that removes this definition.
   */
  register(definition: PythonBackendDefinition): () => void {
    this.definitions.set(definition.id, definition)
    return () => {
      this.definitions.delete(definition.id)
    }
  }

  /**
   * Verify one registered backend and acquire a caller-owned lease.
   * @param id - registered backend id.
   * @param signal - optional health-check cancellation.
   * @returns a verified URL lease.
   */
  async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease> {
    const definition = this.definitions.get(id)
    if (definition === undefined) {
      throw new Error(`investment Python backend "${id}" is not registered`)
    }
    resolveBackendAddress(definition)
    const health = await checkBackendHealth(definition, signal === undefined ? {} : { signal })
    if (health.status !== 'healthy') {
      throw new Error(`investment Python backend "${id}" health is ${health.status}`)
    }

    const token = {}
    this.activeLeases.add(token)
    return {
      id,
      baseUrl: definition.baseUrl,
      ownership: definition.mode === 'external' ? 'external' : 'attached',
      release: async () => {
        this.activeLeases.delete(token)
      },
    }
  }
}

export default InvestmentPythonRuntime
