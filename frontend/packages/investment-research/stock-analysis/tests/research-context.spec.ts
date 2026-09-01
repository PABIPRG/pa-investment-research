import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INVESTMENT_RESEARCH_CONTEXT_PROMPT,
  resolveInvestmentResearchContext,
} from '../src/research-context.ts'

afterEach(() => vi.unstubAllGlobals())

function selectedContext(strategyId = 'strategy-1') {
  return {
    exists: true,
    context: {
      schema_version: 1,
      session_id: 'session-1',
      strategy_id: strategyId,
      instrument: { code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' },
      revision: 4,
      updated_at: '2026-09-01T03:00:00Z',
    },
  }
}

describe('current investment-research context projection', () => {
  it('locks ETF routing, empty-state truthfulness, freshness, and read-only boundaries in the prompt', () => {
    expect(INVESTMENT_RESEARCH_CONTEXT_PROMPT).toContain('empty 或 unavailable')
    expect(INVESTMENT_RESEARCH_CONTEXT_PROMPT).toContain('ETF')
    expect(INVESTMENT_RESEARCH_CONTEXT_PROMPT).toContain('不调用或虚构单一公司的基本面结论')
    expect(INVESTMENT_RESEARCH_CONTEXT_PROMPT).toContain('新鲜度')
    expect(INVESTMENT_RESEARCH_CONTEXT_PROMPT).toContain('不得把聊天解读为执行交易')
  })
  it('warns when a non-recommended strategy is transferred to an uncovered target', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/research-chat/contexts/session-1')) {
        return new Response(JSON.stringify(selectedContext()))
      }
      return new Response(JSON.stringify({
        id: 'strategy-1', name: '事件反转', status: 'candidate', verification_status: 'pending',
        symbols: ['600519'],
      }))
    }))

    await expect(resolveInvestmentResearchContext(
      'http://adapter.test', 'session-1', new AbortController().signal,
    )).resolves.toMatchObject({
      status: 'ready',
      recommended: false,
      compatibility: 'method_only',
      warnings: [
        { code: 'STRATEGY_NOT_RECOMMENDED' },
        { code: 'METHOD_TRANSFER' },
      ],
    })
  })

  it('marks a deleted strategy invalid while retaining the confirmed target', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/research-chat/contexts/session-1')) {
        return new Response(JSON.stringify(selectedContext('deleted-strategy')))
      }
      return new Response('{"detail":"策略不存在"}', { status: 404 })
    }))

    await expect(resolveInvestmentResearchContext(
      'http://adapter.test', 'session-1', new AbortController().signal,
    )).resolves.toEqual({
      status: 'invalid',
      context_revision: 4,
      context_updated_at: '2026-09-01T03:00:00Z',
      instrument: { code: '510300', name: '沪深300ETF', market: '沪市', type: 'etf' },
      recommended: false,
      compatibility: 'not_applicable',
      warnings: [{ code: 'STRATEGY_NOT_FOUND', message: '已选择的策略已不存在，请在输入框下方重新选择。' }],
    })
  })

  it('returns an explicit empty value without reading strategy details', async () => {
    const fetch = vi.fn(async () => new Response('{"exists":false,"context":null}'))
    vi.stubGlobal('fetch', fetch)

    await expect(resolveInvestmentResearchContext(
      'http://adapter.test', 'session-1', new AbortController().signal,
    )).resolves.toEqual({
      status: 'empty', recommended: false, compatibility: 'not_applicable', warnings: [],
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong session', { ...selectedContext(), context: { ...selectedContext().context, session_id: 'session-other' } }],
    ['invalid revision', { ...selectedContext(), context: { ...selectedContext().context, revision: -1 } }],
    ['invalid instrument', { ...selectedContext(), context: { ...selectedContext().context, instrument: { code: 'BTC', name: 'Bitcoin', market: 'crypto', type: 'crypto' } } }],
  ])('rejects malformed or cross-session context responses: %s', async (_label, response) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)))
    vi.stubGlobal('fetch', fetch)

    await expect(resolveInvestmentResearchContext(
      'http://adapter.test', 'session-1', new AbortController().signal,
    )).resolves.toMatchObject({
      status: 'unavailable',
      warnings: [{ code: 'CONTEXT_UNAVAILABLE' }],
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed or mismatched strategy detail response', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/research-chat/contexts/session-1')
        ? selectedContext()
        : { id: 'strategy-other', status: 'active', verification_status: 'passed' },
    )))
    vi.stubGlobal('fetch', fetch)

    await expect(resolveInvestmentResearchContext(
      'http://adapter.test', 'session-1', new AbortController().signal,
    )).resolves.toMatchObject({
      status: 'unavailable', warnings: [{ code: 'CONTEXT_UNAVAILABLE' }],
    })
  })
})
