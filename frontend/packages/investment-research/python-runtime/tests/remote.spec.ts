import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import InvestmentPythonRuntime from '../src/index.ts'
import type { InvestmentRestartResult, PythonBackendDefinition } from '../src/types.ts'

const SECRET = 'sentinel-investment-remote-secret-must-never-leak'

class StubCredentials extends CredentialProvider {
  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }
  describe(_ref: CredentialRef): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: true }) }
  set(): Promise<void> { return Promise.resolve() }
  unset(): Promise<void> { return Promise.resolve() }
}

interface RestartableRuntime extends InvestmentPythonRuntime {
  requestRestart(): InvestmentRestartResult
}

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
  managedEnv: { DEEPSEEK_API_KEY: SECRET },
}

function runtimeWith(appRestart?: () => void): RestartableRuntime {
  const ctx = new Context()
  new StubCredentials(ctx)
  ctx.provide('subprocess', {} as never)
  if (appRestart !== undefined) ctx.provide('appRestart', appRestart)
  return new InvestmentPythonRuntime(ctx) as RestartableRuntime
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('InvestmentPythonRuntime Remote', () => {
  it('binds the investment Runtime namespace and exports only the allow-listed aliases', () => {
    const runtime = runtimeWith()

    expect(runtime.typertRemote).toMatchObject({
      serviceKey: 'investmentPythonRuntime',
      namespace: 'investmentPythonRuntime',
    })
    expect(remoteMethods(runtime)).toEqual([
      { method: 'readiness', invocation: { kind: 'direct' } },
      { method: 'requestData', exportName: 'request-data', invocation: { kind: 'direct' } },
      { method: 'requestRestart', exportName: 'request-restart', invocation: { kind: 'direct' } },
    ])
  })

  it('round-trips the readiness whitelist without serializing a backend secret', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ service: 'trading-core', status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const runtime = runtimeWith()
    runtime.register(externalBackend)
    const lease = await runtime.acquire('trading-core')

    const serialized = JSON.stringify(runtime.readiness())

    expect(JSON.parse(serialized)).toEqual(runtime.readiness())
    expect(serialized).not.toContain(SECRET)
    await lease.release()
  })

  it('reports an actionable secret-free unavailable result when the launcher has no restart callback', () => {
    const result = runtimeWith().requestRestart()
    const serialized = JSON.stringify(result)

    expect(result).toEqual({ status: 'unavailable', reason: 'Application restart is unavailable from this launcher.' })
    expect(serialized).not.toContain(SECRET)
  })

  it('defers the launcher restart to the next event-loop phase exactly once', () => {
    const scheduled: (() => void)[] = []
    const appRestart = vi.fn()
    vi.stubGlobal('setImmediate', (callback: () => void): NodeJS.Immediate => {
      scheduled.push(callback)
      return {} as NodeJS.Immediate
    })
    const runtime = runtimeWith(appRestart)

    const result = runtime.requestRestart()

    expect(result).toEqual({ status: 'accepted' })
    expect(appRestart).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    expect(appRestart).toHaveBeenCalledOnce()
  })

  it('waits for the Gateway acknowledgement continuation before restarting', async () => {
    const order: string[] = []
    const runtime = runtimeWith(() => { order.push('restart') })

    const invokeThroughGatewayBoundary = async () => {
      const result = await Reflect.apply(runtime.requestRestart, runtime, [])
      order.push('gateway decode')
      expect(result).toEqual({ status: 'accepted' })
      order.push('gateway response assembly')
    }

    await invokeThroughGatewayBoundary()
    expect(order).toEqual(['gateway decode', 'gateway response assembly'])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(order).toEqual(['gateway decode', 'gateway response assembly', 'restart'])
  })
})
