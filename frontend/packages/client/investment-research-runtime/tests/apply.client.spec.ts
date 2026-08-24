import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply as applyGateway, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type {
  InvestmentReadinessSnapshot,
  InvestmentRestartResult,
} from '@deepseek-ai/dsh-investment-python-runtime/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

const FIRST: InvestmentReadinessSnapshot = {
  backends: [{
    backendId: 'trading-core',
    ownership: 'owned',
    backendStatus: 'healthy-owned',
    credentials: [{
      ref: 'DEEPSEEK_API_KEY',
      configured: true,
      source: 'memory',
      writable: true,
      status: 'configured',
    }],
    capability: { llm: 'required', toolCount: 9, status: 'stock-full' },
    restartRequired: false,
    runtimeLogPath: '/safe/runtime/trading-core.log',
  }],
}

const CHANGED: InvestmentReadinessSnapshot = {
  backends: [{
    ...FIRST.backends[0]!,
    credentials: [{
      ref: 'DEEPSEEK_API_KEY',
      configured: true,
      source: 'memory',
      writable: true,
      status: 'restart-required',
    }],
    restartRequired: true,
  }],
}

interface Bench {
  readonly ctx: Context
  readonly readiness: ReturnType<typeof vi.fn>
  readonly restart: ReturnType<typeof vi.fn>
  mount(): Promise<Fiber>
}

type RpcCallResult = Awaited<ReturnType<ConnectionHandle['rpc']['call']>>

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function readinessResult(snapshot: InvestmentReadinessSnapshot): RpcCallResult {
  return { ok: true, value: structuredClone(snapshot) }
}

function remoteFailure(message: string): RpcCallResult {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

async function runtimeBench(call: ConnectionHandle['rpc']['call']): Promise<{
  readonly ctx: Context
  mount(): Promise<Fiber>
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry).await()
  ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
  await ctx.plugin({ inject: gatewayInject, apply: applyGateway }).await()
  return {
    ctx,
    mount: async () => {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      return fiber
    },
  }
}

async function controlledBench(): Promise<{
  readonly ctx: Context
  readonly calls: Deferred<RpcCallResult>[]
  mount(): Promise<Fiber>
}> {
  const calls: Deferred<RpcCallResult>[] = []
  const call = vi.fn<ConnectionHandle['rpc']['call']>(() => {
    const pending = deferred<RpcCallResult>()
    calls.push(pending)
    return pending.promise
  })
  return { ...await runtimeBench(call), calls }
}

