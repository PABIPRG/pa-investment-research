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
    const acquire = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8000', release }))

    await requestInvestmentData({
      operation: 'trading-core.personalized-feedback',
      input: { card_id: 'card-1', sentiment: 'useful', meta: { surface: 'dashboard' } },
    }, acquire)

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/personalized/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: 'card-1', sentiment: 'useful', meta: { surface: 'dashboard' } }),
    })
    expect(release).toHaveBeenCalledOnce()

    await expect(requestInvestmentData({
      operation: 'trading-core.personalized-feedback',
      input: { card_id: 'card-1', sentiment: 'maybe' },
    }, acquire)).rejects.toThrow('sentiment must be useful or useless')
    expect(acquire).toHaveBeenCalledOnce()
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
