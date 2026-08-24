import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestInvestmentData } from '../src/data.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('investment data broker', () => {
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

  it('maps base news explicitly without event enrichment or personalization', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await requestInvestmentData({
      operation: 'market-watch.news-flash',
      input: { limit: 12, enrich: false, personal: false },
    }, async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8100/news/flash?limit=12&enrich=0&personal=0',
      { method: 'GET' },
    )
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
