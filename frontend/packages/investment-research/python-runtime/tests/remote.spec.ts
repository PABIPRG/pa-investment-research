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
  it('binds the investment Runtime namespace and exports only the readiness and restart aliases', () => {
    const runtime = runtimeWith()

    expect(runtime.typertRemote).toMatchObject({
      serviceKey: 'investmentPythonRuntime',
      namespace: 'investmentPythonRuntime',
    })
    expect(remoteMethods(runtime)).toEqual([
      { method: 'readiness', invocation: { kind: 'direct' } },
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

  it('acknowledges before scheduling the launcher restart exactly once', () => {
    const scheduled: (() => void)[] = []
    const appRestart = vi.fn()
    vi.stubGlobal('queueMicrotask', (callback: () => void) => { scheduled.push(callback) })
    const runtime = runtimeWith(appRestart)

    const result = runtime.requestRestart()

    expect(result).toEqual({ status: 'accepted' })
    expect(appRestart).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    expect(appRestart).toHaveBeenCalledOnce()
  })
})
