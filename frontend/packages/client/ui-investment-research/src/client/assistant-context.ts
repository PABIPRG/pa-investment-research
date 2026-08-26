import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { InvestmentRoute } from './state.ts'

export type InvestmentAssistantModule = 'overall' | Exclude<InvestmentRoute, 'assistant'>

/** One business action that opens a fresh research-assistant conversation. */
export type InvestmentAssistantActionInput = string | Readonly<{
  /** Stable business intent, for example `industry-chain.interpret`. */
  intent: string
  /** The user's business question, when it differs from the intent. */
  question?: string
  /** Explicit module override for cross-module actions. */
  module?: InvestmentAssistantModule
  /** JSON-safe data already resolved by the page at click time. */
  data?: unknown
}>

export interface InvestmentAssistantContext {
  readonly schema: 'investment-research-context/v1'
  readonly scope: 'overall' | 'module'
  readonly module: InvestmentAssistantModule
  readonly moduleLabel: string
  readonly currentRoute: InvestmentRoute
  readonly overallData: Readonly<Record<string, unknown>>
  readonly moduleData: Readonly<{
    pageSnapshot?: unknown
    backendSnapshot: Readonly<Record<string, unknown>>
  }>
  readonly unavailable: readonly string[]
}

/** Structured handoff from the investment workbench to one fresh Session. */
export interface InvestmentAssistantRequest {
  readonly intent: string
  readonly question?: string
  readonly context: InvestmentAssistantContext
}

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

const MODULE_LABELS: Record<InvestmentAssistantModule, string> = {
  overall: '整体投研',
  dashboard: '研究工作台',
  analysis: '智能分析',
  watch: '实时盯盘',
  strategy: '策略研究',
  shadow: '影子验证',
  evolution: '自进化',
  'stock-detail': '个股详情',
  portfolio: '我的投研',
  chain: '产业链',
}

const MODULE_MENTIONS: readonly [InvestmentAssistantModule, readonly string[]][] = [
  ['chain', ['产业链', '上下游图谱', '供应链图谱']],
  ['evolution', ['自进化', '策略进化']],
  ['shadow', ['影子验证', '影子记账']],
  ['strategy', ['策略研究', '候选策略', '投资假设']],
  ['stock-detail', ['个股详情', '证券详情']],
  ['portfolio', ['我的投研', '个人投研']],
  ['watch', ['实时盯盘', '异动扫描']],
  ['analysis', ['智能分析', '多智能体分析']],
  ['dashboard', ['研究工作台', '工作台']],
]

const OVERALL_REQUESTS: readonly [string, InvestmentDataRequest][] = [
  ['marketOverview', { operation: 'market-watch.overview' }],
  ['holdings', { operation: 'trading-core.holdings' }],
  ['watchlist', { operation: 'market-watch.watchlist' }],
  ['riskProfile', { operation: 'trading-core.risk-profile' }],
]

function moduleRequests(module: InvestmentAssistantModule, stockCode: string): readonly [string, InvestmentDataRequest][] {
  switch (module) {
    case 'overall': return []
    case 'dashboard': return [
      ['riskAlerts', { operation: 'trading-core.risk-alerts' }],
      ['personalizedMatches', { operation: 'trading-core.personalized-matches' }],
      ['personalizedCards', { operation: 'trading-core.personalized-cards', input: { limit: 12, bucket: 'all', match: true, comment: true } }],
    ]
    case 'analysis': return [
      ['portfolioRisk', { operation: 'trading-core.risk-portfolio' }],
      ['strategies', { operation: 'trading-core.strategies', input: { limit: 100 } }],
    ]
    case 'watch': return [
      ['alerts', { operation: 'market-watch.alerts' }],
      ['events', { operation: 'market-watch.news-events', input: { limit: 20 } }],
    ]
    case 'strategy': return [
      ['strategies', { operation: 'trading-core.strategies', input: { limit: 100 } }],
      ['events', { operation: 'market-watch.news-events', input: { limit: 20 } }],
      ['personalizedMatches', { operation: 'trading-core.personalized-matches' }],
    ]
    case 'shadow': return [
      ['status', { operation: 'trading-core.shadow-status' }],
      ['positions', { operation: 'trading-core.shadow-positions' }],
      ['equity', { operation: 'trading-core.shadow-equity', input: { limit: 120 } }],
    ]
    case 'evolution': return [
      ['status', { operation: 'trading-core.evolution-status' }],
      ['attribution', { operation: 'trading-core.evolution-attribution' }],
      ['strategies', { operation: 'trading-core.strategies', input: { limit: 100 } }],
    ]
    case 'portfolio': return [
      ['kycProfile', { operation: 'trading-core.kyc-profile' }],
      ['personalizedProfile', { operation: 'trading-core.personalized-profile' }],
      ['portfolioRisk', { operation: 'trading-core.risk-portfolio' }],
    ]
    case 'chain': return stockCode === ''
      ? [['stats', { operation: 'industry-chain.stats' }]]
      : [
        ['stats', { operation: 'industry-chain.stats' }],
        ['company', { operation: 'industry-chain.company', input: { code: stockCode } }],
        ['chain', { operation: 'industry-chain.chain', input: { code: stockCode, depth_up: 2, depth_down: 2, top_up: 3, top_down: 2 } }],
      ]
    case 'stock-detail': return stockCode === '' ? [] : [
      ['security', { operation: 'market-watch.security-detail', input: { code: stockCode, lookback: 120 } }],
    ]
  }
}

