import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadObservatorySlice, type ObservatorySlice } from '../src/api.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('public observatory API client', () => {
  it('loads operations even when account funds are unavailable without fabricating valuations', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(String(input).includes('/activities?') ? { as_of: '2026-09-18', items: [{ title: '完成 · 持仓数据导入' }], next_cursor: null } : {
      availability: 'unavailable',
      reason_code: 'account-snapshot-unconfigured',
      message: '尚未配置可公开的权威账户权益快照。',
    })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await loadObservatorySlice(
      '2026-09-18', { category: 'all', status: 'all' }, new AbortController().signal,
    )
    expect(result.account).toBeNull()
    expect(result.accountUnavailable?.availability).toBe('unavailable')
    expect(result.activities?.items[0]?.title).toBe('完成 · 持仓数据导入')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://pair-api.xiexin.dev/api/public/performance/v1/overview?date=2026-09-18',
    )
  })

  it.each(['http://evil.example', 'file://localhost/data', 'ftp://127.0.0.1'])('rejects unsafe API base %s before fetch', async (base) => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', base)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(loadObservatorySlice('2026-09-18', { category: 'all', status: 'all' }, new AbortController().signal)).rejects.toThrow('HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not show a mixed account revision but keeps independently loaded operations', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      const value = path.endsWith('/overview') ? {
        availability: 'available', snapshot_id: 'a'.repeat(32), data_revision: 2, date: '2026-09-18', currency: 'CNY',
        summary: { initial_capital: '100.00', cash: '50.00', market_value: '50.00', total_equity: '100.00', cumulative_profit_loss: '0.00', cumulative_return: '0.00000000' },
        freshness: { recorded_at: '2026-09-18T15:00:00+08:00', price_as_of: '2026-09-18T15:00:00+08:00', stale: false, stale_reason: null },
      } : path.endsWith('/holdings') ? {
        snapshot_id: 'b'.repeat(32), data_revision: 1, date: '2026-09-18', currency: 'CNY', items: [],
      } : path.endsWith('/equity') ? {
        from: '2026-06-21', to: '2026-09-18', currency: 'CNY', latest_revision: 2, points: [],
      } : path.endsWith('/calendar') ? {
        month: '2026-09', currency: 'CNY', items: [],
      } : { as_of: '2026-09-18', items: [], next_cursor: null }
      return new Response(JSON.stringify(value))
    }))
    const result = await loadObservatorySlice(
      '2026-09-18', { category: 'all', status: 'all' }, new AbortController().signal,
    )
    expect(result.account).toBeNull()
    expect(result.accountError).toContain('数据版本发生变化')
    expect(result.activities).not.toBeNull()
  })

  it('isolates an operations failure and propagates cancellation', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/activities?')
      ? new Response('{}', { status: 503 })
      : new Response(JSON.stringify({ availability: 'unavailable', message: '缺少资金', reason_code: 'missing' }))))
    const result = await loadObservatorySlice('2026-09-18', { category: 'all', status: 'all' }, new AbortController().signal)
    expect(result.accountUnavailable?.message).toBe('缺少资金')
    expect(result.activitiesError).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }))
    await expect(loadObservatorySlice('2026-09-18', { category: 'all', status: 'all' }, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('publishes operations while an account request is still pending', async () => {
    vi.stubEnv('VITE_PUBLIC_API_BASE_URL', 'https://pair-api.xiexin.dev')
    let finishAccount!: (response: Response) => void
    const account = new Promise<Response>(resolve => { finishAccount = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/activities?')
      ? new Response(JSON.stringify({ as_of: '2026-09-18', items: [{ title: '已回滚 · 持仓数据重置' }], next_cursor: null })) : account))
    const progress: ObservatorySlice[] = []
    const loading = loadObservatorySlice('2026-09-18', { category: 'all', status: 'all' }, new AbortController().signal, slice => progress.push(slice))
    await vi.waitFor(() => expect(progress[0]?.activities?.items).toHaveLength(1))
    expect(progress[0]?.accountLoading).toBe(true)
    finishAccount(new Response(JSON.stringify({ availability: 'unavailable', reason_code: 'missing', message: '缺少资金' })))
    await loading
    expect(progress.at(-1)?.accountLoading).toBe(false)
  })
})
