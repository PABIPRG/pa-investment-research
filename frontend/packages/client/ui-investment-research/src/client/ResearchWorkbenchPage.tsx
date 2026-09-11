import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { IconDislikeOutline16, IconLikeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantIntent } from './assistant-intent.ts'
import { asRecord, compactMoney, money, number, productErrorText, records, text } from './data.ts'
import { useQuotePolling } from './quote-polling.ts'
import {
  EventReportDialog, RiskDetailDialog, eventPrimaryTicker, riskIntentTarget,
} from './DetailDialogs.tsx'
import {
  WorkbenchOverviewDialog,
} from './WorkbenchOverviewDialog.tsx'
import {
  PortfolioPerformanceDialog,
} from './PortfolioPerformanceDialog.tsx'
import type {
  PerformanceMethod, PerformancePeriod,
} from './PortfolioPerformanceDialog.tsx'
import { KycProfilePanel } from './KycProfilePanel.tsx'
import type {
  WorkbenchDetailKind, WorkbenchHoldingInput, WorkbenchHoldingSaveSource, WorkbenchPositionDetail,
} from './WorkbenchOverviewDialog.tsx'
import type { InvestmentNavigationContext, InvestmentRoute } from './state.ts'
import { useSecurityNames } from './security-names.ts'
import { TASK_CANCELLED, taskId, waitForTask } from './task-client.ts'
import type {
  LocalTelemetryContext, LocalTelemetryEvent, TrackLocalTelemetry,
} from './telemetry.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

type ResourcePhase = 'idle' | 'loading' | 'refreshing' | 'success' | 'error'

interface ResourceState {
  readonly phase: ResourcePhase
  readonly loaded: boolean
  readonly value: unknown
  readonly error: string
  readonly request?: InvestmentDataRequest
}

const EMPTY_RESOURCE: ResourceState = Object.freeze({
  phase: 'idle', loaded: false, value: undefined, error: '',
})

/** Keep each dashboard region independently refreshable and retain same-key data. */
function useWorkbenchResource(requestData: RequestData) {
  const [state, setState] = useState<ResourceState>(EMPTY_RESOURCE)
  const generation = useRef(0)
  const settledKey = useRef('')
  const flights = useRef(new Map<string, Promise<unknown>>())

  useEffect(() => () => { generation.current += 1 }, [])

  const run = useCallback((
    request: InvestmentDataRequest,
    options?: {
      readonly trailing?: boolean
      readonly fresh?: boolean
      readonly retainPrevious?: boolean
    },
  ): void => {
    const key = JSON.stringify(request)
    const current = ++generation.current
    setState(previous => {
      const retain = previous.loaded && (
        settledKey.current === key || options?.retainPrevious === true
      )
      return {
        phase: retain ? 'refreshing' : 'loading',
        loaded: retain,
        value: retain ? previous.value : undefined,
        error: '',
        request,
      }
    })
    let flight = options?.fresh === true ? undefined : flights.current.get(key)
    if (flight === undefined || options?.trailing === true) {
      const previous = flight
      flight = previous === undefined
        ? Promise.resolve().then(() => requestData(request))
        : previous.catch(() => undefined).then(() => requestData(request))
      flights.current.set(key, flight)
      const release = (): void => {
        if (flights.current.get(key) === flight) flights.current.delete(key)
      }
      void flight.then(release, release)
    }
    void flight.then((value) => {
      if (current !== generation.current) return
      settledKey.current = key
      setState({ phase: 'success', loaded: true, value, error: '', request })
    }, (reason: unknown) => {
      if (current !== generation.current) return
      setState(previous => ({ ...previous, phase: 'error', error: productErrorText(reason) }))
    })
  }, [requestData])

  return {
    state,
    busy: state.phase === 'loading' || state.phase === 'refreshing',
    run,
  }
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
}

