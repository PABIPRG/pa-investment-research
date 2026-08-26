import { describe, expect, it, vi } from 'vitest'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import {
  buildInvestmentAssistantRequest,
  formatInvestmentAssistantDraft,
} from '../src/client/assistant-context.ts'

describe('investment assistant context', () => {
  it('uses compact overall facts for a generic floating-assistant conversation', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => ({ operation: request.operation }))
    const request = await buildInvestmentAssistantRequest(requestData, 'strategy', '', '')

    expect(request).toMatchObject({
      intent: 'overall.research',
      context: {
        scope: 'overall',
        module: 'overall',
        moduleLabel: '整体投研',
        currentRoute: 'strategy',
      },
    })
    expect(request.context.overallData).toEqual({
      marketOverview: { operation: 'market-watch.overview' },
      holdings: { operation: 'trading-core.holdings' },
      watchlist: { operation: 'market-watch.watchlist' },
      riskProfile: { operation: 'trading-core.risk-profile' },
    })
  })

  it('combines page-resolved module data, backend facts, and overall facts', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => ({ operation: request.operation }))
    const request = await buildInvestmentAssistantRequest(requestData, 'chain', '', {
      intent: 'industry-chain.interpret',
      question: '解读中芯国际 688981 的上下游风险',
      module: 'chain',
      data: { selectedCompany: { code: '688981', name: '中芯国际' }, visibleNodes: ['晶圆制造'] },
    })

    expect(request.context).toMatchObject({
      scope: 'module',
      module: 'chain',
      moduleData: {
        pageSnapshot: { selectedCompany: { code: '688981', name: '中芯国际' }, visibleNodes: ['晶圆制造'] },
        backendSnapshot: {
          stats: { operation: 'industry-chain.stats' },
          company: { operation: 'industry-chain.company' },
          chain: { operation: 'industry-chain.chain' },
        },
      },
    })
    expect(requestData).toHaveBeenCalledWith({ operation: 'industry-chain.company', input: { code: '688981' } })
  })

  it('routes an explicitly mentioned module and retains partial data when one dependency fails', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'market-watch.news-events') throw new Error('offline')
      return { operation: request.operation }
    })
    const request = await buildInvestmentAssistantRequest(
      requestData,
      'dashboard',
      '',
      '请结合策略研究模块判断候选策略的证据是否充分',
    )

    expect(request.context.module).toBe('strategy')
    expect(request.context.moduleData.backendSnapshot).toHaveProperty('strategies')
    expect(request.context.unavailable).toEqual(['events（market-watch.news-events）'])
  })

  it('serializes only business context for the shared text composer transport', () => {
    const draft = formatInvestmentAssistantDraft({
      intent: 'portfolio.risk',
      question: '判断组合风险',
      context: {
        schema: 'investment-research-context/v1',
        scope: 'module',
        module: 'portfolio',
        moduleLabel: '我的投研',
        currentRoute: 'portfolio',
        overallData: {},
        moduleData: { pageSnapshot: { holdings: [{ code: '600519', weight: 0.2 }] }, backendSnapshot: {} },
        unavailable: [],
      },
    })

    expect(draft).toContain('"schema": "investment-research-context/v1"')
    expect(draft).toContain('"holdings"')
    expect(draft).toContain('不要分析代码、接口实现、文件或工程结构')
  })
})
