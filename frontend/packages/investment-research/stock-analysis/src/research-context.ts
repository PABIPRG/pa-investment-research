import { getResearchChatContext, getStrategyDetail } from './client.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session'

type JsonObject = { readonly [key: string]: JsonValue }

export type ResearchContextStatus = 'ready' | 'empty' | 'invalid' | 'unavailable'
export type ResearchContextCompatibility = 'not_applicable' | 'direct' | 'method_only'
export type ResearchContextWarningCode =
  | 'STRATEGY_NOT_RECOMMENDED'
  | 'STRATEGY_NOT_FOUND'
  | 'METHOD_TRANSFER'
  | 'CONTEXT_UNAVAILABLE'

export interface ResearchContextInstrument {
  readonly [key: string]: JsonValue
  code: string
  name: string
  market: string
  type: 'stock' | 'etf'
}

export interface ResearchContextWarning {
  readonly [key: string]: JsonValue
  code: ResearchContextWarningCode
  message: string
}

export interface InvestmentResearchContextResult {
  status: ResearchContextStatus
  context_revision?: number
  context_updated_at?: string
  strategy?: JsonObject
  instrument?: ResearchContextInstrument
  recommended: boolean
  compatibility: ResearchContextCompatibility
  warnings: ResearchContextWarning[]
}

export const INVESTMENT_RESEARCH_CONTEXT_PROMPT =
  '当用户询问具体策略、具体证券，或使用“当前策略”“这个标的”“选中的”等指代时，' +
  '先调用 investment_research_context 读取本会话在“我的投研”输入框下方确认的策略与标的。' +
  '必须披露工具返回的风险提示；status 为 empty 或 unavailable 时不得猜测策略或标的，需请用户选择或重试。' +
  '标的为 ETF 时只使用行情、技术信号和相关新闻研究，不调用或虚构单一公司的基本面结论。' +
  '策略、行情和新闻均按工具实际返回的新鲜度表达，不得把数据失败写成无风险。' +
  '不得把聊天解读为执行交易、激活、淘汰、修改或验证策略的授权。'

