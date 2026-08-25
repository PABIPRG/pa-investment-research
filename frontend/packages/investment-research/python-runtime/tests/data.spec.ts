import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestInvestmentData } from '../src/data.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('investment data broker', () => {
  it('maps security search and detail to fixed market-watch routes', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ code: '600519', name: '贵州茅台' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: '600519', name: '贵州茅台' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))

    await requestInvestmentData({
      operation: 'market-watch.security-search',
      input: { query: '贵州 茅台', limit: 6 },
    }, acquire)
    await requestInvestmentData({
      operation: 'market-watch.security-detail',
      input: { code: '600519', lookback: 180 },
    }, acquire)

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8100/securities/search?q=%E8%B4%B5%E5%B7%9E+%E8%8C%85%E5%8F%B0&limit=6', {
      method: 'GET',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8100/securities/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '600519', lookback: 180 }),
    })
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('maps a market scan to the fixed backend route and releases the lease', async () => {
    const release = vi.fn(async () => {})
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [{ code: '600519' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestInvestmentData({
      operation: 'market-watch.scan',
      input: { kind: 'amount', top_n: 8, min_amount_yi: 5 },
    }, acquire)).resolves.toEqual({ items: [{ code: '600519' }] })

    expect(acquire).toHaveBeenCalledWith('market-watch')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8100/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'amount', top_n: 8, min_amount_yi: 5 }),
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects unknown input keys before acquiring a backend', async () => {
    const acquire = vi.fn()
    await expect(requestInvestmentData({
      operation: 'market-watch.overview',
      input: { url: 'https://example.com' },
    }, acquire)).rejects.toThrow('unknown input key')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('releases the lease after an upstream HTTP failure', async () => {
    const release = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('broken', { status: 503 })))

    await expect(requestInvestmentData(
      { operation: 'trading-core.risk-alerts' },
      async () => ({ baseUrl: 'http://127.0.0.1:8000', release }),
    )).rejects.toThrow('HTTP 503')
    expect(release).toHaveBeenCalledOnce()
  })
})
