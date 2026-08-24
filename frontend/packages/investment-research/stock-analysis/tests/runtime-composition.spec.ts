import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PythonBackendDefinition, PythonBackendLease } from '@deepseek-ai/dsh-investment-python-runtime'
import * as Plugin from '../src/index.ts'

afterEach(() => {
  delete process.env.ADAPTER_RUNNER
})

function context(options: { acquireError?: Error; registerErrorAt?: number; capabilityError?: Error } = {}) {
  const events: string[] = []
  const tools: string[] = []
  const registeredTools = new Map<string, { execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown> }>()
  let cleanup: (() => void | Promise<void>) | undefined
  let definition: PythonBackendDefinition | undefined
  let capability: { backendId: string; toolCount: number; llm: string } | undefined
  const lease: PythonBackendLease = {
    id: 'trading-core',
    baseUrl: 'http://lease.test:9000',
    ownership: 'attached',
    async release() { events.push('lease:release') },
  }
  const ctx = {
    async effect(callback: () => Promise<() => void | Promise<void>>) {
      cleanup = await callback()
      return cleanup
    },
    investmentPythonRuntime: {
      register(value: PythonBackendDefinition) {
        events.push('runtime:register')
        definition = value
        return () => { events.push('runtime:unregister') }
      },
      async acquire(id: string) {
        events.push(`runtime:acquire:${id}`)
        if (options.acquireError !== undefined) throw options.acquireError
        return lease
      },
      registerCapability(value: { backendId: string; toolCount: number; llm: string }) {
        events.push('capability:register')
        if (options.capabilityError !== undefined) throw options.capabilityError
        capability = value
        return () => { events.push('capability:dispose'); capability = undefined }
      },
      assertCapability() {},
    },
    tools: {
      register(tool: { name: string; execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown> }) {
        if (tools.length === options.registerErrorAt) throw new Error('tool registration failed')
        events.push(`tool:register:${tool.name}`)
        tools.push(tool.name)
        registeredTools.set(tool.name, tool)
        return () => {
          events.push(`tool:dispose:${tool.name}`)
          registeredTools.delete(tool.name)
        }
      },
    },
    agents: { roots: () => [] },
  }
  return {
    ctx: ctx as never,
    events,
    tools,
    definition: () => definition,
    capability: () => capability,
    tool: (name: string) => registeredTools.get(name),
    dispose: async () => cleanup?.(),
  }
}

describe('stock-analysis runtime composition', () => {
  it('declares only credential references, config-selected runner, and publishes after all nine tools', async () => {
    process.env.ADAPTER_RUNNER = 'ambient-sentinel-value'
    const mounted = context()
    await Plugin.apply(mounted.ctx, {
      backendMode: 'external',
      backendBaseUrl: 'https://configured.example',
      backendProjectDir: '/absolute/trading-core',
    })
    expect(mounted.definition()).toEqual({
      id: 'trading-core',
      service: 'trading-core',
      mode: 'external',
      baseUrl: 'https://configured.example',
      projectDir: '/absolute/trading-core',
      repositoryPath: ['backend', 'dsh-trading-core'],
      module: 'adapter.app:app',
      healthPath: '/health',
      healthOk: { status: 'ok' },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
      managedEnv: { ADAPTER_RUNNER: 'engine' },
      credentialEnv: [
        { ref: 'DEEPSEEK_API_KEY', env: 'DEEPSEEK_API_KEY', role: 'required' },
        { ref: 'DEEPSEEK_API_KEY', env: 'OPENAI_API_KEY', role: 'required' },
      ],
    })
    expect(mounted.events.slice(0, 3)).toEqual([
      'runtime:register',
      'runtime:acquire:trading-core',
      'tool:register:analyze_stock',
    ])
    expect(mounted.tools).toHaveLength(9)
    expect(mounted.capability()).toEqual({ backendId: 'trading-core', toolCount: 9, llm: 'required' })
    expect(mounted.events.indexOf('capability:register')).toBeGreaterThan(mounted.events.lastIndexOf('tool:register:get_latest_brief'))
    expect(JSON.stringify(mounted.definition())).not.toContain('ambient-sentinel-value')
    expect(Object.keys(Plugin.Config.dict ?? {})).not.toContain('ADAPTER_RUNNER')

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('http://lease.test:9000/watchlist')
      return new Response('{"tickers":[]}')
    }))
    await expect(mounted.tool('get_watchlist')!.execute({}, {
      signal: new AbortController().signal,
    })).resolves.toEqual({ tickers: [] })
  })

  it('uses an explicit fake runner only from plugin config', async () => {
    process.env.ADAPTER_RUNNER = 'ambient-sentinel-value'
    const mounted = context()
    await Plugin.apply(mounted.ctx, { backendRunner: 'fake' })
    expect(mounted.definition()).toMatchObject({ managedEnv: { ADAPTER_RUNNER: 'fake' } })
  })

  it('rolls registration back and exposes zero tools when acquire fails', async () => {
    const mounted = context({ acquireError: new Error('backend unavailable') })
    await expect(Plugin.apply(mounted.ctx, {})).rejects.toThrow('backend unavailable')
    expect(mounted.tools).toEqual([])
    expect(mounted.definition()).toMatchObject({
      mode: 'managed',
      baseUrl: 'http://127.0.0.1:8000',
      managedEnv: { ADAPTER_RUNNER: 'engine' },
      credentialEnv: [
        { ref: 'DEEPSEEK_API_KEY', env: 'DEEPSEEK_API_KEY', role: 'required' },
        { ref: 'DEEPSEEK_API_KEY', env: 'OPENAI_API_KEY', role: 'required' },
      ],
    })
    expect(mounted.events).toEqual([
      'runtime:register',
      'runtime:acquire:trading-core',
      'runtime:unregister',
    ])
  })

  it('rolls back registered tools, lease, and definition when setup fails', async () => {
    const mounted = context({ registerErrorAt: 2 })
    await expect(Plugin.apply(mounted.ctx, {})).rejects.toThrow('tool registration failed')
    expect(mounted.events.slice(-4)).toEqual([
      'tool:dispose:analyze_holdings',
      'tool:dispose:analyze_stock',
      'lease:release',
      'runtime:unregister',
    ])
  })

  it('removes tools before capability, lease, and backend registration when capability publishing fails', async () => {
    const mounted = context({ capabilityError: new Error('capability registration failed') })
    await expect(Plugin.apply(mounted.ctx, {})).rejects.toThrow('capability registration failed')
    expect(mounted.tool('analyze_stock')).toBeUndefined()
    expect(mounted.events.slice(-12)).toEqual([
      'capability:register',
      'tool:dispose:get_latest_brief', 'tool:dispose:get_risk_profile', 'tool:dispose:set_risk_profile',
      'tool:dispose:get_watchlist', 'tool:dispose:set_holdings', 'tool:dispose:set_watchlist',
      'tool:dispose:market_brief', 'tool:dispose:analyze_holdings', 'tool:dispose:analyze_stock',
      'lease:release', 'runtime:unregister',
    ])
  })

  it('disposes tools before the lease and unregisters last', async () => {
    const mounted = context()
    await Plugin.apply(mounted.ctx, {})
    await mounted.dispose()
    const cleanup = mounted.events.slice(mounted.events.findIndex(event => event.startsWith('tool:dispose')))
    expect(cleanup.filter(event => event.startsWith('tool:dispose'))).toHaveLength(9)
    expect(cleanup.at(-3)).toBe('capability:dispose')
    expect(cleanup.at(-2)).toBe('lease:release')
    expect(cleanup.at(-1)).toBe('runtime:unregister')
  })
})
