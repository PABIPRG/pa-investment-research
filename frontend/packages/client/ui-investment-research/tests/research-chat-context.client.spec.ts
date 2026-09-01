import { describe, expect, it, vi } from 'vitest'
import {
  ResearchChatContextController,
  type ResearchChatContext,
  type ResearchChatContextTarget,
} from '../src/client/research-chat-context.ts'

function context(
  sessionId: string,
  revision: number,
  strategyId: string | null = null,
): ResearchChatContext {
  return {
    schema_version: 1,
    session_id: sessionId,
    strategy_id: strategyId,
    instrument: null,
    revision,
    updated_at: `2026-09-01T00:00:0${revision}Z`,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

describe('research chat context controller', () => {
  it('keeps confirmed selections and revisions isolated per session', async () => {
    const stored = new Map<string, ResearchChatContext>()
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      const sessionId = String(request.input?.session_id)
      if (request.operation.endsWith('-save')) {
        const next = context(sessionId, Number(request.input?.expected_revision) + 1, String(request.input?.strategy_id))
        stored.set(sessionId, next)
        return next
      }
      const value = stored.get(sessionId)
      return value === undefined ? { exists: false, context: null } : { exists: true, context: value }
    })
    const controller = new ResearchChatContextController(requestData as never)

    await controller.load('session-a')
    await controller.save('session-a', { strategy_id: 'strategy-a', instrument: null })
    await controller.load('session-b')

    expect(controller.snapshot('session-a')).toMatchObject({
      phase: 'ready', revision: 1, confirmed: { strategy_id: 'strategy-a' },
    })
    expect(controller.snapshot('session-b')).toMatchObject({ phase: 'ready', revision: 0, confirmed: null })
  })

  it('ignores an older load that settles after a newer refresh', async () => {
    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    const requestData = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const controller = new ResearchChatContextController(requestData)

    const first = controller.load('session-a')
    const second = controller.load('session-a', { refresh: true })
    newer.resolve({ exists: true, context: context('session-a', 2, 'strategy-new') })
    await second
    older.resolve({ exists: true, context: context('session-a', 1, 'strategy-old') })
    await first

    expect(controller.snapshot('session-a')).toMatchObject({
      revision: 2, confirmed: { strategy_id: 'strategy-new' },
    })
  })

  it('retains the prior confirmation when saving fails', async () => {
    const requestData = vi.fn()
      .mockResolvedValueOnce({ exists: true, context: context('session-a', 2, 'strategy-old') })
      .mockRejectedValueOnce(new Error('保存失败'))
    const controller = new ResearchChatContextController(requestData)
    await controller.load('session-a')
    const target: ResearchChatContextTarget = { strategy_id: 'strategy-new', instrument: null }

    await expect(controller.save('session-a', target)).rejects.toThrow('保存失败')
    expect(controller.snapshot('session-a')).toMatchObject({
      phase: 'error', revision: 2, confirmed: { strategy_id: 'strategy-old' },
      error: '保存失败', errorAction: 'save',
    })
  })

  it('reloads the server value after a revision conflict', async () => {
    const requestData = vi.fn()
      .mockResolvedValueOnce({ exists: true, context: context('session-a', 1, 'strategy-old') })
      .mockRejectedValueOnce(new Error('request failed with HTTP 409: revision_conflict'))
      .mockResolvedValueOnce({ exists: true, context: context('session-a', 3, 'strategy-server') })
    const controller = new ResearchChatContextController(requestData)
    await controller.load('session-a')

    await expect(controller.save('session-a', { strategy_id: 'strategy-local', instrument: null }))
      .rejects.toThrow('HTTP 409')
    expect(controller.snapshot('session-a')).toMatchObject({
      phase: 'error', revision: 3, confirmed: { strategy_id: 'strategy-server' },
      error: '该会话已在其他位置更新，请重新选择。', errorAction: 'conflict',
    })
    expect(requestData).toHaveBeenCalledTimes(3)
  })

  it('does not notify subscribers after disposal', async () => {
    const load = deferred<unknown>()
    const controller = new ResearchChatContextController(() => load.promise)
    const listener = vi.fn()
    controller.subscribe('session-a', listener)
    const pending = controller.load('session-a')
    listener.mockClear()
    controller.dispose()
    load.resolve({ exists: true, context: context('session-a', 1) })
    await pending

    expect(listener).not.toHaveBeenCalled()
  })
})