function actionText(input: InvestmentAssistantActionInput): string {
  return typeof input === 'string' ? input.trim() : `${input.intent}\n${input.question ?? ''}`.trim()
}

function mentionedModule(text: string): InvestmentAssistantModule | undefined {
  return MODULE_MENTIONS.find(([, aliases]) => aliases.some(alias => text.includes(alias)))?.[0]
}

function firstStockCode(text: string): string {
  return text.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1] ?? ''
}

function resolveModule(currentRoute: InvestmentRoute, input: InvestmentAssistantActionInput): InvestmentAssistantModule {
  if (typeof input !== 'string' && input.module !== undefined) return input.module
  const content = actionText(input)
  const explicit = mentionedModule(content)
  if (explicit !== undefined) return explicit
  if (content === '' || currentRoute === 'assistant') return 'overall'
  return currentRoute
}

async function loadSnapshot(
  requestData: RequestData,
  requests: readonly [string, InvestmentDataRequest][],
): Promise<Readonly<{ data: Readonly<Record<string, unknown>>; unavailable: readonly string[] }>> {
  const unique = [...new Map(requests.map(item => [JSON.stringify(item[1]), item])).values()]
  const settled = await Promise.allSettled(unique.map(async ([key, request]) => [key, await requestData(request)] as const))
  const data: Record<string, unknown> = {}
  const unavailable: string[] = []
  settled.forEach((result, index) => {
    const entry = unique[index]
    if (entry === undefined) return
    const [key, request] = entry
    if (result.status === 'fulfilled') data[result.value[0]] = result.value[1]
    else unavailable.push(`${key}（${request.operation}）`)
  })
  return { data, unavailable }
}

/** Resolve page-owned and backend-owned business facts into one model handoff. */
export async function buildInvestmentAssistantRequest(
  requestData: RequestData,
  currentRoute: InvestmentRoute,
  stockQuery: string,
  input: InvestmentAssistantActionInput,
): Promise<InvestmentAssistantRequest> {
  const module = resolveModule(currentRoute, input)
  const content = actionText(input)
  const stockCode = firstStockCode(`${stockQuery} ${content}`)
  const [overall, moduleSnapshot] = await Promise.all([
    loadSnapshot(requestData, OVERALL_REQUESTS),
    loadSnapshot(requestData, moduleRequests(module, stockCode)),
  ])
  const pageSnapshot = typeof input === 'string' ? undefined : input.data
  const intent = typeof input === 'string' ? (content === '' ? 'overall.research' : 'module.research') : input.intent.trim()
  const question = typeof input === 'string' ? (content === '' ? undefined : content) : input.question?.trim()
  return {
    intent: intent === '' ? 'module.research' : intent,
    ...(question === undefined || question === '' ? {} : { question }),
    context: {
      schema: 'investment-research-context/v1',
      scope: module === 'overall' ? 'overall' : 'module',
      module,
      moduleLabel: MODULE_LABELS[module],
      currentRoute,
      overallData: overall.data,
      moduleData: {
        ...(pageSnapshot === undefined ? {} : { pageSnapshot }),
        backendSnapshot: moduleSnapshot.data,
      },
      unavailable: [...overall.unavailable, ...moduleSnapshot.unavailable],
    },
  }
}

/** Serialize a typed data handoff into the shared conversation composer's text transport. */
export function formatInvestmentAssistantDraft(request: InvestmentAssistantRequest): string {
  return [
    '请仅基于下面的投研业务上下文进行金融研究与风险研判。不要分析代码、接口实现、文件或工程结构；缺失数据请明确说明，不要猜测。',
    JSON.stringify(request, null, 2),
  ].join('\n\n')
}
