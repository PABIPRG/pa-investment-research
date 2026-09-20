import { describe, expect, it, vi } from 'vitest'
import { NotificationSettings, NOTIFICATION_CHANNEL_CREDENTIAL } from '../src/notification-settings.ts'

function harness() {
  let value: string | undefined
  const store = {
    resolve: vi.fn(async () => value ? { value, source: 'file' } : undefined),
    describe: vi.fn(async () => ({ configured: !!value, writable: true })),
    set: vi.fn(async (_ref: unknown, next: string) => { value = next }),
  }
  const calls: { operation: string; body: unknown }[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const body = typeof options?.body === 'string' ? options.body : '{}'
    calls.push({ operation: url.split('/').at(-1)!, body: JSON.parse(body) as unknown })
    return new Response(JSON.stringify({ applied: true, deliveryEnabled: true, id: 'test-id' }))
  })
  return { store, calls, fetcher, service: new NotificationSettings(store, 'test-token', fetcher), value: () => value }
}
const base = 'http://127.0.0.1:18000'

describe('runtime notification configuration', () => {
  it('recovers corrupt configuration without disabling the backend or exposing stored text', async () => {
    const h = harness()
    await h.store.set(NOTIFICATION_CHANNEL_CREDENTIAL, 'broken-private-config')
    await h.service.sync(base)
    expect(h.calls.at(-1)?.body).toEqual({})
    const status = await h.service.execute(base, { action: 'describe' })
    expect(status.configurationInvalid).toBe(true)
    expect(status.applied).toBe(false)
    expect(JSON.stringify(status)).not.toContain('broken-private-config')
    const reset = await h.service.execute(base, { action: 'reset' })
    expect(reset.configurationInvalid).toBe(false)
    expect(reset.applied).toBe(true)
    expect(JSON.parse(h.value()!)).toEqual({ version: 1, channels: {} })
  })
  it('syncs empty startup, persists safe revisions, redacts read and preserves a blank secret', async () => {
    const h = harness()
    await h.service.sync(base)
    expect(h.calls).toEqual([{ operation: 'apply', body: {} }])
    const saved = await h.service.execute(base, { action: 'save', channel: 'wecom', revision: '', enabled: true, fields: { key: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-test-key' } })
    expect(h.store.set).toHaveBeenCalledWith(NOTIFICATION_CHANNEL_CREDENTIAL, expect.any(String))
    expect(JSON.stringify(saved)).not.toContain('private-test-key')
    expect(h.value()).toContain('private-test-key')
    const original = saved.channels.find(item => item.channel === 'wecom')!
    const updated = await h.service.execute(base, { action: 'save', channel: 'wecom', revision: original.revision, enabled: false, fields: {} })
    expect(updated.channels[1]!.revision).not.toBe(original.revision)
    expect(h.value()).toContain('private-test-key')
    expect(h.calls.at(-1)?.body).toMatchObject({ wecom: { enabled: false, fields: { key: 'private-test-key' } } })
    const restored = new NotificationSettings(h.store, 'test-token', h.fetcher)
    await restored.sync(base)
    expect(h.calls.at(-1)?.body).toMatchObject({ wecom: { revision: updated.channels[1]!.revision } })
  })

  it('fences concurrent stale writers and rejects arbitrary webhooks without echoing them', async () => {
    const h = harness()
    const requests = await Promise.allSettled([1, 2].map(() => h.service.execute(base, { action: 'save', channel: 'serverchan', revision: '', enabled: true, fields: { sendkey: 'SCT-test-key' } })))
    expect(requests.map(item => item.status)).toEqual(['fulfilled', 'rejected'])
    expect(h.store.set).toHaveBeenCalledTimes(1)
    await expect(h.service.execute(base, { action: 'save', channel: 'wecom', revision: '', enabled: true, fields: { key: 'https://evil.test/?key=private' } })).rejects.toThrow('企业微信官方')
  })

  it('distinguishes durable save from apply failure and hides request errors', async () => {
    const h = harness()
    h.fetcher.mockImplementation(async (input) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith('/apply')) throw new Error('SCT-secret-from-response')
      return new Response('{}')
    })
    const saved = await h.service.execute(base, { action: 'save', channel: 'serverchan', revision: '', enabled: true, fields: { sendkey: 'SCT-secret' } })
    expect(saved.applied).toBe(false)
    expect(saved.channels[0]?.configured).toBe(true)
    expect(h.store.set).toHaveBeenCalledOnce()
    await expect(h.service.sync(base)).rejects.toThrow('配置同步未成功')
  })

  it('does not write readonly sources and tests only the current applied version', async () => {
    const h = harness()
    h.store.describe.mockResolvedValue({ configured: false, writable: false })
    await expect(h.service.execute(base, { action: 'remove', channel: 'email', revision: '' })).rejects.toThrow('只读')
    expect(h.store.set).not.toHaveBeenCalled()
    h.store.describe.mockResolvedValue({ configured: false, writable: true })
    const saved = await h.service.execute(base, { action: 'save', channel: 'serverchan', revision: '', enabled: true, fields: { sendkey: 'SCT-secret' } })
    const revision = saved.channels[0]!.revision
    const result = await h.service.execute(base, { action: 'test', channel: 'serverchan', revision, requestId: 'request-one' })
    expect(result.testNotificationId).toBe('test-id')
    expect(h.calls.at(-1)).toEqual({ operation: 'test', body: { channel: 'serverchan', revision, requestId: 'request-one' } })
  })
})
