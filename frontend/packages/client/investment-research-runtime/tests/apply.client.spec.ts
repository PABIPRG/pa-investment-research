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

async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry).await()
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
  ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
  await ctx.plugin({ inject: gatewayInject, apply: applyGateway }).await()
  return {
    ctx,
    readiness,
    restart,
    mount: async () => {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      return fiber
    },
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
})
