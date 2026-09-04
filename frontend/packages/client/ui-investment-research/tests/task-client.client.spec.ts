// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { waitForTask } from '../src/client/task-client.ts'

describe('durable task polling', () => {
  it('stops immediately when the backend reports cancellation', async () => {
    const requestData = vi.fn(async () => ({ status: 'cancelled' }))

    await expect(waitForTask(requestData as never, 'task-1', () => {}, () => true))
      .rejects.toThrow('任务已取消')
    expect(requestData).toHaveBeenCalledTimes(1)
  })
})
