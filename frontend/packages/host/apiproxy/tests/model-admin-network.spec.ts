import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverPublicModels } from '../src/model-admin-discovery.ts'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

describe('remote model network enforcement', () => {
  it('rejects mixed public/private DNS answers before creating a socket', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] as never)
    await expect(discoverPublicModels('https://models.example', undefined)).rejects.toThrow(/内网/)
    expect(request).not.toHaveBeenCalled()
  })
  it('pins the validated address and does not follow a redirect', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
    const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: 'https://127.0.0.1' }, destroy: vi.fn() })
    vi.mocked(request).mockImplementation(((_url: unknown, options: { lookup: Function }, callback: Function) => {
      const resolved = vi.fn()
      options.lookup('models.example', {}, resolved)
      expect(resolved).toHaveBeenCalledWith(null, '8.8.8.8', 4)
      return Object.assign(new EventEmitter(), { end: () => callback(response) })
    }) as never)
    await expect(discoverPublicModels('https://models.example', undefined)).rejects.toThrow(/重定向/)
    expect(request).toHaveBeenCalledOnce()
    expect(response.destroy).toHaveBeenCalledOnce()
  })
  it('passes an abort deadline to the socket and bounds the response body', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
    const response = Object.assign(new EventEmitter(), { statusCode: 200, destroy: vi.fn() })
    vi.mocked(request).mockImplementation(((_url: unknown, options: { signal: AbortSignal }, callback: Function) => {
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return Object.assign(new EventEmitter(), { end: () => {
        callback(response)
        response.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1))
      } })
    }) as never)
    await expect(discoverPublicModels('https://models.example', 'test-key')).rejects.toThrow(/过大/)
    expect(response.destroy).toHaveBeenCalledOnce()
  })
})
