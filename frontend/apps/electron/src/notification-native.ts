/** Electron main-process adapter for durable macOS system notification jobs. */
import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'

import { NOTIFICATION_OPEN_CHANNEL } from './ipc.ts'

interface NativeJob {
  readonly id: string
  readonly notificationId: string
  readonly leaseToken: string
  readonly title: string
  readonly content: string
}

function jobs(value: unknown): NativeJob[] {
  if (typeof value !== 'object' || value === null) return []
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const row = candidate as Record<string, unknown>
    if (!['id', 'notificationId', 'leaseToken', 'title', 'content'].every(key => typeof row[key] === 'string')) return []
    return [row as unknown as NativeJob]
  })
}

export function bindNativeNotifications(
  window: BrowserWindow,
  run: (input: { action: 'claim' | 'ack' | 'nack'; jobId?: string; leaseToken?: string }) => Promise<unknown>,
  platform: NodeJS.Platform = process.platform,
): () => Promise<void> {
  if (platform !== 'darwin' || !Notification.isSupported()) return async () => {}
  let disposed = false
  let polling = false
  const pending = new Set<Promise<unknown>>()
  const isDisposed = (): boolean => disposed

  const poll = async (): Promise<void> => {
    if (disposed || polling) return
    polling = true
    try {
      for (const job of jobs(await run({ action: 'claim' }))) {
        if (isDisposed()) break
        try {
          const notice = new Notification({ title: job.title.slice(0, 120), body: job.content.slice(0, 500) })
          notice.on('click', () => {
            if (window.isDestroyed()) return
            if (window.isMinimized()) window.restore()
            window.show()
            window.focus()
            window.webContents.send(NOTIFICATION_OPEN_CHANNEL, { notificationId: job.notificationId })
          })
          notice.show()
          await run({ action: 'ack', jobId: job.id, leaseToken: job.leaseToken })
        } catch {
          await run({ action: 'nack', jobId: job.id, leaseToken: job.leaseToken }).catch(() => {})
        }
      }
    } catch {
      // Backend startup and transient outages are retried on the next bounded poll.
    } finally {
      polling = false
    }
  }
  const track = (): void => {
    const flight = poll()
    pending.add(flight)
    void flight.finally(() => { pending.delete(flight) }).catch(() => {})
  }
  track()
  const timer = setInterval(track, 15_000)
  return async () => {
    disposed = true
    clearInterval(timer)
    await Promise.allSettled(pending)
  }
}
