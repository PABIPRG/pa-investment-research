import { afterEach, describe, expect, it, vi } from 'vitest'
import { historyCutoff, loadCalendar, loadLive, loadObservatorySlice, PublicApiError } from '../src/api.ts'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })

const live = {
  availability: 'available', date: '2026-09-29', currency: 'CNY', source: 'current_holdings', holdings_as_of: '2026-09-29',
  summary: { holdings_cost: '230.00', market_value: null, floating_profit_loss: null, cost_return: null, cash: null, initial_capital: null, total_equity: null },
  items: [{ ticker: '600519', name: '', quantity: '2', cost_price: '100', market_price: null, market_value: null, profit_loss: null, return_rate: null }],
  freshness: { stale: true, message: '部分报价缺失' },
}
const history = { from: '2026-07-02', to: '2026-09-29', currency: 'CNY', quality: 'estimated', limitations: [], available_since: '2026-09-20', points: [] }
const activities = { as_of: '2026-09-29', items: [{ public_id: 'a'.repeat(24), title: '持仓资料更新', category: 'operation', status: 'completed', occurred_at: '2026-09-29T10:00:00+08:00', summary: '资料变化，非成交' }], next_cursor: null }

const requestUrl = (input: string | URL | Request) => input instanceof Request ? input.url : String(input)

function response(input: string | URL | Request): Response {
  const url = new URL(requestUrl(input))
  if (url.pathname.endsWith('/live')) return new Response(JSON.stringify(live))
  if (url.pathname.endsWith('/history')) return new Response(JSON.stringify(history))
  if (url.pathname.endsWith('/calendar')) return new Response(JSON.stringify({ days: [] }))
  return new Response(JSON.stringify(activities))
}

