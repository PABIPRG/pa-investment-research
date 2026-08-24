import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PythonBackendDefinition, PythonBackendLease } from '@deepseek-ai/dsh-investment-python-runtime'
import * as Plugin from '../src/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function context(options: { acquireError?: Error; registerErrorAt?: number; capabilityError?: Error } = {}) {
  const events: string[] = []
  const tools = new Map<string, { execute(args: Record<string, unknown>): Promise<unknown> }>()
  let cleanup: (() => void | Promise<void>) | undefined
  let definition: PythonBackendDefinition | undefined
  let capability: { backendId: string; toolCount: number; llm: string } | undefined
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
      registerCapability(value: { backendId: string; toolCount: number; llm: string }) {
        events.push('capability:register')
        if (options.capabilityError !== undefined) throw options.capabilityError
        capability = value
        return () => { events.push('capability:dispose'); capability = undefined }
      },
      assertCapability() {},
    },
    tools: {
      register(tool: { name: string; execute(args: Record<string, unknown>): Promise<unknown> }) {
        if (tools.size === options.registerErrorAt) throw new Error('tool registration failed')
        events.push(`tool:register:${tool.name}`)
        tools.set(tool.name, tool)
        return () => { events.push(`tool:dispose:${tool.name}`); tools.delete(tool.name) }
      },
    },
  }
  return {
    ctx: ctx as never,
    events,
    tools,
    definition: () => definition,
    capability: () => capability,
    dispose: async () => cleanup?.(),
  }
}

describe('market-watch runtime composition', () => {
  it('declares the fixed key reference, LLM template mode, and publishes after all eleven tools', async () => {
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
      managedEnv: { MW_LLM_ENABLED: 'true' },
      credentialEnv: [{ ref: 'DEEPSEEK_API_KEY', env: 'DEEPSEEK_API_KEY', role: 'enhancement' }],
    })
    expect(mounted.events.slice(0, 3)).toEqual([
      'runtime:register',
      'runtime:acquire:market-watch',
      'tool:register:watch_add',
    ])
    expect(mounted.tools.size).toBe(11)
    expect(mounted.capability()).toEqual({ backendId: 'market-watch', toolCount: 11, llm: 'enhancement' })
    expect(mounted.events.indexOf('capability:register')).toBeGreaterThan(mounted.events.lastIndexOf('tool:register:daily_brief'))

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
      managedEnv: { MW_LLM_ENABLED: 'true' },
      credentialEnv: [{ ref: 'DEEPSEEK_API_KEY', env: 'DEEPSEEK_API_KEY', role: 'enhancement' }],
    })
    expect(mounted.events.at(-1)).toBe('runtime:unregister')
  })

  it('removes every registered tool before lease and backend registration when capability publishing fails', async () => {
    const failed = context({ capabilityError: new Error('capability registration failed') })
    await expect(Plugin.apply(failed.ctx, {})).rejects.toThrow('capability registration failed')
    expect(failed.tools.size).toBe(0)
    expect(failed.events.slice(-14)).toEqual([
      'capability:register',
      'tool:dispose:daily_brief', 'tool:dispose:news_express', 'tool:dispose:tech_signal',
      'tool:dispose:watch_overview', 'tool:dispose:scan_movers', 'tool:dispose:remove_alert',
      'tool:dispose:list_alerts', 'tool:dispose:add_alert', 'tool:dispose:watch_list',
      'tool:dispose:watch_remove', 'tool:dispose:watch_add', 'lease:release', 'runtime:unregister',
    ])
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
    expect(cleanup.at(-3)).toBe('capability:dispose')
    expect(cleanup.at(-2)).toBe('lease:release')
    expect(cleanup.at(-1)).toBe('runtime:unregister')
  })
})
