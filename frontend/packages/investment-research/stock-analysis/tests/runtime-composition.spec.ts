import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PythonBackendDefinition, PythonBackendLease } from '@deepseek-ai/dsh-investment-python-runtime'
import * as Plugin from '../src/index.ts'

afterEach(() => {
  delete process.env.ADAPTER_RUNNER
})

function context(options: { acquireError?: Error; registerErrorAt?: number } = {}) {
  const events: string[] = []
  const tools: string[] = []
  const registeredTools = new Map<string, { execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown> }>()
  let cleanup: (() => void | Promise<void>) | undefined
  let definition: PythonBackendDefinition | undefined
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
    },
    tools: {
      register(tool: { name: string; execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown> }) {
        if (tools.length === options.registerErrorAt) throw new Error('tool registration failed')
        events.push(`tool:register:${tool.name}`)
        tools.push(tool.name)
        registeredTools.set(tool.name, tool)
        return () => { events.push(`tool:dispose:${tool.name}`) }
      },
    },
    agents: { roots: () => [] },
  }
  return {
    ctx: ctx as never,
    events,
    tools,
    definition: () => definition,
    tool: (name: string) => registeredTools.get(name),
    dispose: async () => cleanup?.(),
  }
}

describe('stock-analysis runtime composition', () => {
  it('registers the fixed trading definition, acquires before tools, and uses only the lease URL', async () => {
    process.env.ADAPTER_RUNNER = 'explicit-runner'
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
      managedEnv: { ADAPTER_RUNNER: 'explicit-runner' },
    })
    expect(mounted.events.slice(0, 3)).toEqual([
      'runtime:register',
      'runtime:acquire:trading-core',
      'tool:register:analyze_stock',
    ])
    expect(mounted.tools).toHaveLength(9)
    expect(Object.keys(Plugin.Config.dict ?? {})).not.toContain('ADAPTER_RUNNER')

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('http://lease.test:9000/watchlist')
      return new Response('{"tickers":[]}')
    }))
    await expect(mounted.tool('get_watchlist')!.execute({}, {
      signal: new AbortController().signal,
    })).resolves.toEqual({ tickers: [] })
  })

  it('rolls registration back and exposes zero tools when acquire fails', async () => {
    const mounted = context({ acquireError: new Error('backend unavailable') })
    await expect(Plugin.apply(mounted.ctx, {})).rejects.toThrow('backend unavailable')
    expect(mounted.tools).toEqual([])
    expect(mounted.definition()).toMatchObject({
      mode: 'managed',
      baseUrl: 'http://127.0.0.1:8000',
      managedEnv: {},
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

  it('disposes tools before the lease and unregisters last', async () => {
    const mounted = context()
    await Plugin.apply(mounted.ctx, {})
    await mounted.dispose()
    const cleanup = mounted.events.slice(mounted.events.findIndex(event => event.startsWith('tool:dispose')))
    expect(cleanup.filter(event => event.startsWith('tool:dispose'))).toHaveLength(9)
    expect(cleanup.at(-2)).toBe('lease:release')
    expect(cleanup.at(-1)).toBe('runtime:unregister')
  })
})
