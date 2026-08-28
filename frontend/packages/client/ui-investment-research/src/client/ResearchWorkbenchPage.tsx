import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { AssistantIntent } from './assistant-intent.ts'
import { asRecord, money, number, productErrorText, records, text } from './data.ts'
import {
  EventReportDialog, RiskDetailDialog, eventPrimaryTicker, riskIntentTarget,
} from './DetailDialogs.tsx'
import type { InvestmentNavigationContext, InvestmentRoute } from './state.ts'
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

  const run = useCallback((request: InvestmentDataRequest): void => {
    const key = JSON.stringify(request)
    const current = ++generation.current
    setState(previous => ({
      phase: previous.loaded && settledKey.current === key ? 'refreshing' : 'loading',
      loaded: previous.loaded && settledKey.current === key,
      value: previous.loaded && settledKey.current === key ? previous.value : undefined,
      error: '',
    }))
    let flight = flights.current.get(key)
    if (flight === undefined) {
      flight = Promise.resolve().then(() => requestData(request))
      flights.current.set(key, flight)
      const release = (): void => {
        if (flights.current.get(key) === flight) flights.current.delete(key)
      }
      void flight.then(release, release)
    }
    void flight.then((value) => {
      if (current !== generation.current) return
      settledKey.current = key
      setState({ phase: 'success', loaded: true, value, error: '' })
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

function compactMoney(value: number): string {
  if (value >= 100_000_000) return `¥${(value / 100_000_000).toFixed(2)} 亿`
  if (value >= 10_000) return `¥${(value / 10_000).toFixed(1)} 万`
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}

const BUCKET_LABELS: Readonly<Record<string, string>> = Object.freeze({
  all: '全部', holdings: '持仓', watchlist: '自选', strategy: '策略', fresh: '市场',
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
  cardId, current, meta, requestData,
}: {
  cardId: string
  current: string
  meta: LocalTelemetryContext
  requestData: RequestData
}) {
  const [sentiment, setSentiment] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setSentiment(current) }, [current])

  const submit = async (next: 'useful' | 'useless'): Promise<void> => {
    if (busy || sentiment === next) return
    setBusy(true); setError('')
    try {
      await requestData({
        operation: 'trading-core.personalized-feedback',
        input: { card_id: cardId, sentiment: next, meta: { ...meta } },
      })
      setSentiment(next)
    } catch {
      setError('偏好未保存，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.preferenceFeedback}>
      <span>这条内容：</span>
      <button type="button" aria-pressed={sentiment === 'useful'} disabled={busy} onClick={() => { void submit('useful') }}>值得关注</button>
      <button type="button" aria-pressed={sentiment === 'useless'} disabled={busy} onClick={() => { void submit('useless') }}>减少此类</button>
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
  readonly navigate: (route: InvestmentRoute, context?: InvestmentNavigationContext) => void
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onOpenReports: () => void
  readonly trackTelemetry: TrackLocalTelemetry
}

type EventBucket = 'all' | 'holdings' | 'watchlist' | 'strategy'

/** Default product landing page: one real-data overview, not another chat surface. */
export function ResearchWorkbenchPage({
  requestData, navigate, onAnalyze, onOpenReports, trackTelemetry,
}: ResearchWorkbenchPageProps) {
  const holdings = useWorkbenchResource(requestData)
  const risk = useWorkbenchResource(requestData)
  const alerts = useWorkbenchResource(requestData)
  const cards = useWorkbenchResource(requestData)
  const matches = useWorkbenchResource(requestData)
  const alive = useRef(true)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [bucket, setBucket] = useState<EventBucket>('all')
  const [selectedEvent, setSelectedEvent] = useState<Record<string, unknown>>()
  const [selectedRisk, setSelectedRisk] = useState<Record<string, unknown>>()
  const [brief, setBrief] = useState<{
    phase: 'idle' | 'running' | 'background' | 'done' | 'error'
    message: string
  }>({ phase: 'idle', message: '' })

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    holdings.run({ operation: 'trading-core.holdings' })
    risk.run({ operation: 'trading-core.risk-portfolio' })
    alerts.run({ operation: 'trading-core.risk-alerts' })
    matches.run({ operation: 'trading-core.personalized-matches' })
  }, [alerts.run, holdings.run, matches.run, refreshVersion, risk.run])

  useEffect(() => {
    cards.run({
      operation: 'trading-core.personalized-cards',
      input: { limit: 20, bucket: 'all', match: true, comment: false },
    })
  }, [cards.run, refreshVersion])

  const positions = records(asRecord(holdings.state.value).items)
  const riskValue = asRecord(risk.state.value)
  const riskSummary = asRecord(riskValue.summary)
  const alertValue = asRecord(alerts.state.value)
  const alertItems = records(alertValue.items)
  const cardValue = asRecord(cards.state.value)
  const allCards = records(cardValue.cards)
  const strategyValue = asRecord(matches.state.value)
  const strategyItems = records(strategyValue.items)
  const unresolvedStrategySymbols = [...new Set(strategyItems.flatMap(strategySymbols))].sort().join('|')
  const [strategySecurityNames, setStrategySecurityNames] = useState<Record<string, string>>({})
  useEffect(() => {
    const codes = unresolvedStrategySymbols === '' ? [] : unresolvedStrategySymbols.split('|')
    if (codes.length === 0) return
    const requestState = { cancelled: false }
    void (async () => {
      for (let start = 0; start < codes.length; start += 3) {
        const resolved = await Promise.all(codes.slice(start, start + 3).map(async (code): Promise<readonly [string, string]> => {
          try {
            const result = asRecord(await requestData({
              operation: 'market-watch.security-search', input: { query: code, limit: 5 },
            }))
            const match = records(result.items).find(item => text(item.code, '').trim() === code)
            return [code, text(match?.name, '').trim()] as const
          } catch {
            return [code, ''] as const
          }
        }))
        if (requestState.cancelled) return
        setStrategySecurityNames(current => ({ ...current, ...Object.fromEntries(resolved) }))
      }
    })()
    return () => { requestState.cancelled = true }
  }, [requestData, unresolvedStrategySymbols])
  const visibleCards = useMemo(() => (
    bucket === 'all' ? allCards : allCards.filter(item => text(item.bucket, '') === bucket)
  ), [allCards, bucket])
  const actionableAlerts = alertItems.filter(item => (
    text(item.source, '') !== 'profile' && text(item.severity, '低') !== '低'
  ))
  const allBusy = [holdings, risk, alerts, cards, matches].some(resource => resource.busy)

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
  const cardsAsOf = text(cardValue.as_of, '')
  const matchesAsOf = text(strategyValue.as_of, '')

  return (
    <div className={css.pageScroll}>
      <div className={css.pageHeader}>
        <div>
          <h1>研究工作台</h1>
          <p>聚合今天最值得关注的事件、组合风险与下一步研究动作</p>
        </div>
        <div>
          <button
            type="button"
            className={css.secondaryButton}
            aria-busy={allBusy}
            disabled={allBusy}
            onClick={() => { setRefreshVersion(value => value + 1) }}
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
        <div><span>持仓数量</span><strong>{holdings.state.loaded ? String(positions.length) : '—'}</strong><small>已保存持仓</small></div>
        <div><span>持仓成本金额</span><strong>{holdings.state.loaded && positions.length > 0 ? compactMoney(costAmount(positions)) : '—'}</strong><small>数量 × 成本价，非实时市值</small></div>
        <div><span>风险画像</span><strong>{risk.state.loaded ? text(riskValue.profile_label, '待完善') : '—'}</strong><small>{risk.state.loaded ? `等权 HHI ${number(riskSummary.hhi)?.toFixed(3) ?? '—'}` : '按组合风险预算校准'}</small></div>
        <div><span>需关注预警</span><strong data-tone={actionableAlerts.length > 0 ? 'danger' : undefined}>{alerts.state.loaded ? String(actionableAlerts.length) : '—'}</strong><small>{alerts.state.loaded ? '高/中风险，排除画像提示' : '组合、影子与事件'}</small></div>
      </section>

      <div className={css.dashboardGrid}>
        <div className={css.dashboardPrimary}>
          <section className={css.dashboardPanel} aria-labelledby="dashboard-holdings-title" aria-busy={holdings.busy}>
            <div className={css.dashboardPanelHead}>
              <div><h2 id="dashboard-holdings-title">持仓概览</h2><p>快速确认当前研究对象，完整编辑与风险明细仍在“我的投研”</p></div>
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
                  return (
                    <button key={`${code}-${index}`} type="button" onClick={() => { navigate('stock-detail', { stockCode: code }) }}>
                      <span><strong>{text(item.name, code)}</strong><small>{code}</small></span>
                      <span><b>{number(item.quantity)?.toLocaleString('zh-CN') ?? '—'} 股</b><small>成本 {money(item.cost_price)}</small></span>
                    </button>
                  )
                })}
              </div>
            )}
            {holdings.state.loaded && positions.length === 0 && (
              <div className={css.dashboardEmpty}>尚未保存持仓。录入真实持仓后，这里会关联风险与资讯。</div>
            )}
            <button type="button" className={css.dashboardTextButton} onClick={() => { navigate('portfolio') }}>管理持仓与风险 →</button>
          </section>

          <section className={css.dashboardPanel} aria-labelledby="dashboard-events-title" aria-busy={cards.busy}>
            <div className={css.dashboardPanelHead}>
              <div><h2 id="dashboard-events-title">关联资讯与事件</h2><p>只展示命中持仓、自选或生效策略的真实事件</p></div>
              <RegionMeta state={cards.state} settled={cardsAsOf === '' ? `${allCards.length} 条` : `更新于 ${displayTime(cardsAsOf)}`} />
            </div>
            <div className={css.segmented} role="group" aria-label="事件范围">
              {(['all', 'holdings', 'watchlist', 'strategy'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={bucket === value}
                  className={bucket === value ? css.segmentActive : undefined}
                  onClick={() => { setBucket(value) }}
                >{BUCKET_LABELS[value]}</button>
              ))}
            </div>
            {cards.state.error !== '' && (
              <RegionError
                title="关联事件暂不可用"
                message={cards.state.error}
                retained={cards.state.loaded}
                retry={() => { cards.run({ operation: 'trading-core.personalized-cards', input: { limit: 20, bucket: 'all', match: true, comment: false } }) }}
              />
            )}
            {!cards.state.loaded && cards.state.error === '' && <RegionSkeleton rows={4} />}
            {cards.state.loaded && visibleCards.map((card, index) => {
              const ticker = tickerFromCard(card)
              const strategyId = strategyFromCard(card)
              const reasons = stringItems(card.reasons)
              const cardRisk = asRecord(card.risk)
              const riskLevel = text(cardRisk.level, '')
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
                  <div className={css.dashboardEventMeta}>
                    <span>{BUCKET_LABELS[text(card.bucket, '')] ?? '关联事件'}</span>
                    {riskLevel !== '' && <span data-severity={riskLevel}>{riskLevel}风险</span>}
                    <span>{text(card.source, '来源未知')}</span>
                    <time>{displayTime(card.time)}</time>
                  </div>
                  <h3>{text(card.title, '市场事件')}</h3>
                  <p>{text(card.summary, '暂无事件摘要')}</p>
                  {reasons.length > 0 && (
                    <div className={css.dashboardReasons}>
                      {reasons.map(reason => <span key={reason}>{reason}</span>)}
                    </div>
                  )}
                  {text(cardRisk.note, '') !== '' && <small className={css.dashboardRiskNote}>{text(cardRisk.note)}</small>}
                  <div className={css.dashboardEventActions}>
                    <button type="button" onClick={() => {
                      void trackTelemetry({
                        action: 'open', surface: 'dashboard', targetType: 'event',
                        targetId: text(card.card_id, `event-${index}`), context: eventTelemetryContext(card),
                      })
                      setSelectedEvent(card)
                    }}>{text(card.report_id, '') === '' ? '查看事件详情' : '查看投研报告'}</button>
                    {ticker !== undefined && <button type="button" onClick={() => {
                      void trackTelemetry({
                        action: 'open', surface: 'dashboard', targetType: 'security', targetId: ticker.code,
                        context: { ticker: ticker.code },
                      })
                      navigate('stock-detail', { stockCode: ticker.code })
                    }}>查看个股</button>}
                    {strategyId !== '' && <button type="button" onClick={() => {
                      void trackTelemetry({
                        action: 'open', surface: 'dashboard', targetType: 'strategy', targetId: strategyId,
                        context: { strategy_id: strategyId },
                      })
                      navigate('framework', { strategyId })
                    }}>查看策略</button>}
                    <button
                      type="button"
                      onClick={() => {
                        if (ticker !== undefined) onAnalyze({ kind: 'stock', code: ticker.code, name: ticker.name })
                        else onAnalyze({ kind: 'industry', reference: text(card.title, '') })
                      }}
                    >带入智能分析</button>
                  </div>
                  <PreferenceFeedback
                    cardId={text(card.card_id, `event-${index}`)}
                    current={text(card.feedback_sentiment, '')}
                    meta={eventTelemetryContext(card)}
                    requestData={requestData}
                  />
                </ImpressionArticle>
              )
            })}
            {cards.state.loaded && visibleCards.length === 0 && (
              <div className={css.dashboardEmpty}>当前筛选未返回关联事件。可以切换范围或稍后刷新；事件源尚未完成更新时也可能暂时为空。</div>
            )}
          </section>
        </div>

        <aside className={css.dashboardSide} aria-label="风险与策略">
          <section className={css.dashboardPanel} aria-labelledby="dashboard-alerts-title" aria-busy={alerts.busy}>
            <div className={css.dashboardPanelHead}>
              <div><h2 id="dashboard-alerts-title">风险预警</h2><p>按严重度优先处理</p></div>
              <RegionMeta state={alerts.state} settled={alertsAsOf === '' ? `${alertItems.length} 条` : `更新于 ${displayTime(alertsAsOf)}`} />
            </div>
            {alertValue.degraded === true && <div className={css.dashboardDegraded}>关联事件暂未更新，组合与画像预警仍可用。</div>}
            {alerts.state.error !== '' && (
              <RegionError title="风险预警暂不可用" message={alerts.state.error} retained={alerts.state.loaded} retry={() => { alerts.run({ operation: 'trading-core.risk-alerts' }) }} />
            )}
            {!alerts.state.loaded && alerts.state.error === '' && <RegionSkeleton />}
            {alerts.state.loaded && alertItems.slice(0, 5).map((item, index) => {
              return (
                <ImpressionArticle
                  className={css.dashboardAlert}
                  key={text(item.id, String(index))}
                  trackTelemetry={trackTelemetry}
                  impression={{
                    action: 'impression', surface: 'dashboard', targetType: 'risk',
                    targetId: text(item.id, `risk-${index}`), context: riskTelemetryContext(item),
                  }}
                >
                  <span data-severity={text(item.severity, '低')}>{text(item.severity, '低')}</span>
                  <div><strong>{text(item.title, '风险提醒')}</strong><p>{text(item.detail, '')}</p><small>{displayTime(item.ts)}</small></div>
                  <button
                    type="button"
                    data-action="risk-detail"
                    data-risk-id={text(item.id, text(item.indicator, text(item.title, String(index))))}
                    aria-haspopup="dialog"
                    onClick={() => {
                      void trackTelemetry({
                        action: 'open', surface: 'dashboard', targetType: 'risk',
                        targetId: text(item.id, `risk-${index}`), context: riskTelemetryContext(item),
                      })
                      setSelectedRisk({
                        ...item,
                        degraded: alertValue.degraded === true,
                        degraded_reason: text(alertValue.degraded_reason, '关联事件暂未更新，组合与画像预警仍可用。'),
                      })
                    }}
                  >查看详情</button>
                  <PreferenceFeedback
                    cardId={text(item.id, `risk-${index}`)}
                    current={text(asRecord(item.feedback).current, '')}
                    meta={riskTelemetryContext(item)}
                    requestData={requestData}
                  />
                </ImpressionArticle>
              )
            })}
            {alerts.state.loaded && alertItems.length === 0 && <div className={css.dashboardGood}>当前没有风险预警</div>}
            <button type="button" className={css.dashboardTextButton} onClick={() => { navigate('portfolio') }}>查看完整风险详情 →</button>
          </section>

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
                  <span><strong>{strategyDisplayName(item, strategySecurityNames)}</strong><small>{reason === undefined ? text(item.caution, '查看匹配依据') : text(reason.text, '查看匹配依据')}</small></span>
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
      {selectedRisk !== undefined && (
        <RiskDetailDialog
          item={selectedRisk}
          onClose={() => { setSelectedRisk(undefined) }}
          onAnalyze={() => {
            const target = riskIntentTarget(selectedRisk)
            setSelectedRisk(undefined)
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
