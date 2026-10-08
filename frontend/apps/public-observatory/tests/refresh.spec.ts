// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startRefreshTask, type RefreshTask } from '../src/refresh.ts'

let task: RefreshTask | undefined
let visible: boolean
let online: boolean
beforeEach(() => {
  vi.useFakeTimers()
  visible = true
  online = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
})
afterEach(() => { task?.dispose(); task = undefined; vi.restoreAllMocks(); vi.useRealTimers() })
const policy = { intervalMs: 15_000, retry: true }

it('waits for the entire request before scheduling another and aborts only on disposal', async () => {
  let finish!: (value: { failed: boolean }) => void
  const run = vi.fn((_signal: AbortSignal) => new Promise<{ failed: boolean }>((resolve) => { finish = resolve }))
  task = startRefreshTask(run, policy)
  await vi.advanceTimersByTimeAsync(45_000)
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0]![0].aborted).toBe(false)
  finish({ failed: false })
  await vi.advanceTimersByTimeAsync(14_999)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(2)
  task.dispose()
  expect(run.mock.calls[1]![0].aborted).toBe(true)
  finish({ failed: false })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(run).toHaveBeenCalledTimes(2)
})

it('backs off failures to 30, 60 and 120 seconds and resets after success', async () => {
  const run = vi.fn().mockResolvedValue({ failed: true })
  task = startRefreshTask(run, policy)
  for (const delay of [30_000, 60_000, 120_000, 120_000]) {
    const count = run.mock.calls.length
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(run).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(count + 1)
  }
  run.mockResolvedValue({ failed: false })
  await vi.advanceTimersByTimeAsync(120_000)
  const count = run.mock.calls.length
  await vi.advanceTimersByTimeAsync(15_000)
  expect(run).toHaveBeenCalledTimes(count + 1)
})

it('pauses hidden/offline work and coalesces resume events without bypassing backoff', async () => {
  const run = vi.fn().mockResolvedValue({ failed: false })
  task = startRefreshTask(run, policy)
  await vi.advanceTimersByTimeAsync(0)
  visible = false; document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(run).toHaveBeenCalledTimes(1)
  online = false; window.dispatchEvent(new Event('offline'))
  visible = true; document.dispatchEvent(new Event('visibilitychange'))
  expect(run).toHaveBeenCalledTimes(1)
  run.mockResolvedValue({ failed: true, retryAfterMs: 60_000 })
  online = true; window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(2)
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(59_999)
  expect(run).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(3)
})

it('retries daily failures only until success and honors disabling automatic work', async () => {
  const run = vi.fn().mockResolvedValueOnce({ failed: true }).mockResolvedValue({ failed: false })
  task = startRefreshTask(run, { intervalMs: null, retry: true })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(run).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(86_400_000)
  document.dispatchEvent(new Event('visibilitychange'))
  expect(run).toHaveBeenCalledTimes(2)
  task.updatePolicy(policy)
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(3)
  task.updatePolicy({ intervalMs: null, retry: false })
  await vi.advanceTimersByTimeAsync(60_000)
  window.dispatchEvent(new Event('online'))
  expect(run).toHaveBeenCalledTimes(3)
})

it('defers an initial offline read until online even with automatic refresh disabled', async () => {
  online = false
  const run = vi.fn().mockResolvedValue({ failed: false })
  task = startRefreshTask(run, { intervalMs: null, retry: false })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(run).not.toHaveBeenCalled()
  online = true; window.dispatchEvent(new Event('online'))
  expect(run).toHaveBeenCalledTimes(1)
})