function displayTime(value: unknown): string {
  const raw = text(value, '')
  if (raw === '') return '时间未知'
  const parsed = new Date(raw.replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(parsed)
}

function costAmount(positions: readonly Record<string, unknown>[]): number {
  return positions.reduce((sum, item) => (
    sum + (number(item.quantity) ?? 0) * (number(item.cost_price) ?? 0)
  ), 0)
}

function completeCostAmount(positions: readonly Record<string, unknown>[]): number | undefined {
  if (positions.length === 0) return undefined
  let sum = 0
  for (const item of positions) {
    const quantity = number(item.quantity)
    const costPrice = number(item.cost_price)
    if (quantity === undefined || costPrice === undefined) return undefined
    sum += quantity * costPrice
  }
  return sum
}

function signedCompactMoney(value: number | undefined): string {
  if (value === undefined) return '—'
  const normalized = Object.is(value, -0) ? 0 : value
  if (normalized === 0) return compactMoney(0)
  return `${normalized > 0 ? '+' : '-'}${compactMoney(Math.abs(normalized))}`
}

function signedReturn(value: number | undefined): string {
  if (value === undefined) return '—'
  const normalized = Object.is(value, -0) ? 0 : value
  return `${normalized > 0 ? '+' : ''}${(normalized * 100).toFixed(2)}%`
}

function localDate(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function performanceRange(period: PerformancePeriod): { start_date: string; end_date: string } | undefined {
  if (period === 'since_inception' || period === 'custom') return undefined
  const end = new Date()
  const start = new Date(end)
  if (period === '7d') start.setDate(start.getDate() - 6)
  if (period === '15d') start.setDate(start.getDate() - 14)
  if (period === '30d') start.setDate(start.getDate() - 29)
  if (period === '6m') start.setMonth(start.getMonth() - 6)
  if (period === '1y') start.setFullYear(start.getFullYear() - 1)
  return { start_date: localDate(start), end_date: localDate(end) }
}

const BUCKET_LABELS: Readonly<Record<string, string>> = Object.freeze({
  all: '全部', holdings: '持仓', watchlist: '自选', strategy: '策略', fresh: '市场',
})

const EVENT_PAGE_SIZE = 10
const EVENT_VIEW_LABELS = Object.freeze({
  all: '全部',
  position_risk: '持仓风险',
  radar_opportunity: '雷达机会点',
  neutral_event: '中性事件',
})

type EventView = keyof typeof EVENT_VIEW_LABELS
type EventBusinessView = Exclude<EventView, 'all'>

interface EventFeed {
  readonly cards: readonly Record<string, unknown>[]
  readonly total: number
  readonly hasMore: boolean
  readonly nextOffset: number
  readonly asOf: string
}

const EMPTY_EVENT_CARDS: readonly Record<string, unknown>[] = Object.freeze([])

function eventBusinessView(card: Record<string, unknown>): EventBusinessView {
  const returned = text(card.business_view, '')
  if (returned !== 'all' && returned in EVENT_VIEW_LABELS) return returned as EventBusinessView
  const direction = text(card.direction, '中性')
  const matchedHoldings = Array.isArray(asRecord(card.matched).holdings)
    ? asRecord(card.matched).holdings as readonly unknown[]
    : []
  if (direction !== '利好' && direction !== '利空') return 'neutral_event'
  return direction === '利空' && matchedHoldings.length > 0 ? 'position_risk' : 'radar_opportunity'
}

// 事件类型徽标（与后端 events.TYPE_EMOJI 的中文事件名对齐；仅前端展示用）。
// 大盘趋势事件（政策/宏观）即使未命中具体标的也会进入主列表，靠此徽标与命中卡区分。
const EVENT_TYPE_BADGE: Readonly<Record<string, string>> = Object.freeze({
  公告: '📋 公告', 业绩: '📈 业绩', 价格异动: '💰 价格异动', 政策: '🏛 政策',
  产业: '🏭 产业', 合作: '🤝 合作', 评级: '⭐ 评级', 宏观: '🌐 宏观', 相关: '🔗 相关',
})

function tickerFromCard(card: Record<string, unknown>): { code: string; name: string } | undefined {
  const tickers: readonly unknown[] = Array.isArray(card.tickers) ? card.tickers : []
  const first = tickers[0]
  if (typeof first === 'string') {
    const code = first.trim()
    return code === '' ? undefined : { code, name: '' }
  }
  const ticker = asRecord(first)
  const code = text(ticker.code, '').trim()
  return code === '' ? undefined : { code, name: text(ticker.name, '') }
}

function strategyFromCard(card: Record<string, unknown>): string {
  const matched = asRecord(card.matched)
  const first = records(matched.strategies)[0]
  return first === undefined ? '' : text(first.id, '')
}

function strategySymbols(item: Record<string, unknown>): string[] {
  const symbols = stringItems(item.symbols).map(value => value.trim()).filter(Boolean)
  if (symbols.length > 0) return [...new Set(symbols)]
  const inferred = text(item.name, '').match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1]
  return inferred === undefined ? [] : [inferred]
}

function holdingReasonCode(value: string): string | undefined {
  return value.match(/^命中持仓[：:]\s*(\d{6})(?:\s|$)/)?.[1]
}

function comparableCopy(value: string): string {
  return value.replace(/\s+/g, '').replace(/[。！？!?；;，,：:]+$/g, '')
}

function resolvedSecurityName(
  item: Record<string, unknown>,
  code: string,
  securityNames: Readonly<Record<string, string>>,
): string {
  const stored = text(item.name, '').trim()
  const resolved = securityNames[code]?.trim() ?? ''
  return stored !== '' && stored !== code ? stored : resolved !== '' ? resolved : code
}

function strategyDisplayName(item: Record<string, unknown>, securityNames: Readonly<Record<string, string>>): string {
  const symbols = strategySymbols(item)
  if (symbols.length === 0) return text(item.name, '未命名策略')
  const labels = symbols.slice(0, 2).map((code) => {
    const name = securityNames[code]?.trim() ?? ''
    return name === '' || name === code ? code : `${name} · ${code}`
  })
  return labels.join('、') + (symbols.length > 2 ? `等${symbols.length}只` : '')
}

function eventTelemetryContext(card: Record<string, unknown>): LocalTelemetryContext {
  const ticker = tickerFromCard(card)
  const strategyId = strategyFromCard(card)
  const industries = stringItems(card.industries)
  const direction = text(card.direction, '')
  const bucket = text(card.bucket, '')
  const eventType = text(card.type, '')
  return {
    ...(ticker === undefined ? {} : { ticker: ticker.code }),
    ...(industries.length === 0 ? {} : { industries }),
    ...(strategyId === '' ? {} : { strategy_id: strategyId }),
    ...(direction === '' ? {} : { direction }),
    ...(bucket === '' ? {} : { bucket }),
    ...(eventType === '' ? {} : { event_type: eventType }),
  }
}

function riskTelemetryContext(item: Record<string, unknown>): LocalTelemetryContext {
  const codes = stringItems(item.codes)
  const source = text(item.source, '')
  const severity = text(item.severity, '')
  const strategyId = text(item.strategy_id, '')
  return {
    ...(codes[0] === undefined ? {} : { ticker: codes[0] }),
    ...(source === '' ? {} : { risk_source: source }),
    ...(severity === '' ? {} : { risk_severity: severity }),
    ...(strategyId === '' ? {} : { strategy_id: strategyId }),
  }
}

function ImpressionArticle({
  className, impression, trackTelemetry, children,
}: {
  className: string | undefined
  impression: LocalTelemetryEvent
  trackTelemetry: TrackLocalTelemetry
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const impressionRef = useRef(impression)
  impressionRef.current = impression
  useEffect(() => {
    const element = ref.current
    if (element === null || typeof IntersectionObserver === 'undefined') return
    let timer: number | undefined
    const cancel = (): void => {
      if (timer === undefined) return
      window.clearTimeout(timer); timer = undefined
    }
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5)
      if (!visible) { cancel(); return }
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        void trackTelemetry({ ...impressionRef.current, dedupe: 'session' })
      }, 1_000)
    }, { threshold: 0.5 })
    observer.observe(element)
    return () => { cancel(); observer.disconnect() }
  }, [impression.action, impression.surface, impression.targetId, impression.targetType, trackTelemetry])
  return <article ref={ref} className={className}>{children}</article>
}

