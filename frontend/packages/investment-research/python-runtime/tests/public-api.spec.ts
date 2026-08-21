import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import InvestmentPythonRuntime, {
  InvestmentPythonRuntime as NamedInvestmentPythonRuntime,
} from '../src/index.ts'
import type { PythonBackendDefinition } from '../src/types.ts'

const externalBackend: PythonBackendDefinition = {
  id: 'trading-core',
  service: 'trading-core',
  mode: 'external',
  baseUrl: 'https://research.example',
  repositoryPath: ['backend', 'dsh-trading-core'],
  module: 'adapter.app:app',
  healthPath: '/health',
  healthOk: { status: 'ok' },
  initCommand: { posix: './init.sh', windows: 'init.bat' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('InvestmentPythonRuntime public API', () => {
  it('exports one Service class and merges ctx.investmentPythonRuntime into Context', () => {
    expect(InvestmentPythonRuntime).toBe(NamedInvestmentPythonRuntime)
    expect(InvestmentPythonRuntime.prototype).toBeInstanceOf(Service)
    expect(InvestmentPythonRuntime.inject).toEqual(['subprocess'])
    expectTypeOf<Context['investmentPythonRuntime']>().toEqualTypeOf<InvestmentPythonRuntime>()
  })

  it('exposes every deployment tunable through its Config schema', () => {
    expect(Object.keys(InvestmentPythonRuntime.Config.dict ?? {}).sort()).toEqual([
      'dshHome',
      'healthPollMs',
      'logMaxBytes',
      'logTailBytes',
      'shutdownGraceMs',
      'startupTimeoutMs',
    ])
    expect(InvestmentPythonRuntime.Config({
      dshHome: '/tmp/dsh-home',
      startupTimeoutMs: 1,
      healthPollMs: 2,
      shutdownGraceMs: 3,
      logTailBytes: 4,
      logMaxBytes: 5,
    })).toEqual({
      dshHome: '/tmp/dsh-home',
      startupTimeoutMs: 1,
      healthPollMs: 2,
      shutdownGraceMs: 3,
      logTailBytes: 4,
      logMaxBytes: 5,
    })
    for (const field of ['startupTimeoutMs', 'healthPollMs', 'shutdownGraceMs'] as const) {
      expect(() => InvestmentPythonRuntime.Config({ [field]: 2_147_483_648 })).toThrow()
    }
  })

  it('registers an external backend and returns an idempotently releasable verified lease', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      service: 'trading-core',
      status: 'ok',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const ctx = new Context()
    new InvestmentPythonRuntime(ctx)
    const runtime = ctx.investmentPythonRuntime

    const unregister = runtime.register(externalBackend)
    expect(unregister).toEqual(expect.any(Function))
    const lease = await runtime.acquire('trading-core')
    expect(lease).toMatchObject({
      id: 'trading-core',
      baseUrl: 'https://research.example',
      ownership: 'external',
    })
    await expect(lease.release()).resolves.toBeUndefined()
    await expect(lease.release()).resolves.toBeUndefined()
    unregister()
    await expect(runtime.acquire('trading-core')).rejects.toThrow(/trading-core.*registered/)
  })

  it('attaches to a matching managed service and rejects an occupied endpoint', async () => {
    const ctx = new Context()
    const runtime = new InvestmentPythonRuntime(ctx)
    runtime.register({ ...externalBackend, mode: 'managed', baseUrl: 'http://127.0.0.1:8000' })
    const signal = new AbortController().signal

    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.signal === signal
        ? new Response(JSON.stringify({ service: 'trading-core', status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('signal missing', { status: 503 })
    ))
    await expect(runtime.acquire('trading-core', signal)).resolves.toMatchObject({ ownership: 'attached' })

    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }))
    await expect(runtime.acquire('trading-core')).rejects.toThrow(/trading-core.*occupied/)
  })
})
