/** Client-safe investment Runtime readiness source and restart action. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares the Client connection lifecycle events.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the Remote service, generated namespace, and forwarded
// credential-event declarations into the Client compilation face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import investmentRuntimeRemote from '@deepseek-ai/dsh-investment-python-runtime/remote'
import type {
  InvestmentReadinessSnapshot,
  InvestmentRestartResult,
} from '@deepseek-ai/dsh-investment-python-runtime/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

const DEEPSEEK_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
const EMPTY_SNAPSHOT: InvestmentReadinessSnapshot = Object.freeze({
  runtimeAsset: Object.freeze({ status: 'missing' }),
  backends: Object.freeze([]),
})

/** Observable, secret-free Client projection consumed by investment UI plugins. */
export interface InvestmentResearchRuntimeClient {
  /**
   * Read the cached readiness facts.
   * @returns the same snapshot reference until the Host facts change.
   */
  getSnapshot(): InvestmentReadinessSnapshot
  /**
   * Subscribe to readiness changes; the first subscription starts the initial Host read.
   * @param listener - notified after a changed snapshot is committed.
   * @returns a disposer for this subscription.
   */
  subscribe(listener: () => void): () => void
  /**
   * Re-read readiness from the mounted investment Runtime Remote.
   * @returns settlement after the response is published or superseded.
   * @throws the current flight's Remote or transport failure; superseded and disposed flights settle quietly.
   */
  refresh(): Promise<void>
  /**
   * Ask the Host launcher to restart the complete application.
   * @returns the launcher-safe acknowledgement.
   */
  requestRestart(): Promise<InvestmentRestartResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-safe investment Runtime readiness and restart facade. */
    investmentResearchRuntimeClient: InvestmentResearchRuntimeClient
  }
}

type InvestmentRemote = Context['remote']['investmentPythonRuntime']

interface RefreshFlight {
  readonly generation: number
  readonly promise: Promise<void>
}

class InvestmentResearchRuntimeFacade implements InvestmentResearchRuntimeClient {
  private readonly listeners = new Set<() => void>()
  private snapshot: InvestmentReadinessSnapshot = EMPTY_SNAPSHOT
  private serialized = JSON.stringify(EMPTY_SNAPSHOT)
  private generation = 0
  private loaded = false
  private initialReadOwner: number | undefined
  private disposed = false

  constructor(private readonly remote: InvestmentRemote) {}

  getSnapshot = (): InvestmentReadinessSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (!this.loaded && this.initialReadOwner === undefined) {
      const flight = this.startRefresh()
      if (flight !== undefined) {
        this.initialReadOwner = flight.generation
        this.observeBackground(flight.promise, 'initial subscription')
      }
    }
    return () => { this.listeners.delete(listener) }
  }

  refresh(): Promise<void> {
    return this.startRefresh()?.promise ?? Promise.resolve()
  }

  private startRefresh(): RefreshFlight | undefined {
    if (this.disposed) return undefined
    const generation = ++this.generation
    // While no snapshot has loaded, each newer refresh owns the initial-read
    // admission token so an older settlement cannot reopen it early.
    if (this.initialReadOwner !== undefined) this.initialReadOwner = generation
    const promise = this.settleRefresh(generation)
    const releaseInitialRead = (): void => {
      if (this.initialReadOwner === generation) this.initialReadOwner = undefined
    }
    void promise.then(releaseInitialRead, releaseInitialRead)
    return { generation, promise }
  }

  private async settleRefresh(generation: number): Promise<void> {
    let result: RemoteResult<InvestmentReadinessSnapshot>
    try {
      result = await this.remote.readiness()
    } catch (error) {
      if (this.isSuperseded(generation)) return
      throw error
    }
    if (this.isSuperseded(generation)) return
    const next = unwrapRemote(result, 'readiness')
    this.loaded = true
    const serialized = JSON.stringify(next)
    if (serialized === this.serialized) return
    this.snapshot = next
    this.serialized = serialized
    for (const listener of [...this.listeners]) listener()
  }

  async requestRestart(): Promise<InvestmentRestartResult> {
    if (this.disposed) throw new Error('investment Runtime Client facade is disposed')
    return unwrapRemote(await this.remote['request-restart'](), 'request-restart')
  }

  refreshInBackground(reason: string): void {
    const flight = this.startRefresh()
    if (flight !== undefined) this.observeBackground(flight.promise, reason)
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.listeners.clear()
  }

  /**
   * Publish only the facade contract, keeping the mounted Remote and lifecycle
   * state private to this controller.
   * @returns a frozen, identity-stable observable face.
   */
  publicFace(): InvestmentResearchRuntimeClient {
    return Object.freeze({
      getSnapshot: this.getSnapshot,
      subscribe: this.subscribe,
      refresh: () => this.refresh(),
      requestRestart: () => this.requestRestart(),
    })
  }

  private reportRefreshFailure(reason: string, error: unknown): void {
    console.error(`investment Runtime Client: ${reason} refresh failed:`, error)
  }

  private observeBackground(promise: Promise<void>, reason: string): void {
    void promise.catch((error: unknown) => { this.reportRefreshFailure(reason, error) })
  }

  private isSuperseded(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }
}

function unwrapRemote<T>(result: RemoteResult<T>, method: string): T {
  if (result.ok) return result.value
  throw new Error(`investment Runtime Client: ${method} failed: ${result.error.code}: ${result.error.message}`)
}

/** Required service: the generated Client Remote mount. */
export const inject = ['remote']

/**
 * Mount the investment Runtime Remote before publishing its secret-free Client facade.
 * @param ctx - Client Cordis root carrying the typed Remote service.
 * @returns an asynchronous disposer for subscriptions, facade, and Remote contribution.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(investmentRuntimeRemote)
  const remote = ctx.get('remote.investmentPythonRuntime')
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('investment Runtime Client: mounted Remote namespace is unavailable')
  }
  const facade = new InvestmentResearchRuntimeFacade(remote)
  const offCredential = ctx.remote.$on('credentials/updated', (ref) => {
    if (ref === DEEPSEEK_CREDENTIAL_REF) facade.refreshInBackground('credential update')
  })
  const offConnection = ctx.on('connection/reset', () => {
    facade.refreshInBackground('connection reset')
  })
  const disposeService = ctx.provide('investmentResearchRuntimeClient', facade.publicFace())
  return async () => {
    disposeService()
    offConnection()
    offCredential()
    facade.dispose()
    await disposeRemote()
  }
}
