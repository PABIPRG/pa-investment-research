import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCalendar, loadObservatorySlice } from '../src/api.ts'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const live = {
  availability: 'available', date: '2026-09-29', currency: 'CNY', source: 'current_holdings', holdings_as_of: '2026-09-29',
  summary: { holdings_cost: '230.00', market_value: null, floating_profit_loss: null, cost_return: null, cash: null, initial_capital: null, total_equity: null },
  items: [{ ticker: '600519', name: '', quantity: '2', cost_price: '100', market_price: null, market_value: null, profit_loss: null, return_rate: null }],
  freshness: { stale: true, message: '部分报价缺失' },
}
const history = { from: '2026-07-02', to: '2026-09-29', currency: 'CNY', quality: 'estimated', limitations: [], available_since: '2026-09-20', points: [] }
const activities = { as_of: '2026-09-29', items: [{ public_id: 'a'.repeat(24), title: '持仓资料更新', category: 'operation', status: 'completed', occurred_at: '2026-09-29T10:00:00+08:00', summary: '资料变化，非成交' }], next_cursor: null }

function response(input: string | URL | Request): Response {
  const url = new URL(String(input))
  if (url.pathname.endsWith('/live')) return new Response(JSON.stringify(live))
  if (url.pathname.endsWith('/history')) return new Response(JSON.stringify(history))
  if (url.pathname.endsWith('/calendar')) return new Response(JSON.stringify({ days: [] }))
  return new Response(JSON.stringify(activities))
}

describe('public observatory independent data reads', () => {
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
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/live?')
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
      const path = new URL(String(input)).pathname
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
      if (new URL(String(input)).pathname.endsWith('/calendar')) return new Response(JSON.stringify({ days: [] }))
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