describe('public observatory independent data reads', () => {
  it.each(['headers', 'body'])('times out stalled %s without treating the timeout as a query cancellation', async (phase) => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'http://127.0.0.1:3409')
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => {
      signal = init.signal!
      const pending = () => new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }, { once: true }) })
      return phase === 'headers' ? pending() : Promise.resolve({ ok: true, json: pending })
    }))
    const controller = new AbortController()
    const result = loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, controller.signal, undefined, ['live'])
    await vi.advanceTimersByTimeAsync(29_999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(await result).toMatchObject({ liveLoading: false, liveError: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps external cancellation silent and releases the deadline timer', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'http://127.0.0.1:3409')
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    })))
    const controller = new AbortController()
    const progress = vi.fn()
    const result = loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, controller.signal, progress, ['live'])
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(progress).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the rate-limit delay across partial failures, including inaccessible headers', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'http://127.0.0.1:3409')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })))
    await expect(loadLive('2026-09-29')).rejects.toMatchObject({ status: 429, retryAfterMs: 60_000 })
    vi.stubGlobal('fetch', vi.fn(async (input: URL) => input.pathname.endsWith('/live')
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '180' } }) : response(input)))
    const result = await loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, new AbortController().signal, undefined, ['live', 'activities'])
    expect(result).toMatchObject({ liveError: true, activitiesError: false, retryAfterMs: 180_000 })
    expect(new PublicApiError(503, 'unavailable').retryAfterMs).toBe(0)
  })

  it('handles year boundaries and future months without requesting an inverted history interval', async () => {
    expect(historyCutoff('2027-01-01', '2027-01-01')).toBe('2026-12-31')
    expect(historyCutoff('2026-12-24', '2027-01-01')).toBe('2026-12-24')
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'http://127.0.0.1:3409')
    const fetchMock = vi.fn(async (input: string | URL | Request) => response(input))
    vi.stubGlobal('fetch', fetchMock)
    expect((await loadCalendar('2027-02', undefined, '2026-12-31')).items).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/calendar?month=2027-02')
  })

  it('refreshes only live holdings and activities when historical reads are excluded', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'http://127.0.0.1:3409')
    const fetchMock = vi.fn(async (input: string | URL | Request) => response(input))
    vi.stubGlobal('fetch', fetchMock)
    await loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, new AbortController().signal, undefined, ['live', 'activities'])
    expect(fetchMock.mock.calls.map(([input]) => new URL(requestUrl(input)).pathname.split('/').at(-1))).toEqual(['live', 'activities'])
  })

  it('caps calendar valuations at yesterday in Shanghai while retaining the full trading calendar', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T16:01:00Z'))
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'http://127.0.0.1:3409')
    const fetchMock = vi.fn(async (input: string | URL | Request) => response(input))
    vi.stubGlobal('fetch', fetchMock)
    await loadCalendar('2026-09')
    const historyUrl = fetchMock.mock.calls.map(([input]) => new URL(requestUrl(input))).find(url => url.pathname.endsWith('/history'))!
    expect(historyUrl.searchParams.get('to')).toBe('2026-09-29')
  })

  it('shows current holdings without any full account snapshot and keeps missing quotes null', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => response(input))
    vi.stubGlobal('fetch', fetchMock)
    const result = await loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, new AbortController().signal)
    expect(result.live?.availability).toBe('available')
    if (result.live?.availability !== 'available') throw new Error('live data missing')
    expect(result.live.summary.market_value).toBeNull()
    expect(result.live.items[0]?.ticker).toBe('600519')
    expect(result.history?.quality).toBe('estimated')
    expect(result.activities?.items).toHaveLength(1)
    expect(fetchMock.mock.calls.every(call => call[0] instanceof URL)).toBe(true)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' })
  })

  it('isolates history, calendar and activities failures from current holdings', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => requestUrl(input).includes('/live?')
      ? response(input) : new Response('{}', { status: 503 })))
    const result = await loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, new AbortController().signal)
    expect(result.live?.availability).toBe('available')
    expect(result.historyError).toBe(true)
    expect(result.calendarError).toBe(true)
    expect(result.activitiesError).toBe(true)
  })

  it('keeps recorded estimates when the trading calendar is unknown and excludes closed days', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(requestUrl(input)).pathname
      if (path.endsWith('/calendar')) return new Response(JSON.stringify({ days: [
        { date: '2026-09-24', trading_status: 'unknown' },
        { date: '2026-09-25', trading_status: 'trading' },
        { date: '2026-09-26', trading_status: 'closed' },
        { date: '2026-09-28', trading_status: 'unknown' },
      ] }))
      return new Response(JSON.stringify({ points: [
        { date: '2026-09-24', value: '110.00', profit_loss: '10.00' },
        { date: '2026-09-25', value: '112.00', profit_loss: '12.00' },
        { date: '2026-09-26', value: '112.00', profit_loss: '12.00' },
        { date: '2026-09-28', value: '115.00', profit_loss: '15.00' },
      ], limitations: [] }))
    }))
    const calendar = await loadCalendar('2026-09')
    expect(calendar.items).toEqual([
      { date: '2026-09-24', daily_profit_loss: null },
      { date: '2026-09-25', daily_profit_loss: '2.00' },
      { date: '2026-09-28', daily_profit_loss: '3.00' },
    ])
  })

  it('uses the prior month as a baseline without publishing it or filling missing estimates with zero', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (new URL(requestUrl(input)).pathname.endsWith('/calendar')) return new Response(JSON.stringify({ days: [] }))
      return new Response(JSON.stringify({ points: [
        { date: '2026-09-03', value: '110', profit_loss: null },
        { date: '2026-09-02', value: null, profit_loss: null },
        { date: '2026-09-01', value: '105', profit_loss: '5' },
        { date: '2026-08-31', value: '100', profit_loss: '0' },
      ], limitations: [] }))
    }))
    expect((await loadCalendar('2026-09')).items).toEqual([
      { date: '2026-09-01', daily_profit_loss: '5.00' },
      { date: '2026-09-03', daily_profit_loss: null },
    ])
  })

  it.each(['http://evil.example' , 'file://localhost/data', 'ftp://127.0.0.1'])('rejects unsafe API base %s before fetch', async (base) => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', base)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, new AbortController().signal)).rejects.toThrow('HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates cancellation and suppresses stale progress', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }))
    const controller = new AbortController()
    const progress = vi.fn()
    await expect(loadObservatorySlice('2026-09-29', { category: 'all', status: 'all' }, controller.signal, progress)).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).not.toHaveBeenCalled()
  })
})
