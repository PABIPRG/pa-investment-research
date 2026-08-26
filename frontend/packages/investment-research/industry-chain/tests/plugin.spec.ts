import { describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'

describe('industry-chain lifecycle plugin', () => {
  it('registers the fixed backend, acquires its lease, and disposes in reverse order', async () => {
    const events: string[] = []
    let dispose: (() => Promise<void>) | undefined
    await Plugin.apply({
      async effect(callback: () => Promise<() => Promise<void>>) {
        dispose = await callback()
      },
      investmentPythonRuntime: {
        register(definition: unknown) {
          events.push('register')
          expect(definition).toEqual({
            id: 'industry-chain', service: 'industry-chain', mode: 'external',
            baseUrl: 'http://industry.test', projectDir: '/checkout/backend/industry-chain',
            repositoryPath: ['backend', 'industry-chain'], module: 'industry_chain.app:app',
            healthPath: '/health', healthOk: { ok: true },
            initCommand: { posix: './init.sh', windows: 'init.bat' },
          })
          return () => { events.push('unregister') }
        },
        async acquire(id: string) {
          events.push(`acquire:${id}`)
          return {
            id: 'industry-chain', baseUrl: 'http://industry.test', ownership: 'external',
            async release() { events.push('release') },
          }
        },
      },
    } as never, {
      backendMode: 'external', backendBaseUrl: 'http://industry.test',
      backendProjectDir: '/checkout/backend/industry-chain',
    })

    expect(Plugin.name).toBe('investment-industry-chain')
    expect(Plugin.inject).toEqual(['investmentPythonRuntime'])
    expect(events).toEqual(['register', 'acquire:industry-chain'])
    await dispose?.()
    expect(events).toEqual(['register', 'acquire:industry-chain', 'release', 'unregister'])
  })

  it('releases registration when acquisition fails', async () => {
    const unregister = vi.fn()
    await expect(Plugin.apply({
      async effect(callback: () => Promise<() => Promise<void>>) { await callback() },
      investmentPythonRuntime: {
        register() { return unregister },
        async acquire() { throw new Error('unavailable') },
      },
    } as never)).rejects.toThrow('unavailable')
    expect(unregister).toHaveBeenCalledOnce()
  })
})
