import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const instances: Array<{ on: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> }> = []
  class Notification {
    static isSupported = vi.fn(() => true)
    on = vi.fn()
    show = vi.fn()
    constructor(readonly options: unknown) { instances.push(this) }
  }
  return { Notification, instances }
})

vi.mock('electron', () => ({ Notification: mocks.Notification }))

import { bindNativeNotifications } from '../src/notification-native.ts'

afterEach(() => {
  vi.useRealTimers()
  mocks.instances.length = 0
  vi.clearAllMocks()
})

describe('native investment notifications', () => {
  it('claims durable jobs, displays them, acknowledges and opens the selected detail on click', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const window = {
      isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn(),
      webContents: { send },
    }
    const run = vi.fn(async (input: { action: string }) => input.action === 'claim'
      ? { items: [{ id: 'job-1', notificationId: 'notification-1', leaseToken: 'lease-1', title: '标题', content: '正文' }] }
      : {})
    const dispose = bindNativeNotifications(window as never, run, 'darwin')
    await vi.waitFor(() => { expect(mocks.instances).toHaveLength(1) })
    expect(mocks.instances[0]?.show).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith({ action: 'ack', jobId: 'job-1', leaseToken: 'lease-1' })

    const click = mocks.instances[0]?.on.mock.calls.find(([event]) => event === 'click')?.[1] as (() => void)
    click()
    expect(send).toHaveBeenCalledWith('dsh:electron:notification-open', { notificationId: 'notification-1' })
    await dispose()
  })

  it('does not claim the macOS channel on other platforms', async () => {
    const run = vi.fn()
    const dispose = bindNativeNotifications({} as never, run, 'win32')
    expect(run).not.toHaveBeenCalled()
    await dispose()
  })
})
