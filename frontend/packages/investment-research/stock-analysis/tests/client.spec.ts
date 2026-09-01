import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeSse,
  getLatestBrief,
  getInvestmentContext,
  getResearchChatContext,
  getRiskProfile,
  getStrategyDetail,
  getWatchlist,
  httpJson,
  parseSse,
  saveHoldings,
  setRiskProfile,
  setWatchlist,
  startAnalysis,
  startTask,
} from '../src/client.ts'

const BASE = 'http://adapter.test'

afterEach(() => vi.unstubAllGlobals())

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('stock-analysis adapter client', () => {
  it('posts task bodies to their preserved routes and returns task_id', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init)
      return response({ task_id: 'task-7' })
    }))
    const signal = new AbortController().signal

    await expect(startTask(BASE, '/brief', { period: 'now' }, signal)).resolves.toBe('task-7')
    await expect(startAnalysis(BASE, { ticker: '600519' }, signal)).resolves.toBe('task-7')

    expect(requests).toEqual([
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"period":"now"}', signal },
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ticker":"600519"}', signal },
    ])
  })

  it('preserves JSON routes, methods and bodies for saved investment state', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return response({ ok: true })
    }))
    const signal = new AbortController().signal

    await Promise.all([
      getWatchlist(BASE, signal),
      setWatchlist(BASE, ['600519'], signal),
      getLatestBrief(BASE, signal),
      getRiskProfile(BASE, signal),
      setRiskProfile(BASE, 'balanced', signal),
      saveHoldings(BASE, [{ ticker: '600519', quantity: 1, cost_price: 100 }], signal),
    ])

    expect(calls.map(call => [call.url, call.init.method, call.init.body])).toEqual([
      [`${BASE}/watchlist`, 'GET', undefined],
      [`${BASE}/watchlist`, 'POST', '{"tickers":["600519"]}'],
      [`${BASE}/brief/latest`, 'GET', undefined],
      [`${BASE}/risk_profile`, 'GET', undefined],
      [`${BASE}/risk_profile`, 'POST', '{"risk_profile":"balanced"}'],
      [`${BASE}/holdings/save`, 'POST', '{"holdings":[{"ticker":"600519","quantity":1,"cost_price":100}]}'],
    ])
  })

  it('reads every investment context domain only through fixed trading-core routes', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return response({ source: url })
    }))
    const signal = new AbortController().signal

    const results = []
    for (const domain of ['portfolio', 'strategy', 'shadow', 'evolution', 'reports', 'industry'] as const) {
      results.push(await getInvestmentContext(BASE, domain, signal))
    }

    expect(calls).toEqual([
      `${BASE}/holdings`,
      `${BASE}/risk/portfolio`,
      `${BASE}/risk/alerts`,
      `${BASE}/strategies?limit=50`,
      `${BASE}/shadow/status`,
      `${BASE}/shadow/positions`,
      `${BASE}/shadow/equity?limit=30`,
      `${BASE}/evolution/status`,
      `${BASE}/evolution/attribution`,
      `${BASE}/evolution/preview`,
      `${BASE}/reports?limit=20`,
      `${BASE}/personalized/impact?limit=20`,
    ])
    expect(results.map(result => [result.domain, Object.keys(result.resources)])).toEqual([
      ['portfolio', ['holdings', 'portfolio_risk', 'risk_alerts']],
      ['strategy', ['strategies']],
      ['shadow', ['status', 'positions', 'equity']],
      ['evolution', ['status', 'attribution', 'preview']],
      ['reports', ['reports']],
      ['industry', ['impact']],
    ])
    expect(await getInvestmentContext(BASE, 'reports', signal)).toMatchObject({
      domain: 'reports',
      resources: { reports: { source: `${BASE}/reports?limit=20` } },
    })
    await expect(getInvestmentContext(BASE, 'browser-state' as never, signal))
      .rejects.toThrow('不支持的投研上下文领域')
  })

  it('reads research selection and strategy detail through encoded fixed routes', async () => {
    const calls: Array<{ url: string; signal: AbortSignal | undefined }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, signal: init.signal ?? undefined })
      return response({ ok: true })
    }))
    const signal = new AbortController().signal

    await getResearchChatContext(BASE, 'session:1', signal)
    await getStrategyDetail(BASE, 'strategy:@1', signal)

    expect(calls).toEqual([
      { url: `${BASE}/research-chat/contexts/session%3A1`, signal },
      { url: `${BASE}/strategies/strategy%3A%401`, signal },
    ])
  })

  it('rejects unsafe research identifiers before network I/O', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    expect(() => getResearchChatContext(BASE, '../session')).toThrow('会话 ID 格式无效')
    expect(() => getStrategyDetail(BASE, 'strategy/escape')).toThrow('策略 ID 格式无效')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a selected report detail through a validated fixed route', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return response({ source: url })
    }))
    const reportId = 'a'.repeat(32)
    const result = await getInvestmentContext(
      BASE,
      'reports',
      new AbortController().signal,
      reportId,
    )

    expect(calls).toEqual([
      `${BASE}/reports?limit=20`,
      `${BASE}/reports/${reportId}`,
    ])
    expect(result.resources).toEqual({
      reports: { source: `${BASE}/reports?limit=20` },
      report_detail: { source: `${BASE}/reports/${reportId}` },
    })
  })

  it('rejects unsafe or cross-domain context references before network I/O', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal

    await expect(getInvestmentContext(BASE, 'reports', signal, '../risk_profile'))
      .rejects.toThrow('32 位小写十六进制报告 ID')
    await expect(getInvestmentContext(BASE, 'portfolio', signal, 'a'.repeat(32)))
      .rejects.toThrow('只有报告上下文支持资源引用')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports HTTP errors and missing task ids from the adapter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('unavailable', 503)))
    await expect(httpJson(BASE, '/watchlist', 'GET')).rejects.toThrow('适配器 HTTP 503: unavailable')

    vi.stubGlobal('fetch', vi.fn(async () => response({})))
    await expect(startTask(BASE, '/analyze', {}, new AbortController().signal))
      .rejects.toThrow('适配器未返回 task_id: {}')

    vi.stubGlobal('fetch', vi.fn(async () => response('broken', 400)))
    await expect(startTask(BASE, '/analyze', {}, new AbortController().signal))
      .rejects.toThrow('适配器 HTTP 400: broken')
  })

  it('decodes CRLF frames, split chunks and a final unterminated frame', async () => {
    const frames = []
    for await (const frame of parseSse(stream(
      'event: stage\r\ndata: {"message":"开始',
      '"}\r\n\r\nevent: result\ndata: {"ok":true}',
    ))) frames.push(frame)

    expect(frames).toEqual([
      { event: 'stage', data: '{"message":"开始"}' },
      { event: 'result', data: '{"ok":true}' },
    ])

    const partialFrames = []
    for await (const frame of parseSse(stream('event: ping\n\n', 'data: lone-data\n\n', ': keep-alive\n\n'))) partialFrames.push(frame)
    expect(partialFrames).toEqual([{ event: 'ping' }, { data: 'lone-data' }, {}])
  })

  it('consumes stage, result and done frames while injecting real progress messages', async () => {
    const injected: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(
      'event: stage\ndata: {"message":"分析中"}\n\n',
      'event: stage\ndata: 原始进度\n\n',
      'event: result\ndata: {"signal":{"action":"买入"}}\n\n',
      'event: done\ndata: {}\n\n',
    ))))
    const stages: string[] = []

    await expect(consumeSse(`${BASE}/analyze/task-7/stream`, {
      signal: new AbortController().signal,
      agent: { inject(message) {
        const block = message.content[0]
        if (block?.type === 'text') injected.push(block.text)
      } },
    }, 1_000, message => stages.push(message))).resolves.toEqual({ signal: { action: '买入' } })

    expect(stages).toEqual(['分析中', '原始进度'])
    expect(injected).toEqual(['分析中', '原始进度'])
  })

  it('normalizes SSE HTTP, error and incomplete-stream failures', async () => {
    const sink = { signal: new AbortController().signal }
    vi.stubGlobal('fetch', vi.fn(async () => response('bad', 500)))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).rejects.toThrow('适配器 SSE HTTP 500')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream('event: error\ndata: {"message":"服务忙"}\n\n'))))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).rejects.toThrow('分析失败：服务忙')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream('event: stage\ndata: {}\n\n'))))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).rejects.toThrow('适配器 SSE 流结束但未收到 result')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream('event: error\ndata: 原始错误\n\n'))))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).rejects.toThrow('分析失败：原始错误')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream('event: result\ndata: {坏}\n\nevent: done\ndata: {}\n\n'))))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).rejects.toThrow('适配器 SSE 流结束但未收到 result')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream('event: stage\n\nevent: heartbeat\n\nevent: result\n\nevent: done\n\n'))))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).resolves.toEqual({})

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream('event: error\n\n'))))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).rejects.toThrow('分析失败：未知错误')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream('event: stage\ndata: {"message":"静默进度"}\n\nevent: result\ndata: {}\n\n'))))
    await expect(consumeSse(`${BASE}/stream`, sink, 1_000)).resolves.toEqual({})
  })
})