function PreferenceFeedback({
  cardId, current, meta, requestData, compact = false,
}: {
  cardId: string
  current: string
  meta: LocalTelemetryContext
  requestData: RequestData
  compact?: boolean
}) {
  const [sentiment, setSentiment] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setSentiment(current) }, [current])

  const submit = async (next: 'useful' | 'useless'): Promise<void> => {
    if (busy) return
    const requested = sentiment === next ? 'neutral' : next
    setBusy(true); setError('')
    try {
      const response = asRecord(await requestData({
        operation: 'trading-core.personalized-feedback',
        input: { card_id: cardId, sentiment: requested, meta: { ...meta } },
      }))
      if (response.stored !== true) throw new Error('feedback was not stored')
      setSentiment(requested === 'neutral' ? '' : requested)
    } catch {
      setError('偏好未保存，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${css.preferenceFeedback} ${compact ? css.preferenceFeedbackCompact : ''}`} role="group" aria-label="内容偏好">
      <button type="button" aria-label="值得关注" title="值得关注；再次点击可取消" aria-pressed={sentiment === 'useful'} disabled={busy} onClick={() => { void submit('useful') }}>
        <span className={css.preferenceFeedbackIcon} aria-hidden="true"><IconLikeOutline16 /></span>
        {!compact && '值得关注'}
      </button>
      <button type="button" aria-label="减少此类" title="减少此类；再次点击可取消" aria-pressed={sentiment === 'useless'} disabled={busy} onClick={() => { void submit('useless') }}>
        <span className={css.preferenceFeedbackIcon} aria-hidden="true"><IconDislikeOutline16 /></span>
        {!compact && '减少此类'}
      </button>
      {error !== '' && <small role="alert">{error}</small>}
    </div>
  )
}

function RegionError({
  title, message, retained, retry,
}: { title: string; message: string; retained: boolean; retry: () => void }) {
  return (
    <div className={css.dashboardError} role="alert" data-retained={retained || undefined}>
      <div><strong>{title}</strong><p>{message}</p></div>
      <button type="button" onClick={retry}>重试</button>
    </div>
  )
}

function RegionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className={css.loadingSkeleton} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <span key={index} />)}
    </div>
  )
}

function RegionMeta({ state, settled }: { state: ResourceState; settled: string }) {
  const label = state.phase === 'loading'
    ? '加载中…'
    : state.phase === 'refreshing'
      ? `更新中 · ${settled}`
      : state.phase === 'error' && state.loaded
        ? `保留上次数据 · ${settled}`
        : settled
  return <span className={css.dashboardRegionMeta}>{label}</span>
}

interface ResearchWorkbenchPageProps {
  readonly requestData: RequestData
  readonly brokerSync?: boolean
  readonly holdingsProviders?: readonly string[]
  readonly navigate: (route: InvestmentRoute, context?: InvestmentNavigationContext) => void
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onOpenPreferences: () => void
  readonly onOpenReports: () => void
  readonly trackTelemetry: TrackLocalTelemetry
}