async function bench(): Promise<Bench> {
  const readiness = vi.fn<() => InvestmentReadinessSnapshot>()
    .mockReturnValue(FIRST)
  const restart = vi.fn<() => InvestmentRestartResult>()
    .mockReturnValue({ status: 'accepted' })
  const call = vi.fn<ConnectionHandle['rpc']['call']>(async (_path, method) => {
    if (method === 'investmentPythonRuntime/readiness') {
      return { ok: true, value: structuredClone(readiness()) }
    }
    if (method === 'investmentPythonRuntime/request-restart') {
      return { ok: true, value: structuredClone(restart()) }
    }
    throw new Error(`unexpected Remote method: ${method}`)
  })
  const runtime = await runtimeBench(call)
  return {
    ...runtime,
    readiness,
    restart,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('investment research Runtime Client facade', () => {
  it('publishes the facade only after the real generated Remote contribution finishes mounting', async () => {
    const b = await bench()
    const mount = b.ctx.remote.$mount.bind(b.ctx.remote)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const mounting = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(b.ctx.remote, '$mount').mockImplementation(async contribution => {
      entered()
      await gate
      return mount(contribution)
    })

    const fiber = b.ctx.plugin({ inject, apply })
    await mounting
    expect(b.ctx.get('investmentResearchRuntimeClient')).toBeUndefined()
    release()
    await fiber.await()

    expect(b.ctx.get('investmentResearchRuntimeClient')).toBeDefined()
    expect(b.ctx.typert.remotes.list().map(entry => entry.id)).toEqual([
      '@deepseek-ai/dsh-investment-python-runtime#investmentPythonRuntime/readiness',
      '@deepseek-ai/dsh-investment-python-runtime#investmentPythonRuntime/request-restart',
    ])
  })

  it('publishes only the client-safe observable and restart operations', async () => {
    const b = await bench()
    await b.mount()
    const facade = b.ctx.investmentResearchRuntimeClient

    expect(Object.keys(facade).sort()).toEqual([
      'getSnapshot',
      'refresh',
      'requestRestart',
      'subscribe',
    ])
    expect(JSON.stringify(facade)).not.toContain('credentialValue')
    await expect(facade.requestRestart()).resolves.toEqual({ status: 'accepted' })
    expect(b.restart).toHaveBeenCalledOnce()
  })

  it('loads on first subscription and refreshes only for the DeepSeek credential and reconnects', async () => {
    const b = await bench()
    await b.mount()
    const listener = vi.fn()
    const secondListener = vi.fn()

    const unsubscribe = b.ctx.investmentResearchRuntimeClient.subscribe(listener)
    const unsubscribeSecond = b.ctx.investmentResearchRuntimeClient.subscribe(secondListener)
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledTimes(1) })
    expect(b.readiness).toHaveBeenCalledTimes(1)
    expect(secondListener).toHaveBeenCalledTimes(1)
    expect(b.ctx.investmentResearchRuntimeClient.getSnapshot()).toEqual(FIRST)

    b.ctx.remote.$dispatch('credentials/updated', ['OPENAI_API_KEY'])
    await Promise.resolve()
    expect(b.readiness).toHaveBeenCalledTimes(1)

    b.ctx.remote.$dispatch('credentials/updated', ['DEEPSEEK_API_KEY'])
    await vi.waitFor(() => { expect(b.readiness).toHaveBeenCalledTimes(2) })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.readiness).toHaveBeenCalledTimes(3) })
    unsubscribe()
    unsubscribeSecond()
  })

  it('keeps snapshot and source identities stable until readiness facts change', async () => {
    const b = await bench()
    await b.mount()
    const facade = b.ctx.investmentResearchRuntimeClient
    const listener = vi.fn()
    facade.subscribe(listener)
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledTimes(1) })
    const initial = facade.getSnapshot()

    await facade.refresh()
    expect(facade.getSnapshot()).toBe(initial)
    expect(listener).toHaveBeenCalledTimes(1)

    b.readiness.mockReturnValue(CHANGED)
    await facade.refresh()
    expect(facade.getSnapshot()).not.toBe(initial)
    expect(facade.getSnapshot()).toEqual(CHANGED)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(b.ctx.investmentResearchRuntimeClient).toBe(facade)
  })

  it('withdraws subscriptions, the generated Remote contribution, and the service on dispose', async () => {
    const b = await bench()
    const fiber = await b.mount()
    const listener = vi.fn()
    const facade = b.ctx.investmentResearchRuntimeClient
    facade.subscribe(listener)
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledTimes(1) })
    expect(b.readiness).toHaveBeenCalledTimes(1)
    listener.mockClear()
    b.readiness.mockClear()

    await fiber.dispose()

    expect(b.ctx.get('investmentResearchRuntimeClient')).toBeUndefined()
    expect(b.ctx.get('remote.investmentPythonRuntime')).toBeUndefined()
    expect(b.ctx.typert.remotes.list()).toEqual([])
    b.ctx.remote.$dispatch('credentials/updated', ['DEEPSEEK_API_KEY'])
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.readiness).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('quietly settles stale Remote and transport failures after a newer refresh commits', async () => {
    const b = await controlledBench()
    await b.mount()
    const listener = vi.fn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    b.ctx.investmentResearchRuntimeClient.subscribe(listener)
    const staleRemote = b.ctx.investmentResearchRuntimeClient.refresh()
    expect(b.calls).toHaveLength(2)
    b.calls[1]!.resolve(readinessResult(CHANGED))
    await staleRemote.catch(() => {})
    await vi.waitFor(() => {
      expect(b.ctx.investmentResearchRuntimeClient.getSnapshot()).toEqual(CHANGED)
    })
    b.calls[0]!.resolve(remoteFailure('stale Remote failure'))
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    const staleTransport = b.ctx.investmentResearchRuntimeClient.refresh()
    const current = b.ctx.investmentResearchRuntimeClient.refresh()
    expect(b.calls).toHaveLength(4)
    b.calls[3]!.resolve(readinessResult(FIRST))
    await expect(current).resolves.toBeUndefined()
    b.calls[2]!.reject(new Error('stale transport failure'))
    await expect(staleTransport).resolves.toBeUndefined()

    expect(b.ctx.investmentResearchRuntimeClient.getSnapshot()).toEqual(FIRST)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(errors).not.toHaveBeenCalled()
  })

  it('does not let a stale success overwrite a newer readiness snapshot', async () => {
    const b = await controlledBench()
    await b.mount()
    const facade = b.ctx.investmentResearchRuntimeClient
    const listener = vi.fn()
    const initial = facade.refresh()
    b.calls[0]!.resolve(readinessResult(FIRST))
    await initial
    facade.subscribe(listener)
    const stale = facade.refresh()
    const current = facade.refresh()

    b.calls[2]!.resolve(readinessResult(CHANGED))
    await expect(current).resolves.toBeUndefined()
    b.calls[1]!.resolve(readinessResult(FIRST))
    await expect(stale).resolves.toBeUndefined()

    expect(facade.getSnapshot()).toEqual(CHANGED)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['success', (pending: Deferred<RpcCallResult>) => { pending.resolve(readinessResult(CHANGED)) }],
    ['Remote failure', (pending: Deferred<RpcCallResult>) => { pending.resolve(remoteFailure('disposed Remote')) }],
    ['transport rejection', (pending: Deferred<RpcCallResult>) => { pending.reject(new Error('disposed transport')) }],
  ] as const)('quietly settles an in-flight %s after dispose', async (_label, settle) => {
    const b = await controlledBench()
    const fiber = await b.mount()
    const facade = b.ctx.investmentResearchRuntimeClient
    const listener = vi.fn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const initial = facade.refresh()
    expect(b.calls).toHaveLength(1)
    b.calls[0]!.resolve(readinessResult(FIRST))
    await initial
    facade.subscribe(listener)
    const refresh = facade.refresh()
    expect(b.calls).toHaveLength(2)

    await fiber.dispose()
    settle(b.calls[1]!)

    await expect(refresh).resolves.toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('keeps current failures visible while the initial background read logs once and remains retryable', async () => {
    const b = await controlledBench()
    await b.mount()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    b.ctx.investmentResearchRuntimeClient.subscribe(firstListener)
    b.ctx.investmentResearchRuntimeClient.subscribe(secondListener)
    expect(b.calls).toHaveLength(1)
    b.calls[0]!.resolve(remoteFailure('current initial failure'))
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledTimes(1) })

    const thirdListener = vi.fn()
    b.ctx.investmentResearchRuntimeClient.subscribe(thirdListener)
    expect(b.calls).toHaveLength(2)
    b.calls[1]!.resolve(readinessResult(FIRST))
    await vi.waitFor(() => { expect(thirdListener).toHaveBeenCalledTimes(1) })

    const directRemote = b.ctx.investmentResearchRuntimeClient.refresh()
    b.calls[2]!.resolve(remoteFailure('current direct Remote failure'))
    await expect(directRemote).rejects.toThrow('current direct Remote failure')
    const directTransport = b.ctx.investmentResearchRuntimeClient.refresh()
    b.calls[3]!.reject(new Error('current direct transport failure'))
    await expect(directTransport).rejects.toThrow('current direct transport failure')
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('transfers initial pending ownership to a superseding event refresh', async () => {
    const b = await controlledBench()
    await b.mount()
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    b.ctx.investmentResearchRuntimeClient.subscribe(first)
    b.ctx.investmentResearchRuntimeClient.subscribe(second)
    expect(b.calls).toHaveLength(1)

    b.ctx.emit('connection/reset')
    expect(b.calls).toHaveLength(2)
    b.calls[0]!.resolve(remoteFailure('superseded initial failure'))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    b.ctx.investmentResearchRuntimeClient.subscribe(third)
    expect(b.calls).toHaveLength(2)

    b.calls[1]!.resolve(readinessResult(CHANGED))
    await vi.waitFor(() => { expect(third).toHaveBeenCalledTimes(1) })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })
})
