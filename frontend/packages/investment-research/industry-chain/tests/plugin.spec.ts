import { describe, expect, it } from 'vitest'
import type {
  PythonBackendDefinition,
  PythonBackendLease,
} from '@deepseek-ai/dsh-investment-python-runtime'
import * as Plugin from '../src/index.ts'

function context(options: { acquireError?: Error; capabilityError?: Error } = {}) {
  const events: string[] = []
  let cleanup: (() => void | Promise<void>) | undefined
  let definition: PythonBackendDefinition | undefined
  let capability: { backendId: string; toolCount: number; llm: string } | undefined
  const lease: PythonBackendLease = {
    id: 'industry-chain',
    baseUrl: 'http://lease.industry:9200',
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
    },
  }
  return {
    ctx: ctx as never,
    events,
    definition: () => definition,
    capability: () => capability,
    dispose: async () => cleanup?.(),
  }
}

describe('industry-chain Host plugin', () => {
  it('preserves its named API and declares only the shared Runtime service', () => {
    const config: Plugin.Config = {}
    expect(Plugin.name).toBe('investment-industry-chain')
    expect(Plugin.inject).toEqual(['investmentPythonRuntime'])
    expect(Plugin.apply).toBeTypeOf('function')
    expect(config).toEqual({})
  })

  it('registers the exact external backend and publishes a keyless zero-tool capability', async () => {
    const mounted = context()
    await Plugin.apply(mounted.ctx, {
      backendMode: 'external',
      backendBaseUrl: 'https://configured.industry',
      backendProjectDir: '/absolute/industry-chain',
    })

    expect(mounted.definition()).toEqual({
      id: 'industry-chain',
      service: 'industry-chain',
      mode: 'external',
      baseUrl: 'https://configured.industry',
      projectDir: '/absolute/industry-chain',
      repositoryPath: ['backend', 'industry-chain'],
      module: 'industry_chain.app:app',
      healthPath: '/health',
      healthOk: { ok: true, service: 'industry-chain' },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
    })
    expect(mounted.events).toEqual([
      'runtime:register',
      'runtime:acquire:industry-chain',
      'capability:register',
    ])
    expect(mounted.capability()).toEqual({
      backendId: 'industry-chain', toolCount: 0, llm: 'none',
    })

    await mounted.dispose()
    expect(mounted.events.slice(-3)).toEqual([
      'capability:dispose', 'lease:release', 'runtime:unregister',
    ])
  })

  it('defaults to the managed repository backend and unregisters when acquire fails', async () => {
    const mounted = context({ acquireError: new Error('backend unavailable') })

    await expect(Plugin.apply(mounted.ctx)).rejects.toThrow('backend unavailable')
    expect(mounted.definition()).toEqual({
      id: 'industry-chain',
      service: 'industry-chain',
      mode: 'managed',
      baseUrl: 'http://127.0.0.1:8200',
      repositoryPath: ['backend', 'industry-chain'],
      module: 'industry_chain.app:app',
      healthPath: '/health',
      healthOk: { ok: true, service: 'industry-chain' },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
    })
    expect(mounted.capability()).toBeUndefined()
    expect(mounted.events).toEqual([
      'runtime:register', 'runtime:acquire:industry-chain', 'runtime:unregister',
    ])
  })

  it('releases the lease and definition when capability publication fails', async () => {
    const mounted = context({ capabilityError: new Error('capability failed') })

    await expect(Plugin.apply(mounted.ctx)).rejects.toThrow('capability failed')
    expect(mounted.events).toEqual([
      'runtime:register',
      'runtime:acquire:industry-chain',
      'capability:register',
      'lease:release',
      'runtime:unregister',
    ])
  })
})
