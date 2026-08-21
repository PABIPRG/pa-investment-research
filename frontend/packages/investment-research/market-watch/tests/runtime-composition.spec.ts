import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PythonBackendDefinition, PythonBackendLease } from '@deepseek-ai/dsh-investment-python-runtime'
import * as Plugin from '../src/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function context(options: { acquireError?: Error; registerErrorAt?: number } = {}) {
  const events: string[] = []
  const tools = new Map<string, { execute(args: Record<string, unknown>): Promise<unknown> }>()
  let cleanup: (() => void | Promise<void>) | undefined
  let definition: PythonBackendDefinition | undefined
  const lease: PythonBackendLease = {
    id: 'market-watch',
    baseUrl: 'http://lease.market:9100',
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
      register(tool: { name: string; execute(args: Record<string, unknown>): Promise<unknown> }) {
        if (tools.size === options.registerErrorAt) throw new Error('tool registration failed')
        events.push(`tool:register:${tool.name}`)
        tools.set(tool.name, tool)
        return () => { events.push(`tool:dispose:${tool.name}`) }
      },
    },
  }
  return {
    ctx: ctx as never,
    events,
    tools,
    definition: () => definition,
    dispose: async () => cleanup?.(),
  }
}

describe('market-watch runtime composition', () => {
  it('registers the fixed market definition and acquires before eleven tools', async () => {
    const mounted = context()
    await Plugin.apply(mounted.ctx, {
      backendMode: 'external',
      backendBaseUrl: 'https://configured.market',
      backendProjectDir: '/absolute/market-watch',
    })
    expect(mounted.definition()).toEqual({
      id: 'market-watch',
      service: 'market-watch',
      mode: 'external',
      baseUrl: 'https://configured.market',
      projectDir: '/absolute/market-watch',
      repositoryPath: ['backend', 'market-watch'],
      module: 'market_watch.app:app',
      healthPath: '/health',
      healthOk: { ok: true },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
    })
    expect(mounted.events.slice(0, 3)).toEqual([
      'runtime:register',
      'runtime:acquire:market-watch',
      'tool:register:watch_add',
    ])
    expect(mounted.tools.size).toBe(11)

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('http://lease.market:9100/watchlist')
      return new Response('{"items":[],"count":0}')
    }))
    await expect(mounted.tools.get('watch_list')!.execute({})).resolves.toEqual({ items: [], count: 0 })
  })

  it('defaults to managed 8100 and exposes no tools when acquire fails', async () => {
    const mounted = context({ acquireError: new Error('backend unavailable') })
    await expect(Plugin.apply(mounted.ctx, {})).rejects.toThrow('backend unavailable')
    expect(mounted.tools.size).toBe(0)
    expect(mounted.definition()).toEqual({
      id: 'market-watch',
      service: 'market-watch',
      mode: 'managed',
      baseUrl: 'http://127.0.0.1:8100',
      repositoryPath: ['backend', 'market-watch'],
      module: 'market_watch.app:app',
      healthPath: '/health',
      healthOk: { ok: true },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
    })
    expect(mounted.events.at(-1)).toBe('runtime:unregister')
  })

  it('rolls back partial setup and disposes tools before lease and registration', async () => {
    const failed = context({ registerErrorAt: 2 })
    await expect(Plugin.apply(failed.ctx, {})).rejects.toThrow('tool registration failed')
    expect(failed.events.slice(-4)).toEqual([
      'tool:dispose:watch_remove',
      'tool:dispose:watch_add',
      'lease:release',
      'runtime:unregister',
    ])

    const mounted = context()
    await Plugin.apply(mounted.ctx, {})
    await mounted.dispose()
    const cleanup = mounted.events.slice(mounted.events.findIndex(event => event.startsWith('tool:dispose')))
    expect(cleanup.filter(event => event.startsWith('tool:dispose'))).toHaveLength(11)
    expect(cleanup.at(-2)).toBe('lease:release')
    expect(cleanup.at(-1)).toBe('runtime:unregister')
  })
})
