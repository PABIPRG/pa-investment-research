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

function runtimeWith(appRestart?: () => void): InvestmentPythonRuntime {
  const ctx = new Context()
  new StubCredentials(ctx)
  ctx.provide('subprocess', {} as never)
  if (appRestart !== undefined) ctx.provide('appRestart', appRestart)
  return new InvestmentPythonRuntime(ctx)
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

  it('round-trips a fixed data operation without exposing a browser-controlled path', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ service: 'trading-core', status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        id: '11111111111111111111111111111111',
        title: '个股分析报告 · 贵州茅台（600519）',
        kind: 'stock',
        created_at: '2026-08-26T03:00:00+00:00',
        summary: '贵州茅台（600519）',
        task_id: '11111111111111111111111111111111',
        sections: [{ key: 'market', title: '市场分析', content: '# 市场分析' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    const runtime = runtimeWith()
    runtime.register(externalBackend)

    await expect(runtime.requestData({
      operation: 'trading-core.report',
      input: { report_id: '11111111111111111111111111111111' },
    })).resolves.toEqual({
      id: '11111111111111111111111111111111',
      title: '个股分析报告 · 贵州茅台（600519）',
      kind: 'stock',
      created_at: '2026-08-26T03:00:00+00:00',
      summary: '贵州茅台（600519）',
      task_id: '11111111111111111111111111111111',
      sections: [{ key: 'market', title: '市场分析', content: '# 市场分析' }],
    })

    expect(calls).toEqual([
      'https://research.example/health',
      'https://research.example/reports/11111111111111111111111111111111',
    ])
    await expect(runtime.requestData({
      operation: 'trading-core.report',
      input: { report_id: '../unsafe' },
    })).rejects.toThrow('32-character lowercase hexadecimal identifier')
    expect(calls).toHaveLength(2)
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
    const restart = scheduled.at(0)
    if (restart === undefined) throw new Error('restart callback was not scheduled')
    restart()
    expect(appRestart).toHaveBeenCalledOnce()
  })

  it('waits for the Gateway acknowledgement continuation before restarting', async () => {
    const order: string[] = []
    const runtime = runtimeWith(() => { order.push('restart') })

    const invokeThroughGatewayBoundary = () => {
      const result: InvestmentRestartResult = runtime.requestRestart()
      order.push('gateway decode')
      expect(result).toEqual({ status: 'accepted' })
      order.push('gateway response assembly')
    }

    invokeThroughGatewayBoundary()
    expect(order).toEqual(['gateway decode', 'gateway response assembly'])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(order).toEqual(['gateway decode', 'gateway response assembly', 'restart'])
  })
})