interface PersistedResearchContext {
  strategy_id?: string | null
  instrument?: ResearchContextInstrument | null
  revision?: number
  updated_at?: string
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function parseInstrument(value: JsonValue | undefined): ResearchContextInstrument | null {
  if (value === null) return null
  const item = record(value)
  if (item === undefined
    || typeof item.code !== 'string' || !/^\d{6}$/u.test(item.code)
    || typeof item.name !== 'string' || item.name.trim() === ''
    || typeof item.market !== 'string' || item.market.trim() === ''
    || (item.type !== 'stock' && item.type !== 'etf')) {
    throw new TypeError('投研会话标的响应无效')
  }
  return { code: item.code, name: item.name, market: item.market, type: item.type }
}

function parseContextEnvelope(value: unknown, expectedSessionId: string): PersistedResearchContext | null {
  const envelope = record(value)
  if (envelope?.exists === false && envelope.context === null) return null
  if (envelope?.exists !== true) throw new TypeError('投研会话上下文响应无效')
  const item = record(envelope.context)
  if (item === undefined
    || item.schema_version !== 1
    || item.session_id !== expectedSessionId
    || !(item.strategy_id === null || typeof item.strategy_id === 'string')
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1
    || typeof item.updated_at !== 'string' || item.updated_at.trim() === '') {
    throw new TypeError('投研会话上下文记录无效')
  }
  return {
    strategy_id: item.strategy_id as string | null,
    instrument: parseInstrument(item.instrument),
    revision: Number(item.revision),
    updated_at: item.updated_at,
  }
}

function parseStrategyDetail(value: unknown, expectedStrategyId: string): JsonObject {
  const strategy = record(value)
  if (strategy === undefined
    || strategy.id !== expectedStrategyId
    || typeof strategy.status !== 'string'
    || typeof strategy.verification_status !== 'string') {
    throw new TypeError('策略详情响应无效')
  }
  return strategy
}

function strategyCodes(strategy: JsonObject): Set<string> {
  const result = new Set<string>()
  if (Array.isArray(strategy.symbols)) {
    for (const symbol of strategy.symbols) if (typeof symbol === 'string') result.add(symbol)
  }
  if (Array.isArray(strategy.tickers)) {
    for (const ticker of strategy.tickers) {
      const code = record(ticker)?.code
      if (typeof code === 'string') result.add(code)
    }
  }
  return result
}

function contextFields(context: PersistedResearchContext, instrument?: ResearchContextInstrument) {
  return {
    ...(typeof context.revision === 'number' ? { context_revision: context.revision } : {}),
    ...(typeof context.updated_at === 'string' ? { context_updated_at: context.updated_at } : {}),
    ...(instrument === undefined ? {} : { instrument }),
  }
}

/** Project persisted selection and current strategy facts without performing I/O. */
export function resolveResearchContext(input: {
  context: PersistedResearchContext
  strategy?: JsonObject
}): InvestmentResearchContextResult {
  const { context, strategy } = input
  const instrument = record(context.instrument) as unknown as ResearchContextInstrument | undefined
  const recommended = strategy?.status === 'active' && strategy.verification_status === 'passed'
  const compatibility: ResearchContextCompatibility = strategy === undefined || instrument === undefined
    ? 'not_applicable'
    : strategyCodes(strategy).has(instrument.code) ? 'direct' : 'method_only'
  const warnings: ResearchContextWarning[] = []
  if (strategy !== undefined && !recommended) {
    warnings.push({
      code: 'STRATEGY_NOT_RECOMMENDED',
      message: `当前策略状态为 ${String(strategy.status ?? '未知')}，验证状态为 ${String(strategy.verification_status ?? '未知')}；可以讨论，但不属于推荐策略。`,
    })
  }
  if (compatibility === 'method_only') {
    warnings.push({
      code: 'METHOD_TRANSFER',
      message: '该策略未直接覆盖当前标的，只能迁移研究方法，不能把策略历史表现直接套用到该标的。',
    })
  }
  return {
    status: 'ready',
    ...contextFields(context, instrument),
    ...(strategy === undefined ? {} : { strategy }),
    recommended,
    compatibility,
    warnings,
  }
}

/** Read and project the model-safe view of the current conversation's confirmed selection. */
export async function resolveInvestmentResearchContext(
  baseUrl: string,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<InvestmentResearchContextResult> {
  if (sessionId === undefined) {
    return {
      status: 'unavailable',
      recommended: false,
      compatibility: 'not_applicable',
      warnings: [{ code: 'CONTEXT_UNAVAILABLE', message: '当前工具执行没有可信的会话标识，无法读取投研选择。' }],
    }
  }

  try {
    const context = parseContextEnvelope(
      await getResearchChatContext(baseUrl, sessionId, signal), sessionId,
    )
    if (context === null) {
      return { status: 'empty', recommended: false, compatibility: 'not_applicable', warnings: [] }
    }
    if (context.strategy_id === null && context.instrument === null) {
      return {
        status: 'empty',
        ...contextFields(context),
        recommended: false,
        compatibility: 'not_applicable',
        warnings: [],
      }
    }

    const instrument = record(context.instrument) as unknown as ResearchContextInstrument | undefined
    const strategyId = typeof context.strategy_id === 'string' ? context.strategy_id : undefined
    let strategy: JsonObject | undefined
    if (strategyId !== undefined) {
      try {
        strategy = parseStrategyDetail(
          await getStrategyDetail(baseUrl, strategyId, signal), strategyId,
        )
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('适配器 HTTP 404:')) {
          return {
            status: 'invalid',
            ...contextFields(context, instrument),
            recommended: false,
            compatibility: 'not_applicable',
            warnings: [{
              code: 'STRATEGY_NOT_FOUND',
              message: '已选择的策略已不存在，请在输入框下方重新选择。',
            }],
          }
        }
        throw error
      }
    }
    return resolveResearchContext({ context, ...(strategy === undefined ? {} : { strategy }) })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return {
      status: 'unavailable',
      recommended: false,
      compatibility: 'not_applicable',
      warnings: [{ code: 'CONTEXT_UNAVAILABLE', message: '暂时无法读取当前会话的投研选择，请稍后重试。' }],
    }
  }
}

export function renderInvestmentResearchContext(value: InvestmentResearchContextResult): string {
  if (value.status === 'empty') return '当前会话尚未选择策略或投资标的。'
  if (value.status === 'invalid') return '当前会话选择的策略已失效，请重新选择。'
  if (value.status === 'unavailable') return '当前会话投研上下文暂时不可用。'
  const strategyName = typeof value.strategy?.name === 'string' ? value.strategy.name : '未选策略'
  const target = value.instrument === undefined ? '未选标的' : `${value.instrument.name}（${value.instrument.code}）`
  return `当前会话：${strategyName} · ${target}；适用性：${value.compatibility}。`
}
