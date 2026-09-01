import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestInvestmentData } from '../src/data.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const body = (fetchMock.mock.calls[index]?.[1] as RequestInit | undefined)?.body
  if (typeof body !== 'string') throw new TypeError('expected a JSON string request body')
  return JSON.parse(body) as unknown
}

describe('investment data broker', () => {
  it('maps the market index overview to the fixed market-watch route', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [{ name: '上证指数' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await requestInvestmentData({ operation: 'market-watch.indices' }, async () => ({
      baseUrl: 'http://127.0.0.1:8100', release,
    }))

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8100/indices', { method: 'GET' })
    expect(release).toHaveBeenCalledOnce()
  })

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

  it('maps a batch quote request to the fixed market-watch route', async () => {
    const release = vi.fn(async () => {})
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      as_of: '2026-08-31 10:00:00', trade_date: '2026-08-31',
      items: [{ code: '600519', name: '贵州茅台', price: 1450.0, pct_change: 1.2 }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestInvestmentData({
      operation: 'market-watch.quotes-batch',
      input: { codes: ['600519', '000858'] },
    }, acquire)).resolves.toMatchObject({ items: [{ code: '600519', price: 1450.0 }] })

    expect(acquire).toHaveBeenCalledWith('market-watch')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8100/quotes/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: ['600519', '000858'] }),
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('maps an absent codes input to an empty codes batch body', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await requestInvestmentData({ operation: 'market-watch.quotes-batch' }, async () => ({
      baseUrl: 'http://127.0.0.1:8100', release,
    }))

    expect(bodyOf(fetchMock, 0)).toEqual({ codes: [] })
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects unsafe or non-string codes before acquiring the backend', async () => {
    const acquire = vi.fn()
    await expect(requestInvestmentData({
      operation: 'market-watch.quotes-batch',
      input: { codes: ['600519', ''] },
    }, acquire)).rejects.toThrow('codes must be an array of non-empty strings')
    await expect(requestInvestmentData({
      operation: 'market-watch.quotes-batch',
      input: { codes: [600519] },
    }, acquire)).rejects.toThrow('codes must be an array of non-empty strings')
    await expect(requestInvestmentData({
      operation: 'market-watch.quotes-batch',
      input: { codes: ['600519'], url: 'https://example.com' },
    }, acquire)).rejects.toThrow('unknown input key')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('maps security news to its fixed market-watch route with the default limit', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))

    await expect(requestInvestmentData({
      operation: 'market-watch.security-news', input: { code: '000001' },
    }, acquire)).resolves.toEqual({ items: [] })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8100/news/stock?code=000001&limit=8',
      { method: 'GET' },
    )
    expect(acquire).toHaveBeenCalledWith('market-watch')
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects unsafe security-news input before acquiring a lease', async () => {
    const acquire = vi.fn()

    await expect(requestInvestmentData({
      operation: 'market-watch.security-news', input: { code: '600519', url: '/arbitrary' },
    }, acquire)).rejects.toThrow('unknown input key')
    await expect(requestInvestmentData({
      operation: 'market-watch.security-news', input: { code: '600519/news/stock' },
    }, acquire)).rejects.toThrow('code must be exactly six digits')
    await expect(requestInvestmentData({
      operation: 'market-watch.security-news', input: { code: '600519', limit: 4 },
    }, acquire)).rejects.toThrow('limit must be an integer between 5 and 20')
    await expect(requestInvestmentData({
      operation: 'market-watch.security-news', input: { code: '600519', limit: 21 },
    }, acquire)).rejects.toThrow('limit must be an integer between 5 and 20')

    expect(acquire).not.toHaveBeenCalled()
  })

  it('passes through an accepted tech-signal JSON response and releases its lease', async () => {
    const release = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })))
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))

    await expect(requestInvestmentData({
      operation: 'market-watch.tech-signal', input: { code: '600519' },
    }, acquire)).resolves.toEqual({ status: 'queued' })

    expect(release).toHaveBeenCalledOnce()
  })

  it.each([
    ['fetch rejects', async () => { throw new Error('network down') }, /network down/],
    ['HTTP response fails', async () => new Response('unavailable', { status: 503 }), /failed with HTTP 503/],
    ['successful response contains invalid JSON', async () => new Response('not-json', { status: 200 }), /Unexpected token/],
  ])('releases the security-news lease when %s', async (_description, response, error) => {
    const release = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(response))
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))

    await expect(requestInvestmentData({
      operation: 'market-watch.security-news', input: { code: '600519' },
    }, acquire)).rejects.toThrow(error)

    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('maps all nine industry-chain operations to the fixed backend routes', async () => {
    const release = vi.fn(async () => {})
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8200', release }))
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await requestInvestmentData({ operation: 'industry-chain.data-status' }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.data-bootstrap' }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.stats' }, acquire)
    await requestInvestmentData({
      operation: 'industry-chain.companies', input: { keyword: '电池', limit: 5 },
    }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.company', input: { code: '300750' } }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.entity', input: { key: '正极/材料' } }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.single', input: { code: '300750' } }, acquire)
    await requestInvestmentData({
      operation: 'industry-chain.chain',
      input: { code: '300750', depth_up: 1, depth_down: 3, top_up: 5, top_down: 4 },
    }, acquire)
    await requestInvestmentData({
      operation: 'industry-chain.network',
      input: {
        min_degree: 4, min_market_cap: 120.5, min_share: 15,
        subject_only: true, include_universe: false,
      },
    }, acquire)

    expect(acquire.mock.calls).toEqual(Array.from({ length: 9 }, () => ['industry-chain']))
    expect(calls).toEqual([
      ['http://127.0.0.1:8200/data/status', { method: 'GET' }],
      ['http://127.0.0.1:8200/data/bootstrap', { method: 'POST' }],
      ['http://127.0.0.1:8200/stats', { method: 'GET' }],
      ['http://127.0.0.1:8200/companies?keyword=%E7%94%B5%E6%B1%A0&limit=5', { method: 'GET' }],
      ['http://127.0.0.1:8200/companies/300750', { method: 'GET' }],
      ['http://127.0.0.1:8200/graph/entity/%E6%AD%A3%E6%9E%81%2F%E6%9D%90%E6%96%99', { method: 'GET' }],
      ['http://127.0.0.1:8200/graph/single/300750', { method: 'GET' }],
      [
        'http://127.0.0.1:8200/graph/chain/300750?depth_up=1&depth_down=3&top_up=5&top_down=4',
        { method: 'GET' },
      ],
      [
        'http://127.0.0.1:8200/graph/network?min_degree=4&min_market_cap=120.5&min_share=15&subject_only=1&include_universe=0',
        { method: 'GET' },
      ],
    ])
    expect(release).toHaveBeenCalledTimes(9)
  })

  it('maps the complete trading workflow to fixed routes and typed inputs', async () => {
    const release = vi.fn(async () => {})
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8000', release }))
    const calls: Array<[string, string, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method ?? 'GET', init?.body as string | undefined])
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await requestInvestmentData({ operation: 'trading-core.reports', input: { limit: 12, task_type: 'strategy' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.report', input: { report_id: '11111111111111111111111111111111' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.strategies', input: { limit: 25 } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.watchlist' }, acquire)
    await requestInvestmentData({ operation: 'trading-core.watchlist-save', input: { tickers: ['600519', '000858'] } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.strategies-hypothesize', input: { limit: 8, dry_run: true } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.strategy-transition', input: { strategy_id: 'strategy:alpha', action: 'activate' } }, acquire)
    await requestInvestmentData({
      operation: 'trading-core.strategy-run',
      input: { strategy_id: 'strategy:alpha', lookback_years: 3, oos_frac: 0.25, initial_capital: 100_000, min_oos_trades: 5 },
    }, acquire)
    await requestInvestmentData({ operation: 'trading-core.shadow-status' }, acquire)
    await requestInvestmentData({ operation: 'trading-core.shadow-positions', input: { strategy_id: 'strategy:alpha' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.shadow-equity', input: { strategy_id: 'strategy:alpha', limit: 45 } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.shadow-run', input: { force: true, strategy_id: 'strategy:alpha' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.evolution-status' }, acquire)
    await requestInvestmentData({ operation: 'trading-core.evolution-attribution' }, acquire)
    await requestInvestmentData({ operation: 'trading-core.evolution-preview' }, acquire)
    await requestInvestmentData({
      operation: 'trading-core.evolution-run',
      input: { apply: true, preview_token: '3'.repeat(32) },
    }, acquire)
    await requestInvestmentData({ operation: 'trading-core.personalized-matches' }, acquire)
    await requestInvestmentData({ operation: 'trading-core.personalized-impact', input: { limit: 9 } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.brief-start', input: { period: 'pre_market', scope: 'all' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.task-status', input: { task_id: '22222222222222222222222222222222' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.task-result', input: { task_id: '22222222222222222222222222222222' } }, acquire)

    expect(calls).toEqual([
      ['http://127.0.0.1:8000/reports?limit=12&task_type=strategy', 'GET', undefined],
      ['http://127.0.0.1:8000/reports/11111111111111111111111111111111', 'GET', undefined],
      ['http://127.0.0.1:8000/strategies?limit=25', 'GET', undefined],
      ['http://127.0.0.1:8000/watchlist', 'GET', undefined],
      ['http://127.0.0.1:8000/watchlist', 'POST', '{"tickers":["600519","000858"]}'],
      ['http://127.0.0.1:8000/strategies/hypothesize', 'POST', '{"limit":8,"dry_run":true}'],
      ['http://127.0.0.1:8000/strategies/strategy%3Aalpha/activate', 'POST', undefined],
      ['http://127.0.0.1:8000/strategies/run', 'POST', '{"strategy_id":"strategy:alpha","lookback_years":3,"oos_frac":0.25,"initial_capital":100000,"min_oos_trades":5}'],
      ['http://127.0.0.1:8000/shadow/status', 'GET', undefined],
      ['http://127.0.0.1:8000/shadow/positions?strategy_id=strategy%3Aalpha', 'GET', undefined],
      ['http://127.0.0.1:8000/shadow/equity?strategy_id=strategy%3Aalpha&limit=45', 'GET', undefined],
      ['http://127.0.0.1:8000/shadow/run', 'POST', '{"force":true,"strategy_id":"strategy:alpha"}'],
      ['http://127.0.0.1:8000/evolution/status', 'GET', undefined],
      ['http://127.0.0.1:8000/evolution/attribution', 'GET', undefined],
      ['http://127.0.0.1:8000/evolution/preview', 'GET', undefined],
      ['http://127.0.0.1:8000/evolution/run', 'POST', `{"apply":true,"preview_token":"${'3'.repeat(32)}"}`],
      ['http://127.0.0.1:8000/personalized/matches', 'GET', undefined],
      ['http://127.0.0.1:8000/personalized/impact?limit=9', 'GET', undefined],
      ['http://127.0.0.1:8000/brief', 'POST', '{"period":"pre_market","scope":"all"}'],
      ['http://127.0.0.1:8000/analyze/22222222222222222222222222222222', 'GET', undefined],
      ['http://127.0.0.1:8000/analyze/22222222222222222222222222222222/result', 'GET', undefined],
    ])
    expect(acquire).toHaveBeenCalledTimes(21)
    expect(release).toHaveBeenCalledTimes(21)
  })

  it('rejects unsafe path identifiers, unsupported transitions and unknown workflow keys before acquiring', async () => {
    const acquire = vi.fn()
    await expect(requestInvestmentData({
      operation: 'industry-chain.dynamic-operation',
    } as never, acquire)).rejects.toThrow('unsupported operation')
    await expect(requestInvestmentData({
      operation: 'trading-core.report', input: { report_id: '../secret' },
    }, acquire)).rejects.toThrow('32-character lowercase hexadecimal identifier')
    await expect(requestInvestmentData({
      operation: 'trading-core.task-result', input: { task_id: 'task/escape' },
    }, acquire)).rejects.toThrow('32-character lowercase hexadecimal identifier')
    await expect(requestInvestmentData({
      operation: 'trading-core.strategy-transition', input: { strategy_id: 'strategy-1', action: 'watch' },
    }, acquire)).rejects.toThrow('unsupported action')
    await expect(requestInvestmentData({
      operation: 'trading-core.evolution-run', input: { apply: false, path: '/arbitrary' },
    }, acquire)).rejects.toThrow('unknown input key')
    await expect(requestInvestmentData({
      operation: 'trading-core.brief-start', input: { period: 'tomorrow' },
    }, acquire)).rejects.toThrow('unsupported period')
    await expect(requestInvestmentData({
      operation: 'trading-core.strategy-detail', input: { strategy_id: '../strategy' },
    }, acquire)).rejects.toThrow('strategy_id must be a safe identifier')
    await expect(requestInvestmentData({
      operation: 'industry-chain.company', input: { code: '300750/private' },
    }, acquire)).rejects.toThrow('code must be a safe identifier')
    await expect(requestInvestmentData({
      operation: 'industry-chain.entity', input: { key: '../材料' },
    }, acquire)).rejects.toThrow('key must be a safe entity identifier')
    await expect(requestInvestmentData({
      operation: 'industry-chain.chain', input: { code: '300750', endpoint: '/arbitrary' },
    } as never, acquire)).rejects.toThrow('unknown input key')
    await expect(requestInvestmentData({
      operation: 'industry-chain.data-bootstrap', input: { url: 'https://example.com/data' },
    }, acquire)).rejects.toThrow('unknown input key')
    await expect(requestInvestmentData({
      operation: 'trading-core.evolution-run', input: { apply: true },
    }, acquire)).rejects.toThrow('preview_token is required')
    await expect(requestInvestmentData({
      operation: 'trading-core.evolution-run', input: { apply: false, preview_token: '3'.repeat(32) },
    }, acquire)).rejects.toThrow('preview_token is only accepted')
    await expect(requestInvestmentData({
      operation: 'trading-core.evolution-run', input: { apply: true, preview_token: 'preview-token' },
    }, acquire)).rejects.toThrow('32-character lowercase hexadecimal identifier')
    expect(acquire).not.toHaveBeenCalled()
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
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8000', release }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('broken', { status: 503 })))

    await expect(requestInvestmentData(
      { operation: 'trading-core.risk-alerts' },
      acquire,
    )).rejects.toThrow('investment data: trading-core.risk-alerts failed with HTTP 503: broken')
    expect(acquire).toHaveBeenCalledWith('trading-core')
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases the lease when a successful response contains invalid JSON', async () => {
    const release = vi.fn(async () => {})
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8100', release }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(requestInvestmentData(
      { operation: 'market-watch.overview' },
      acquire,
    )).rejects.toThrow()
    expect(acquire).toHaveBeenCalledWith('market-watch')
    expect(release).toHaveBeenCalledOnce()
  })

  it('maps strategy, shadow, profile, and evolution reads to fixed trading-core routes', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ items: [] }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = async () => ({ baseUrl: 'http://127.0.0.1:8000', release })

    await requestInvestmentData({ operation: 'trading-core.strategies', input: { status: 'active', limit: 20 } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.shadow-equity', input: { strategy_id: 's1', limit: 30 } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.risk-profile' }, acquire)
    await requestInvestmentData({ operation: 'trading-core.evolution-attribution' }, acquire)

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8000/strategies?status=active&limit=20', { method: 'GET' })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8000/shadow/equity?strategy_id=s1&limit=30', { method: 'GET' })
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:8000/risk_profile', { method: 'GET' })
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://127.0.0.1:8000/evolution/attribution', { method: 'GET' })
    expect(release).toHaveBeenCalledTimes(4)
  })

  it('maps business workflow writes and task polling to fixed trading-core routes', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = async () => ({ baseUrl: 'http://127.0.0.1:8000', release })

    await requestInvestmentData({ operation: 'trading-core.analyze', input: { ticker: '600519', research_depth: 'deep' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.brief-run', input: { period: 'pre_market', scope: 'all' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.backtest-run', input: { code: '600519', eval_window_days: 20 } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.holdings-analyze', input: { mode: 'quick', use_saved: true } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.strategies-hypothesize', input: { limit: 20, dry_run: true } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.strategy-run', input: { strategy_id: 'strat-1' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.strategy-action', input: { strategy_id: 'strat-1', action: 'activate' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.shadow-run', input: { force: false } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.evolution-run', input: { apply: false } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.task-status', input: { task_id: 'task:1' } }, acquire)
    await requestInvestmentData({ operation: 'trading-core.task-result', input: { task_id: 'task:1' } }, acquire)

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['http://127.0.0.1:8000/analyze', 'POST'],
      ['http://127.0.0.1:8000/brief', 'POST'],
      ['http://127.0.0.1:8000/backtest/run', 'POST'],
      ['http://127.0.0.1:8000/holdings/analyze', 'POST'],
      ['http://127.0.0.1:8000/strategies/hypothesize', 'POST'],
      ['http://127.0.0.1:8000/strategies/run', 'POST'],
      ['http://127.0.0.1:8000/strategies/strat-1/activate', 'POST'],
      ['http://127.0.0.1:8000/shadow/run', 'POST'],
      ['http://127.0.0.1:8000/evolution/run', 'POST'],
      ['http://127.0.0.1:8000/analyze/task%3A1', 'GET'],
      ['http://127.0.0.1:8000/analyze/task%3A1/result', 'GET'],
    ])
    expect(bodyOf(fetchMock, 0)).toEqual({ ticker: '600519', market: 'a_shares', research_depth: 'deep' })
    expect(bodyOf(fetchMock, 1)).toEqual({ period: 'pre_market', scope: 'all' })
    expect(bodyOf(fetchMock, 2)).toEqual({
      code: '600519', force: false, eval_window_days: 20, min_age_days: 14, limit: 200,
      stop_loss_pct: 5, take_profit_pct: 10, neutral_band_pct: 2,
    })
    expect(bodyOf(fetchMock, 4)).toEqual({ limit: 20, dry_run: true })
    expect(bodyOf(fetchMock, 8)).toEqual({ apply: false })
    expect(release).toHaveBeenCalledTimes(11)
  })

  it('rejects unsafe workflow parameters before acquiring trading-core', async () => {
    const acquire = vi.fn()
    await expect(requestInvestmentData({
      operation: 'trading-core.strategy-action', input: { strategy_id: 's1', action: 'delete' },
    }, acquire)).rejects.toThrow('action must be activate, reject, or retire')
    await expect(requestInvestmentData({
      operation: 'trading-core.brief-run', input: { period: 'tomorrow' },
    }, acquire)).rejects.toThrow('period must be pre_market, post_market, or now')
    await expect(requestInvestmentData({
      operation: 'trading-core.holdings-analyze', input: { mode: 'instant' },
    }, acquire)).rejects.toThrow('mode must be quick or deep')
    await expect(requestInvestmentData({
      operation: 'trading-core.analyze', input: { ticker: '600519', research_depth: 'instant' },
    }, acquire)).rejects.toThrow('unsupported research_depth')
    await expect(requestInvestmentData({
      operation: 'trading-core.backtest-run', input: { eval_window_days: 121 },
    }, acquire)).rejects.toThrow('eval_window_days must be an integer between 1 and 120')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('maps validated KYC writes without exposing arbitrary routes', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = async () => ({ baseUrl: 'http://127.0.0.1:8000', release })

    await requestInvestmentData({
      operation: 'trading-core.kyc-questionnaire',
      input: { answers: [{ qid: 'horizon', label: '3 年', score: 3 }], tier: 'quick', method: 'questionnaire' },
    }, acquire)
    await requestInvestmentData({
      operation: 'trading-core.kyc-adjust', input: { risk_tolerance: 0.7, horizon_years: 5, note: '长期配置' },
    }, acquire)
    await requestInvestmentData({ operation: 'trading-core.kyc-parse', input: { text: '可以承受中等回撤' } }, acquire)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8000/kyc/questionnaire',
      'http://127.0.0.1:8000/kyc/adjust',
      'http://127.0.0.1:8000/kyc/parse',
    ])
    expect(bodyOf(fetchMock, 0)).toEqual({
      answers: [{ qid: 'horizon', label: '3 年', score: 3 }], tier: 'quick', method: 'questionnaire',
    })
    expect(release).toHaveBeenCalledTimes(3)
  })

  it('persists personalized-card feedback through a fixed trading-core route', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8000', ownership: 'owned' as const, release,
    }))

    await requestInvestmentData({
      operation: 'trading-core.personalized-feedback',
      input: { card_id: 'card-1', sentiment: 'useful', meta: { ticker: '600519.SH', risk_source: 'event' } },
    }, acquire)

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/personalized/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card_id: 'card-1', sentiment: 'useful', meta: { ticker: '600519.SH', risk_source: 'event' },
      }),
    })
    expect(release).toHaveBeenCalledOnce()

    await expect(requestInvestmentData({
      operation: 'trading-core.personalized-feedback',
      input: { card_id: 'card-1', sentiment: 'maybe' },
    }, acquire)).rejects.toThrow('sentiment must be useful or useless')
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('maps local learning events, status, settings, clear, and review to fixed local routes', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8000', ownership: 'attached' as const, release,
    }))
    const event = {
      event_id: 'evt:1', schema_version: 1, action: 'open', surface: 'dashboard',
      target_type: 'event', target_id: 'event-1', session_id: 'session:1',
      context: {
        ticker: '600519.SH', industries: ['白酒'], strategy_id: 'strategy:alpha',
        direction: '利空', bucket: 'holdings', event_type: '公告', risk_source: 'event',
        risk_severity: '高', analysis_kind: 'stock', position: 2, reason_codes: ['holding-hit'],
      },
    }

    await requestInvestmentData({
      operation: 'trading-core.local-learning-events', input: { events: [event] },
    }, acquire)
    await requestInvestmentData({ operation: 'trading-core.local-learning-status' }, acquire)
    await requestInvestmentData({
      operation: 'trading-core.local-learning-settings', input: { enabled: false },
    }, acquire)
    await requestInvestmentData({
      operation: 'trading-core.local-learning-clear', input: { confirm: true },
    }, acquire)
    await requestInvestmentData({
      operation: 'trading-core.local-learning-review', input: { days: 30 },
    }, acquire)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8000/personalized/local-learning/events',
      'http://127.0.0.1:8000/personalized/local-learning/status',
      'http://127.0.0.1:8000/personalized/local-learning/settings',
      'http://127.0.0.1:8000/personalized/local-learning/clear',
      'http://127.0.0.1:8000/personalized/review?days=30',
    ])
    expect(bodyOf(fetchMock, 0)).toEqual({ events: [event] })
    expect(bodyOf(fetchMock, 2)).toEqual({ enabled: false })
    expect(bodyOf(fetchMock, 3)).toEqual({ confirm: true })
    expect(release).toHaveBeenCalledTimes(5)
  })

  it('rejects unsafe local metadata and invalid controls before acquiring a backend', async () => {
    const acquire = vi.fn()
    const baseEvent = {
      event_id: 'evt-1', schema_version: 1, action: 'open', surface: 'dashboard',
      target_type: 'event', target_id: 'event-1', session_id: 'session-1', context: {},
    }

    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-events',
      input: { events: [{ ...baseEvent, context: { query: 'secret' } }] },
    }, acquire)).rejects.toThrow('unknown input key')
    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-events', input: { events: [] },
    }, acquire)).rejects.toThrow('between 1 and 50')
    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-events',
      input: { events: [{ ...baseEvent, schema_version: 2 }] },
    }, acquire)).rejects.toThrow('schema_version must be 1')
    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-settings', input: {},
    }, acquire)).rejects.toThrow('enabled is required')
    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-clear', input: { confirm: false },
    }, acquire)).rejects.toThrow('confirm must be true')
    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-review', input: { days: 14 },
    }, acquire)).rejects.toThrow('days must be 7, 30, or 90')
    await expect(requestInvestmentData({
      operation: 'trading-core.personalized-feedback',
      input: { card_id: 'card-1', sentiment: 'useful', meta: { title: 'secret' } },
    }, acquire)).rejects.toThrow('unknown input key')
    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-events',
      input: { events: [{ ...baseEvent, target_id: '用户搜索 贵州茅台' }] },
    }, acquire)).rejects.toThrow('safe identifier')
    await expect(requestInvestmentData({
      operation: 'trading-core.local-learning-events',
      input: { events: [{ ...baseEvent, context: { direction: '非常看好' } }] },
    }, acquire)).rejects.toThrow('allowed value')
    await expect(requestInvestmentData({
      operation: 'trading-core.personalized-feedback',
      input: { card_id: '一段卡片标题', sentiment: 'useful' },
    }, acquire)).rejects.toThrow('safe identifier')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('blocks every local learning operation before fetch in external mode and releases leases', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const acquire = vi.fn(async () => ({
      baseUrl: 'https://external.example', ownership: 'external' as const, release,
    }))
    const requests = [
      {
        operation: 'trading-core.personalized-feedback' as const,
        input: { card_id: 'card-1', sentiment: 'useful' },
      },
      {
        operation: 'trading-core.local-learning-events' as const,
        input: { events: [{
          event_id: 'evt-1', schema_version: 1, action: 'open', surface: 'dashboard',
          target_type: 'event', target_id: 'event-1', session_id: 'session-1', context: {},
        }] },
      },
      { operation: 'trading-core.local-learning-status' as const },
      { operation: 'trading-core.local-learning-settings' as const, input: { enabled: true } },
      { operation: 'trading-core.local-learning-clear' as const, input: { confirm: true } },
      { operation: 'trading-core.local-learning-review' as const, input: { days: 7 } },
    ]

    for (const request of requests) {
      await expect(requestInvestmentData(request, acquire)).rejects.toThrow('requires a local backend')
    }

    expect(fetchMock).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(requests.length)
  })

  it('maps the complete industry-chain read surface to fixed routes', async () => {
    const release = vi.fn(async () => {})
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ items: [] }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8200', release }))

    await requestInvestmentData({ operation: 'industry-chain.stats' }, acquire)
    await requestInvestmentData({
      operation: 'industry-chain.companies', input: { keyword: '半导体 设备', limit: 8 },
    }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.company', input: { code: '688981' } }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.entity', input: { key: '刻蚀/设备' } }, acquire)
    await requestInvestmentData({ operation: 'industry-chain.single', input: { code: '688981' } }, acquire)
    await requestInvestmentData({
      operation: 'industry-chain.chain',
      input: { code: '688981', depth_up: 3, depth_down: 1, top_up: 5, top_down: 4 },
    }, acquire)
    await requestInvestmentData({
      operation: 'industry-chain.network',
      input: { min_degree: 4, min_market_cap: 100, min_share: 12.5, subject_only: true, include_universe: false },
    }, acquire)

    expect(acquire.mock.calls).toEqual(Array.from({ length: 7 }, () => ['industry-chain']))
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8200/stats',
      'http://127.0.0.1:8200/companies?keyword=%E5%8D%8A%E5%AF%BC%E4%BD%93+%E8%AE%BE%E5%A4%87&limit=8',
      'http://127.0.0.1:8200/companies/688981',
      'http://127.0.0.1:8200/graph/entity/%E5%88%BB%E8%9A%80%2F%E8%AE%BE%E5%A4%87',
      'http://127.0.0.1:8200/graph/single/688981',
      'http://127.0.0.1:8200/graph/chain/688981?depth_up=3&depth_down=1&top_up=5&top_down=4',
      'http://127.0.0.1:8200/graph/network?min_degree=4&min_market_cap=100&min_share=12.5&subject_only=1&include_universe=0',
    ])
    expect(release).toHaveBeenCalledTimes(7)
  })

  it('rejects out-of-range industry-chain parameters before acquiring the backend', async () => {
    const acquire = vi.fn()
    await expect(requestInvestmentData({
      operation: 'industry-chain.chain', input: { code: '688981', depth_up: 4 },
    }, acquire)).rejects.toThrow('depth_up must be an integer between 1 and 3')
    await expect(requestInvestmentData({
      operation: 'industry-chain.network', input: { min_share: 101 },
    }, acquire)).rejects.toThrow('min_share must be between 0 and 100')
    await expect(requestInvestmentData({
      operation: 'industry-chain.company', input: { code: 'x'.repeat(129) },
    }, acquire)).rejects.toThrow('code must be at most 128 characters')
    expect(acquire).not.toHaveBeenCalled()
  })
})