/** Default product landing page: one real-data overview, not another chat surface. */
export function ResearchWorkbenchPage({
  requestData, brokerSync = true, holdingsProviders = ['manual', 'easytrader', 'mac_ths', 'qmt'],
  navigate, onAnalyze, onOpenPreferences, onOpenReports, trackTelemetry,
}: ResearchWorkbenchPageProps) {
  const holdings = useWorkbenchResource(requestData)
  const risk = useWorkbenchResource(requestData)
  const alerts = useWorkbenchResource(requestData)
  const kyc = useWorkbenchResource(requestData)
  const cards = useWorkbenchResource(requestData)
  const matches = useWorkbenchResource(requestData)
  const quotes = useWorkbenchResource(requestData)
  const performance = useWorkbenchResource(requestData)
  const alive = useRef(true)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [eventView, setEventView] = useState<EventView>('all')
  const [eventOffset, setEventOffset] = useState(0)
  const [eventFeeds, setEventFeeds] = useState<Partial<Record<EventView, EventFeed>>>({})
  const [eventCounts, setEventCounts] = useState<Readonly<Record<string, number>>>({})
  const [lastEventAsOf, setLastEventAsOf] = useState('')
  const eventListRef = useRef<HTMLDivElement>(null)
  const eventLoadMoreRef = useRef<HTMLDivElement>(null)
  const attentionListRef = useRef<HTMLDivElement>(null)
  const [attentionEdges, setAttentionEdges] = useState({ top: true, bottom: false })
  const [selectedEvent, setSelectedEvent] = useState<Record<string, unknown>>()
  const [selectedRisk, setSelectedRisk] = useState<Record<string, unknown>>()
  const [riskDetailOrigin, setRiskDetailOrigin] = useState<'panel' | 'overview'>('panel')
  const [selectedOverview, setSelectedOverview] = useState<WorkbenchDetailKind>()
  const [performanceOpen, setPerformanceOpen] = useState(false)
  const [performancePeriod, setPerformancePeriod] = useState<PerformancePeriod>('since_inception')
  const [performanceMethod, setPerformanceMethod] = useState<PerformanceMethod>('twr')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [appliedCustom, setAppliedCustom] = useState<{ start_date: string; end_date: string }>()
  const [customError, setCustomError] = useState('')
  const [brief, setBrief] = useState<{
    phase: 'idle' | 'running' | 'background' | 'done' | 'error'
    message: string
  }>({ phase: 'idle', message: '' })
  const eventFeed = eventFeeds[eventView]
  const eventCards = eventFeed?.cards ?? EMPTY_EVENT_CARDS

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    const options = refreshVersion === 0 ? undefined : { trailing: true }
    holdings.run({ operation: 'trading-core.holdings' }, options)
    risk.run({ operation: 'trading-core.risk-portfolio' }, options)
    alerts.run({ operation: 'trading-core.risk-alerts' }, options)
    kyc.run({ operation: 'trading-core.kyc-profile' }, options)
    matches.run({ operation: 'trading-core.personalized-matches' }, options)
  }, [alerts.run, holdings.run, kyc.run, matches.run, refreshVersion, risk.run])

  useEffect(() => {
    cards.run({
      operation: 'trading-core.personalized-cards',
      input: {
        limit: EVENT_PAGE_SIZE, offset: eventOffset, bucket: 'all', business_view: eventView,
        match: true, comment: false,
      },
    }, refreshVersion === 0 ? undefined : { trailing: true })
  }, [cards.run, eventOffset, eventView, refreshVersion])

  const positions = records(asRecord(holdings.state.value).items)
  useQuotePolling(quotes, holdings.state.value, refreshVersion)

  const quoteItems = records(asRecord(quotes.state.value).items)
  const quoteMap = new Map(quoteItems.map(item => [text(item.code, ''), item] as const))
  const totalCurrent = (() => {
    if (positions.length === 0) return undefined
    let sum = 0
    for (const item of positions) {
      const quantity = number(item.quantity)
      const price = number(asRecord(quoteMap.get(text(item.ticker, ''))).price)
      if (quantity === undefined || price === undefined) return undefined
      sum += quantity * price
    }
    return sum
  })()
  const totalCost = completeCostAmount(positions)
  const currentProfit = totalCurrent === undefined || totalCost === undefined ? undefined : totalCurrent - totalCost
  const currentCostReturn = currentProfit === undefined || totalCost === undefined || totalCost === 0
    ? undefined
    : currentProfit / totalCost
  const riskValue = asRecord(risk.state.value)
  const riskSummary = asRecord(riskValue.summary)
  const alertValue = asRecord(alerts.state.value)
  const alertItems = records(alertValue.items)
  const strategyValue = asRecord(matches.state.value)
  const strategyItems = records(strategyValue.items)
  const missingHoldingCodes = positions
    .filter((item) => {
      const code = text(item.ticker, '')
      const name = text(item.name, '').trim()
      return name === '' || name === code
    })
    .map(item => text(item.ticker, ''))
  const knownCardCodes = new Set(eventCards.flatMap(card => records(card.tickers))
    .filter((item) => {
      const code = text(item.code, '')
      const name = text(item.name, '').trim()
      return code !== '' && name !== '' && name !== code
    })
    .map(item => text(item.code, '')))
  const reasonCodes = eventCards.flatMap(card => stringItems(card.reasons)
    .map(holdingReasonCode)
    .filter((code): code is string => code !== undefined))
  const securityNames = useSecurityNames(requestData, [
    ...missingHoldingCodes,
    ...reasonCodes.filter(code => !knownCardCodes.has(code)),
    ...strategyItems.flatMap(strategySymbols),
  ])
  const overviewPositions: WorkbenchPositionDetail[] = positions.map((item) => {
    const code = text(item.ticker, '')
    return {
      code,
      name: resolvedSecurityName(item, code, securityNames),
      quantity: number(item.quantity),
      costPrice: number(item.cost_price),
      currentPrice: number(asRecord(quoteMap.get(code)).price),
    }
  })
  const visibleCards = useMemo(
    () => eventView === 'all' ? eventCards : eventCards.filter(item => eventBusinessView(item) === eventView),
    [eventCards, eventView],
  )
  const eventTotal = eventFeed?.total ?? eventCounts[eventView] ?? eventCards.length
  const hasNextEventPage = eventFeed?.hasMore ?? false
  const nextEventOffset = eventFeed?.nextOffset ?? EVENT_PAGE_SIZE
  const allEventCount = Object.keys(eventCounts).length === 0
    ? undefined
    : eventCounts.all ?? ['position_risk', 'radar_opportunity', 'neutral_event']
      .reduce((sum, key) => sum + (eventCounts[key] ?? 0), 0)
  const actionableAlerts = alertItems.filter(item => (
    text(item.source, '') !== 'profile' && text(item.severity, '低') !== '低'
  ))
  const allBusy = [holdings, risk, alerts, kyc, cards, matches].some(resource => resource.busy)

  const selectedPerformanceRange = useMemo(
    () => performancePeriod === 'custom' ? appliedCustom : performanceRange(performancePeriod),
    [appliedCustom, performancePeriod],
  )

  useEffect(() => {
    if (!performanceOpen || (performancePeriod === 'custom' && selectedPerformanceRange === undefined)) return
    performance.run({
      operation: 'trading-core.portfolio-performance',
      ...(selectedPerformanceRange === undefined ? {} : { input: selectedPerformanceRange }),
    }, { retainPrevious: true })
  }, [performance.run, performanceOpen, performancePeriod, selectedPerformanceRange])

  useEffect(() => {
    if (!cards.state.loaded || cards.state.error !== '') return
    const nextValue = asRecord(cards.state.value)
    const nextPage = asRecord(nextValue.page_info)
    const nextPageCards = records(nextValue.cards)
    const settledInput = asRecord(cards.state.request?.input)
    const settledView = text(settledInput.business_view, '')
    if (!(settledView in EVENT_VIEW_LABELS)) return
    const responseView = settledView as EventView
    const responseOffset = number(settledInput.offset) ?? number(nextPage.offset) ?? 0
    const pageLimit = number(nextPage.limit) ?? EVENT_PAGE_SIZE
    const nextTotal = number(nextPage.total) ?? number(nextValue.total) ?? nextPageCards.length
    const nextAsOf = text(nextValue.as_of, '')
    if (nextAsOf !== '') setLastEventAsOf(nextAsOf)
    const nextCounts = Object.fromEntries(Object.entries(asRecord(nextValue.business_view_counts))
      .flatMap(([key, value]) => {
        const count = number(value)
        return count === undefined ? [] : [[key, count]]
      }))
    if (Object.keys(nextCounts).length > 0) setEventCounts(nextCounts)
    setEventFeeds(current => {
      const currentFeed = current[responseView]
      const currentCards = currentFeed?.cards ?? EMPTY_EVENT_CARDS
      const ids = new Set(currentCards.map((card, index) => text(card.card_id, `existing-${index}`)))
      const mergedCards = responseOffset === 0
        ? nextPageCards
        : [...currentCards, ...nextPageCards.filter((card, index) => !ids.has(text(card.card_id, `page-${responseOffset}-${index}`)))]
      return {
        ...current,
        [responseView]: {
          cards: mergedCards,
          total: nextTotal,
          hasMore: nextPage.has_more === true,
          nextOffset: number(nextPage.next_offset) ?? responseOffset + pageLimit,
          asOf: nextAsOf || currentFeed?.asOf || '',
        },
      }
    })
  }, [cards.state.error, cards.state.loaded, cards.state.request, cards.state.value])

  useEffect(() => {
    const target = eventLoadMoreRef.current
    const root = eventListRef.current
    if (target === null || root === null || !hasNextEventPage || cards.busy || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) setEventOffset(nextEventOffset)
    }, { root, rootMargin: '160px 0px' })
    observer.observe(target)
    return () => { observer.disconnect() }
  }, [cards.busy, eventView, hasNextEventPage, nextEventOffset])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const node = attentionListRef.current
      if (node === null) return
      setAttentionEdges({
        top: node.scrollTop <= 1,
        bottom: node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
      })
    })
    return () => { window.cancelAnimationFrame(frame) }
  }, [actionableAlerts.length])

  const refreshDashboard = useCallback((): void => {
    setEventOffset(0)
    setRefreshVersion(value => value + 1)
  }, [])

  const saveHoldings = useCallback(async (
    next: readonly WorkbenchHoldingInput[], source: WorkbenchHoldingSaveSource,
  ): Promise<void> => {
    await requestData({
      operation: 'trading-core.holdings-save',
      input: { holdings: next.map(item => ({ ...item })), source },
    })
    if (alive.current) refreshDashboard()
  }, [refreshDashboard, requestData])

  const syncHoldings = useCallback(async (token: string): Promise<readonly WorkbenchHoldingInput[]> => {
    const value = asRecord(await requestData({ operation: 'trading-core.holdings-sync', input: { action: 'commit', preview_token: token } }))
    if (typeof value.saved !== 'number') throw new Error(text(value.reason, '持仓保存未完成，请重新读取。'))
    if (alive.current) refreshDashboard()
    const items: WorkbenchHoldingInput[] = []
    for (const row of records(value.items)) {
      const ticker = text(row.ticker, '')
      const quantity = number(row.quantity)
      const costPrice = number(row.cost_price)
      if (ticker === '' || quantity === undefined || costPrice === undefined) continue
      items.push({ ticker, quantity, cost_price: costPrice })
    }
    return items
  }, [refreshDashboard, requestData])

  const startBrief = async (): Promise<void> => {
    if (brief.phase === 'running') return
    const isActive = (): boolean => alive.current
    setBrief({ phase: 'running', message: '正在创建盘前简报任务…' })
    try {
      const started = await requestData({
        operation: 'trading-core.brief-start', input: { period: 'pre_market', scope: 'all' },
      })
      const id = taskId(started)
      if (id === '') throw new Error('后端没有返回任务编号')
      if (!isActive()) return
      setBrief({ phase: 'running', message: `任务 ${id} 已创建，正在等待执行…` })
      const result = await waitForTask(
        requestData,
        id,
        (label) => {
          if (alive.current) setBrief({ phase: 'running', message: `任务 ${id} · ${label}` })
        },
        isActive,
      )
      if (result === TASK_CANCELLED || !isActive()) return
      setBrief({ phase: 'done', message: '盘前简报已生成，可在投研报告中查看。' })
    } catch (reason) {
      if (!alive.current) return
      const message = productErrorText(reason)
      setBrief(message.includes('仍在后台执行')
        ? { phase: 'background', message }
        : { phase: 'error', message })
    }
  }

  const riskAsOf = text(riskValue.as_of, '')
  const alertsAsOf = text(alertValue.as_of, '')
  const cardsAsOf = eventFeed?.asOf ?? lastEventAsOf
  const matchesAsOf = text(strategyValue.as_of, '')

  return (
    <div className={`${css.pageScroll} ${css.primaryRouteSurface}`}>
      <div className={css.pageHeader}>
        <div>
          <h1>研究工作台</h1>
          <p>聚合今天最值得关注的事件、组合风险与下一步研究动作</p>
        </div>
        <div>
          <button type="button" className={css.secondaryButton} onClick={onOpenPreferences}>偏好复盘</button>
          <button
            type="button"
            className={css.secondaryButton}
            aria-busy={allBusy}
            disabled={allBusy}
            onClick={refreshDashboard}
          >{allBusy ? '更新中…' : '刷新数据'}</button>
          <button
            type="button"
            className={css.primaryButton}
            disabled={brief.phase === 'running'}
            onClick={() => { void startBrief() }}
          >{brief.phase === 'running' ? '生成中…' : '生成盘前简报'}</button>
        </div>
      </div>

      {brief.phase !== 'idle' && (
        <div className={css.dashboardTaskNotice} data-phase={brief.phase} role={brief.phase === 'error' ? 'alert' : 'status'}>
          <span>{brief.message}</span>
          {(brief.phase === 'background' || brief.phase === 'done') && (
            <button type="button" onClick={onOpenReports}>打开投研报告</button>
          )}
        </div>
      )}

      <section className={css.dashboardSummary} aria-label="投研概览">
        <button type="button" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setSelectedOverview('holdings') }}><span>持仓数量</span><strong>{holdings.state.loaded ? String(positions.length) : '—'}</strong><small>查看已保存持仓 →</small></button>
        <button type="button" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setSelectedOverview('cost') }}><span>持仓成本金额</span><strong>{holdings.state.loaded && positions.length > 0 ? compactMoney(costAmount(positions)) : '—'}</strong><small>数量 × 成本价 →</small></button>
        <button type="button" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setPerformanceOpen(true) }}><span>总资产现价</span><strong>{holdings.state.loaded ? (totalCurrent === undefined ? '—' : compactMoney(totalCurrent)) : '—'}</strong><small data-tone={currentProfit === undefined || currentProfit === 0 ? undefined : currentProfit > 0 ? 'positive' : 'negative'}>盈亏 {holdings.state.loaded && quotes.state.loaded ? signedCompactMoney(currentProfit) : '—'} · 成本收益率 {holdings.state.loaded && quotes.state.loaded ? signedReturn(currentCostReturn) : '—'} →</small></button>
        <button type="button" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setSelectedOverview('risk-profile') }}><span>风险画像</span><strong>{risk.state.loaded ? text(riskValue.profile_label, '待完善') : '—'}</strong><small>{risk.state.loaded ? `等权 HHI ${number(riskSummary.hhi)?.toFixed(3) ?? '—'} · 查看详情 →` : '按组合风险预算校准'}</small></button>
      </section>

      <div className={css.dashboardGrid}>
        <div className={css.dashboardPrimary}>
          <section className={`${css.dashboardPanel} ${css.dashboardOverviewPanel}`} aria-labelledby="dashboard-holdings-title" aria-busy={holdings.busy}>
            <div className={css.dashboardPanelHead}>
              <div><h2 id="dashboard-holdings-title">持仓概览</h2><p>快速确认当前研究对象，可在当前页查看并维护完整持仓</p></div>
              <RegionMeta state={holdings.state} settled={`${positions.length} 项`} />
            </div>
            {holdings.state.error !== '' && (
              <RegionError title="持仓暂不可用" message={holdings.state.error} retained={holdings.state.loaded} retry={() => { holdings.run({ operation: 'trading-core.holdings' }) }} />
            )}
            {!holdings.state.loaded && holdings.state.error === '' && <RegionSkeleton rows={2} />}
            {holdings.state.loaded && positions.length > 0 && (
              <div className={css.dashboardHoldingList}>
                {positions.slice(0, 6).map((item, index) => {
                  const code = text(item.ticker, '')
                  const quantity = number(item.quantity)
                  const price = number(asRecord(quoteMap.get(code)).price)
                  const marketValue = quantity !== undefined && price !== undefined ? quantity * price : undefined
                  return (
                    <button key={`${code}-${index}`} type="button" onClick={() => { navigate('stock-detail', { stockCode: code }) }}>
                      <span><strong>{resolvedSecurityName(item, code, securityNames)}</strong><small>{code}</small></span>
                      <span><b>{quantity?.toLocaleString('zh-CN') ?? '—'} 股</b><small>成本 {money(number(item.cost_price))} · 现价 {money(price)} · 市值 {marketValue === undefined ? '—' : compactMoney(marketValue)}</small></span>
                    </button>
                  )
                })}
              </div>
            )}
            {holdings.state.loaded && positions.length === 0 && (
              <div className={css.dashboardEmpty}>尚未保存持仓。录入真实持仓后，这里会关联风险与资讯。</div>
            )}
            <button type="button" className={css.dashboardTextButton} aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setSelectedOverview('holdings') }}>管理持仓 →</button>
          </section>

          <section className={css.dashboardPanel} aria-labelledby="dashboard-events-title" aria-busy={cards.busy}>
            <div className={css.dashboardPanelHead}>
              <div><h2 id="dashboard-events-title">关联资讯与事件</h2><p>命中你关注标的的真实事件，并补充反映大盘趋势的政策/宏观事件</p></div>
              <span className={`${css.dashboardRegionMeta} ${css.dashboardEventHeaderMeta}`} aria-live="polite">
                {cardsAsOf === '' ? (cards.busy ? '加载中…' : `${eventCards.length} 条`) : `更新于 ${displayTime(cardsAsOf)}`}
              </span>
            </div>
            <div className={css.segmented} role="group" aria-label="事件业务视角">
              {(Object.keys(EVENT_VIEW_LABELS) as EventView[]).map(value => {
                const count = value === 'all' ? allEventCount : eventCounts[value]
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={eventView === value}
                    className={eventView === value ? css.segmentActive : undefined}
                    onClick={() => {
                      if (eventView === value) return
                      setEventView(value)
                      setEventOffset(0)
                      if (eventListRef.current !== null) eventListRef.current.scrollTop = 0
                    }}
                  >{EVENT_VIEW_LABELS[value]}{count === undefined ? '' : ` ${count}`}</button>
                )
              })}
            </div>
            <div
              className={css.dashboardEventViewport}
              ref={eventListRef}
              role="region"
              aria-label="关联资讯列表"
              aria-busy={cards.busy}
              tabIndex={0}
            >
            {cards.state.error !== '' && (
              <RegionError
                title="关联事件暂不可用"
                message={cards.state.error}
                retained={eventCards.length > 0}
                retry={() => { cards.run({
                  operation: 'trading-core.personalized-cards',
                  input: {
                    limit: EVENT_PAGE_SIZE, offset: eventOffset, bucket: 'all', business_view: eventView,
                    match: true, comment: false,
                  },
                }) }}
              />
            )}
            {!cards.state.loaded && eventCards.length === 0 && cards.state.error === '' && <RegionSkeleton rows={4} />}
            {visibleCards.map((card, index) => {
              const ticker = tickerFromCard(card)
              const reasons = stringItems(card.reasons)
              const cardRisk = asRecord(card.risk)
              const riskLevel = text(cardRisk.level, '')
              const title = text(card.title, '市场事件').trim()
              const summary = text(card.summary, '').trim()
              const showSummary = summary !== '' && comparableCopy(summary) !== comparableCopy(title)
              const riskNote = text(cardRisk.note, '').trim()
              return (
                <ImpressionArticle
                  className={css.dashboardEvent}
                  key={text(card.card_id, String(index))}
                  trackTelemetry={trackTelemetry}
                  impression={{
                    action: 'impression', surface: 'dashboard', targetType: 'event',
                    targetId: text(card.card_id, `event-${index}`), context: eventTelemetryContext(card),
                  }}
                >
                  <div className={css.dashboardEventBody}>
                    <h3>{title}</h3>
                    <div className={css.dashboardEventMeta}>
                      <time>{displayTime(card.time)}</time>
                      {EVENT_TYPE_BADGE[text(card.type, '')] !== undefined && (
                        <span data-kind="type">{EVENT_TYPE_BADGE[text(card.type, '')]}</span>
                      )}
                      <span>{BUCKET_LABELS[text(card.bucket, '')] ?? '关联事件'}</span>
                      {riskLevel !== '' && <span data-severity={riskLevel}>{riskLevel}风险</span>}
                      <span>{text(card.source, '来源未知')}</span>
                    </div>
                    {reasons.length > 0 && (
                      <div className={css.dashboardReasons}>
                        {reasons.map((reason) => {
                          const code = holdingReasonCode(reason)
                          if (code === undefined) {
                            const direction = reason.includes('利好') ? '利好' : reason.includes('利空') ? '利空' : undefined
                            return <span key={reason} data-direction={direction}>{reason}</span>
                          }
                          const resolvedName = securityNames[code]?.trim() ?? ''
                          const name = resolvedName !== '' ? resolvedName : ticker?.name.trim() ?? ''
                          return (
                            <button className={css.securityPillButton} key={reason} type="button" onClick={() => { navigate('stock-detail', { stockCode: code }) }}>
                              命中持仓：{name === '' || name === code ? code : name}<small>{code}</small>
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {(showSummary || riskNote !== '') && (
                      <div className={css.dashboardEventDescription}>
                        {showSummary && <p>{summary}</p>}
                        {riskNote !== '' && <small className={css.dashboardRiskNote}>{riskNote}</small>}
                      </div>
                    )}
                  </div>
                  <div className={css.dashboardEventControls} role="group" aria-label="事件操作">
                    <div className={css.dashboardEventActions} role="group" aria-label="快捷操作">
                      <button type="button" onClick={() => {
                        void trackTelemetry({
                          action: 'open', surface: 'dashboard', targetType: 'event',
                          targetId: text(card.card_id, `event-${index}`), context: eventTelemetryContext(card),
                        })
                        setSelectedEvent(card)
                      }}>详情</button>
                      <button
                        type="button"
                        onClick={() => {
                          if (ticker !== undefined) onAnalyze({ kind: 'stock', code: ticker.code, name: ticker.name })
                          else onAnalyze({ kind: 'industry', reference: title })
                        }}
                      >分析</button>
                    </div>
                    <PreferenceFeedback
                      cardId={text(card.card_id, `event-${index}`)}
                      current={text(card.feedback_sentiment, '')}
                      meta={eventTelemetryContext(card)}
                      requestData={requestData}
                      compact
                    />
                  </div>
                </ImpressionArticle>
              )
            })}
            {cards.state.loaded && eventCards.length === 0 && (
              <div className={css.dashboardEmpty}>当前业务视角没有关联事件。可以切换分类或稍后刷新；事件源尚未完成更新时也可能暂时为空。</div>
            )}
            {eventCards.length > 0 && eventTotal > 0 && (
              <div ref={eventLoadMoreRef} className={css.dashboardEventLoadMore} data-testid="event-load-more-sentinel" role="status" aria-live="polite">
                {cards.busy ? '正在加载更多…' : hasNextEventPage ? '继续向下滚动加载' : `已加载全部 ${eventTotal} 条`}
              </div>
            )}
            </div>
          </section>
        </div>

        <aside className={css.dashboardSide} aria-label="风险与策略">
          <section className={`${css.dashboardPanel} ${css.dashboardOverviewPanel}`} tabIndex={-1} aria-labelledby="dashboard-alerts-title" aria-busy={alerts.busy}>
            <div className={css.dashboardPanelHead}>
              <div className={css.dashboardAttentionHeading}>
                <div className={css.dashboardAttentionTitle}>
                  <h2 id="dashboard-alerts-title">重点关注</h2>
                  <span aria-live="polite">{alerts.state.loaded ? `${actionableAlerts.length} 条` : '—'}</span>
                </div>
                <RegionMeta state={alerts.state} settled={alertsAsOf === '' ? '等待更新时间' : `更新于 ${displayTime(alertsAsOf)}`} />
              </div>
              <div className={css.dashboardAttentionHeadActions}>
                <button type="button" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setSelectedOverview('risk-center') }}>查看详情 →</button>
              </div>
            </div>
            {alertValue.degraded === true && <div className={css.dashboardDegraded}>关联事件暂未更新，组合与画像预警仍可用。</div>}
            {alerts.state.error !== '' && (
              <RegionError title="重点关注暂不可用" message={alerts.state.error} retained={alerts.state.loaded} retry={() => { alerts.run({ operation: 'trading-core.risk-alerts' }) }} />
            )}
            {!alerts.state.loaded && alerts.state.error === '' && <RegionSkeleton />}
            {alerts.state.loaded && actionableAlerts.length > 0 && (
              <div className={css.dashboardAttentionViewport} data-at-top={attentionEdges.top} data-at-bottom={attentionEdges.bottom}>
              <div
                className={css.dashboardAttentionList}
                ref={attentionListRef}
                role="region"
                aria-label={`重点关注列表，共 ${actionableAlerts.length} 条`}
                tabIndex={0}
                onScroll={(event) => {
                  const node = event.currentTarget
                  setAttentionEdges({
                    top: node.scrollTop <= 1,
                    bottom: node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
                  })
                }}
              >
                {actionableAlerts.map((item, index) => (
                  <ImpressionArticle
                    className={css.dashboardAlert}
                    key={text(item.id, String(index))}
                    trackTelemetry={trackTelemetry}
                    impression={{
                      action: 'impression', surface: 'dashboard', targetType: 'risk',
                      targetId: text(item.id, `risk-${index}`), context: riskTelemetryContext(item),
                    }}
                  >
                    <span data-severity={text(item.severity, '中')}>{text(item.severity, '中')}</span>
                    <div className={css.dashboardAlertTitleRow}>
                      <strong>{text(item.title, '风险提醒')}</strong>
                      <button
                        className={css.dashboardAlertDetailButton}
                        type="button"
                        data-action="risk-detail"
                        data-risk-id={text(item.id, text(item.indicator, text(item.title, String(index))))}
                        aria-haspopup="dialog"
                        onClick={() => {
                          void trackTelemetry({
                            action: 'open', surface: 'dashboard', targetType: 'risk',
                            targetId: text(item.id, `risk-${index}`), context: riskTelemetryContext(item),
                          })
                          setRiskDetailOrigin('panel')
                          setSelectedRisk({
                            ...item,
                            degraded: alertValue.degraded === true,
                            degraded_reason: text(alertValue.degraded_reason, '关联事件暂未更新，组合与画像预警仍可用。'),
                          })
                        }}
                      >查看详情</button>
                    </div>
                    <p className={css.dashboardAlertDescription}>{text(item.detail, '')}</p>
                    <div className={css.dashboardAlertFooter}>
                      <time>{displayTime(item.ts)}</time>
                      <PreferenceFeedback
                        cardId={text(item.id, `risk-${index}`)}
                        current={text(asRecord(item.feedback).current, '')}
                        meta={riskTelemetryContext(item)}
                        requestData={requestData}
                        compact
                      />
                    </div>
                  </ImpressionArticle>
                ))}
              </div>
              </div>
            )}
            {alerts.state.loaded && actionableAlerts.length === 0 && <div className={css.dashboardGood}>当前没有需要重点关注的高/中影响事项</div>}
          </section>

          <KycProfilePanel
            value={kyc.state.value}
            loaded={kyc.state.loaded}
            busy={kyc.busy}
            error={kyc.state.error}
            requestData={requestData}
            onRetry={() => { kyc.run({ operation: 'trading-core.kyc-profile' }) }}
            onChanged={() => {
              kyc.run({ operation: 'trading-core.kyc-profile' }, { fresh: true })
              risk.run({ operation: 'trading-core.risk-portfolio' }, { fresh: true })
              alerts.run({ operation: 'trading-core.risk-alerts' }, { fresh: true })
              matches.run({ operation: 'trading-core.personalized-matches' }, { fresh: true })
            }}
          />

          <section className={css.dashboardPanel} aria-labelledby="dashboard-strategies-title" aria-busy={matches.busy}>
            <div className={css.dashboardPanelHead}>
              <div><h2 id="dashboard-strategies-title">策略匹配</h2><p>结合画像与分散化预算</p></div>
              <RegionMeta state={matches.state} settled={matchesAsOf === '' ? `${strategyItems.length} 项` : `更新于 ${displayTime(matchesAsOf)}`} />
            </div>
            {matches.state.error !== '' && (
              <RegionError title="策略匹配暂不可用" message={matches.state.error} retained={matches.state.loaded} retry={() => { matches.run({ operation: 'trading-core.personalized-matches' }) }} />
            )}
            {!matches.state.loaded && matches.state.error === '' && <RegionSkeleton />}
            {matches.state.loaded && strategyItems.slice(0, 3).map((item, index) => {
              const id = text(item.strategy_id, '')
              const reason = records(item.match_reasons)[0]
              return (
                <button key={id || String(index)} type="button" className={css.dashboardStrategy} onClick={() => {
                  if (id !== '') {
                    void trackTelemetry({
                      action: 'open', surface: 'dashboard', targetType: 'strategy', targetId: id,
                      context: { strategy_id: id },
                    })
                  }
                  navigate('framework', { strategyId: id })
                }}>
                  <span><strong>{strategyDisplayName(item, securityNames)}</strong><small>{reason === undefined ? text(item.caution, '查看匹配依据') : text(reason.text, '查看匹配依据')}</small></span>
                  <b>{number(item.match_score)?.toFixed(0) ?? '—'}</b>
                </button>
              )
            })}
            {matches.state.loaded && strategyItems.length === 0 && <div className={css.dashboardEmpty}>暂无匹配策略。先在策略研究中建立并验证候选。</div>}
            <button type="button" className={css.dashboardTextButton} onClick={() => { navigate('framework') }}>进入策略研究 →</button>
          </section>

          <section className={css.dashboardPanel} aria-labelledby="dashboard-risk-title" aria-busy={risk.busy}>
            <div className={css.dashboardPanelHead}>
              <div><h2 id="dashboard-risk-title">组合风险预算</h2><p>当前为等权估算口径</p></div>
              <RegionMeta state={risk.state} settled={riskAsOf === '' ? '等待更新' : `更新于 ${displayTime(riskAsOf)}`} />
            </div>
            {risk.state.error !== '' && (
              <RegionError title="组合风险暂不可用" message={risk.state.error} retained={risk.state.loaded} retry={() => { risk.run({ operation: 'trading-core.risk-portfolio' }) }} />
            )}
            {!risk.state.loaded && risk.state.error === '' && <RegionSkeleton rows={2} />}
            {risk.state.loaded && (
              <dl className={css.dashboardRiskMetrics}>
                <div><dt>单股等权占比</dt><dd>{number(riskSummary.equal_weight) === undefined ? '—' : `${((number(riskSummary.equal_weight) ?? 0) * 100).toFixed(1)}%`}</dd></div>
                <div><dt>集中度 HHI</dt><dd>{number(riskSummary.hhi)?.toFixed(3) ?? '—'}</dd></div>
                <div><dt>预算突破</dt><dd>{records(riskValue.breaches).length}</dd></div>
              </dl>
            )}
          </section>
        </aside>
      </div>
      {selectedOverview !== undefined && (
        <WorkbenchOverviewDialog
          kind={selectedOverview}
          positions={overviewPositions}
          risk={riskValue}
          alerts={alertItems}
          riskAsOf={riskAsOf}
          alertsAsOf={alertsAsOf}
          alertsDegraded={alertValue.degraded === true}
          alertsDegradedReason={text(alertValue.degraded_reason, '')}
          holdingsState={{ loaded: holdings.state.loaded, busy: holdings.busy, error: holdings.state.error }}
          riskState={{ loaded: risk.state.loaded, busy: risk.busy, error: risk.state.error }}
          alertsState={{ loaded: alerts.state.loaded, busy: alerts.busy, error: alerts.state.error }}
          onOpenAlert={(item) => {
            setRiskDetailOrigin('overview')
            setSelectedOverview(undefined)
            setSelectedRisk({
              ...item,
              degraded: alertValue.degraded === true,
              degraded_reason: text(alertValue.degraded_reason, '关联事件暂未更新，组合与画像预警仍可用。'),
            })
          }}
          onSaveHoldings={saveHoldings}
          onSyncHoldings={syncHoldings}
          requestData={requestData}
          brokerSync={brokerSync}
          holdingsProviders={holdingsProviders}
          onClose={() => { setSelectedOverview(undefined) }}
        />
      )}
      {performanceOpen && (
        <PortfolioPerformanceDialog
          value={performance.state.value}
          loaded={performance.state.loaded}
          busy={performance.busy}
          error={performance.state.error}
          positions={overviewPositions}
          period={performancePeriod}
          method={performanceMethod}
          customStart={customStart}
          customEnd={customEnd}
          customError={customError}
          onPeriodChange={(period) => {
            setCustomError('')
            if (period === 'custom') {
              const current = localDate(new Date())
              setCustomStart(value => value || text(asRecord(performance.state.value).available_since, current))
              setCustomEnd(value => value || current)
              setAppliedCustom(undefined)
            }
            setPerformancePeriod(period)
          }}
          onMethodChange={setPerformanceMethod}
          onCustomStartChange={(value) => { setCustomStart(value); setCustomError('') }}
          onCustomEndChange={(value) => { setCustomEnd(value); setCustomError('') }}
          onApplyCustom={() => {
            if (customStart === '' || customEnd === '') {
              setCustomError('请选择完整的开始日期和结束日期')
              return
            }
            if (customStart > customEnd) {
              setCustomError('开始日期不能晚于结束日期')
              return
            }
            setCustomError('')
            setAppliedCustom({ start_date: customStart, end_date: customEnd })
          }}
          onHistoryStartSave={async (effectiveDate) => {
            await requestData({
              operation: 'trading-core.portfolio-history-start',
              input: { effective_date: effectiveDate },
            })
            performance.run({
              operation: 'trading-core.portfolio-performance',
              ...(selectedPerformanceRange === undefined ? {} : { input: selectedPerformanceRange }),
            }, { fresh: true })
          }}
          onRetry={() => {
            performance.run({
              operation: 'trading-core.portfolio-performance',
              ...(selectedPerformanceRange === undefined ? {} : { input: selectedPerformanceRange }),
            }, { fresh: true })
          }}
          onClose={() => { setPerformanceOpen(false) }}
        />
      )}
      {selectedRisk !== undefined && (
        <RiskDetailDialog
          item={selectedRisk}
          onClose={() => {
            setSelectedRisk(undefined)
            if (riskDetailOrigin === 'overview') setSelectedOverview('risk-center')
            setRiskDetailOrigin('panel')
          }}
          onAnalyze={() => {
            const target = riskIntentTarget(selectedRisk)
            setSelectedRisk(undefined)
            setRiskDetailOrigin('panel')
            if (target.strategyId !== undefined) onAnalyze({ kind: 'strategy', strategyId: target.strategyId })
            else if (target.code !== undefined) onAnalyze({ kind: 'stock', code: target.code })
            else onAnalyze({ kind: 'portfolio' })
          }}
        />
      )}
      {selectedEvent !== undefined && (
        <EventReportDialog
          item={selectedEvent}
          requestData={requestData}
          onClose={() => { setSelectedEvent(undefined) }}
          onAnalyze={() => {
            const ticker = eventPrimaryTicker(selectedEvent)
            const reference = text(selectedEvent.title, '')
            setSelectedEvent(undefined)
            if (ticker !== undefined) onAnalyze({ kind: 'stock', code: ticker.code, name: ticker.name })
            else onAnalyze({ kind: 'industry', reference })
          }}
        />
      )}
    </div>
  )
}
