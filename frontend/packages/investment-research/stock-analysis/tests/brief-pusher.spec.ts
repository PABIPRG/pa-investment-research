import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupBriefPusher } from '../src/brief-pusher.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('stock-analysis brief pusher', () => {
  it('is disabled by default without creating a polling effect', () => {
    const effects: Array<() => (() => void)> = []
    setupBriefPusher({ effect(callback: () => () => void) { effects.push(callback) } } as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: false, pushPollMs: 1, pushSessions: [],
    })
    expect(effects).toEqual([])
  })

  it('polls at the minimum interval, follows the allowlist, and disposer stops later polls', async () => {
    vi.useFakeTimers()
    const effects: Array<() => (() => void)> = []
    const delivered: string[] = []
    const calls: Array<[string, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method])
      if (url.endsWith('/brief/latest')) {
        return new Response(JSON.stringify({ id: 'brief/a', period: 'pre_market', trade_date: '2026-08-20', summary: '关注白酒' }))
      }
      return new Response(JSON.stringify({ ok: true }))
    }))
    setupBriefPusher({
      get: () => ({
        roots: () => [
          { id: 'allowed', followup(message: { content: Array<{ text: string }> }) { delivered.push(message.content[0]!.text) } },
          { id: 'other', followup() { throw new Error('must not be selected') } },
        ],
      }),
      effect(callback: () => () => void) { effects.push(callback) },
      logger: { info() {} },
    } as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 1, pushSessions: ['allowed'],
    })

    const dispose = effects[0]!()
    await vi.advanceTimersByTimeAsync(0)

    expect(delivered).toEqual(['[插件播报 · 盘前简报]\n盘前简报 · 2026-08-20\n\n关注白酒'])
    expect(calls).toContainEqual(['http://adapter.test/brief/brief%2Fa/dsh-pushed', 'POST'])
    const initialPolls = calls.filter(([url]) => url.endsWith('/brief/latest')).length
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls.filter(([url]) => url.endsWith('/brief/latest'))).toHaveLength(initialPolls)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.filter(([url]) => url.endsWith('/brief/latest'))).toHaveLength(initialPolls + 1)
    await dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter(([url]) => url.endsWith('/brief/latest'))).toHaveLength(initialPolls + 1)
  })

  it('does not push an already marked brief and warns when agents are unavailable', () => {
    const effects: unknown[] = []
    const warnings: string[] = []
    setupBriefPusher(
      {
        get() { return undefined },
        effect(callback: unknown) { effects.push(callback) },
        logger: { warn(message: string) { warnings.push(message) } },
      } as never,
      { adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 30_000, pushSessions: [] },
    )
    expect(effects).toEqual([])
    expect(warnings.join('')).toContain('agents 服务不可用')
  })

  it.each([
    ['missing identity', {}, 0],
    ['already pushed', { id: 'b1', dsh_pushed: true }, 0],
    ['failed delivery', { id: 'b1', period: 'other', summary: '内容' }, 0],
  ])('does not mark %s without a completed delivery', async (_label, brief, expectedMarks) => {
    vi.useFakeTimers()
    const effects: Array<() => (() => void)> = []
    let marks = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/brief/latest')) return new Response(JSON.stringify(brief))
      marks++
      return new Response('{}')
    }))
    setupBriefPusher({
      get: () => ({ roots: () => [{ id: 'bad', followup() { throw new Error('offline') } }] }),
      effect(callback: () => () => void) { effects.push(callback) },
    } as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 30_000, pushSessions: [],
    })
    const dispose = effects[0]!()
    await vi.advanceTimersByTimeAsync(0)
    await dispose()
    expect(marks).toBe(expectedMarks)
  })

  it('preserves the legacy title-only delivery for a whitespace-only brief', async () => {
    vi.useFakeTimers()
    const effects: Array<() => (() => void)> = []
    const delivered: unknown[] = []
    let marks = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/brief/latest')) return new Response(JSON.stringify({ id: 'empty', period: 'now', summary: '   ' }))
      marks++
      return new Response('{}')
    }))
    setupBriefPusher({
      get: () => ({ roots: () => [{ id: 'active', followup(message: unknown) { delivered.push(message) } }] }),
      effect(callback: () => () => void) { effects.push(callback) },
      logger: { info() {} },
    } as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 30_000, pushSessions: [],
    })

    const dispose = effects[0]!()
    await vi.advanceTimersByTimeAsync(0)
    await dispose()

    expect(delivered).toHaveLength(1)
    expect(marks).toBe(1)
  })

  it('keeps the defensive empty-body guard for malformed string normalization', async () => {
    vi.useFakeTimers()
    const effects: Array<() => (() => void)> = []
    const delivered: unknown[] = []
    let marks = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/brief/latest')) return new Response(JSON.stringify({ id: 'malformed' }))
      marks++
      return new Response('{}')
    }))
    vi.spyOn(String.prototype, 'trim').mockReturnValue('')
    setupBriefPusher({
      get: () => ({ roots: () => [{ id: 'active', followup(message: unknown) { delivered.push(message) } }] }),
      effect(callback: () => () => void) { effects.push(callback) },
    } as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 30_000, pushSessions: [],
    })

    const dispose = effects[0]!()
    await vi.advanceTimersByTimeAsync(0)
    await dispose()

    expect(delivered).toEqual([])
    expect(marks).toBe(0)
  })

  it('skips a concurrent poll and safely handles an agents service that disappears during delivery', async () => {
    vi.useFakeTimers()
    const effects: Array<() => (() => void)> = []
    let beginFetch!: () => void
    const fetchStarted = new Promise<void>((resolve) => { beginFetch = resolve })
    let finishFetch!: () => void
    const fetchFinished = new Promise<void>((resolve) => { finishFetch = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      beginFetch()
      await fetchFinished
      return new Response(JSON.stringify({ id: 'brief', summary: '正文' }))
    }))
    let agentLookups = 0
    const ctx = {
      get() {
        agentLookups++
        return agentLookups === 1 ? { roots: () => [] } : undefined
      },
      effect(callback: () => () => void) { effects.push(callback) },
    }
    setupBriefPusher(ctx as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 30_000, pushSessions: [],
    })

    const dispose = effects[0]!()
    await fetchStarted
    await vi.advanceTimersByTimeAsync(30_000)
    finishFetch()
    await vi.advanceTimersByTimeAsync(0)
    await dispose()

    expect(agentLookups).toBeGreaterThan(1)
  })

  it('awaits an in-flight delivery and suppresses followup during disposal', async () => {
    vi.useFakeTimers()
    const effects: Array<() => (() => void | Promise<void>)> = []
    const response = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    let followups = 0
    setupBriefPusher({
      get: () => ({ roots: () => [{ id: 'active', followup() { followups++ } }] }),
      effect(callback: () => () => void | Promise<void>) { effects.push(callback) },
    } as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 30_000, pushSessions: [],
    })
    const dispose = effects[0]!()
    let disposed = false
    const disposing = Promise.resolve(dispose()).then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    response.resolve(new Response(JSON.stringify({ id: 'late', summary: 'late' })))
    await disposing
    await dispose()
    expect(followups).toBe(0)
  })

  it('stops the current audience loop when delivery synchronously initiates disposal', async () => {
    vi.useFakeTimers()
    const effects: Array<() => (() => Promise<void>)> = []
    let marks = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/brief/latest')) return new Response(JSON.stringify({ id: 'current', summary: 'body' }))
      marks++
      return new Response('{}')
    }))
    let dispose!: () => Promise<void>
    let disposing: Promise<void> | undefined
    let followups = 0
    setupBriefPusher({
      get: () => ({
        roots: () => [
          { id: 'first', followup() { followups++; disposing = dispose() } },
          { id: 'second', followup() { followups++ } },
        ],
      }),
      effect(callback: () => () => Promise<void>) { effects.push(callback) },
    } as never, {
      adapterBaseUrl: 'http://adapter.test', enableInChatPush: true, pushPollMs: 30_000, pushSessions: [],
    })
    dispose = effects[0]!()
    await vi.advanceTimersByTimeAsync(0)
    await disposing
    expect(followups).toBe(1)
    expect(marks).toBe(0)
  })
})
