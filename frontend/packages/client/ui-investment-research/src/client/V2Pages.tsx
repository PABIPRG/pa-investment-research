import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { InvestmentAssistantActionInput } from './assistant-context.ts'
import { asRecord, money, number, percent, records, text } from './data.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface PageResource {
  readonly value: unknown
  readonly loading: boolean
  readonly loaded: boolean
  readonly error: string
  refresh: () => void
}

const HOLDINGS_REQUEST = { operation: 'trading-core.holdings' } as const
const ALERTS_REQUEST = { operation: 'trading-core.risk-alerts' } as const
const CARDS_REQUEST = {
  operation: 'trading-core.personalized-cards',
  input: { limit: 20, bucket: 'all', match: true, comment: true },
} as const
const MATCHES_REQUEST = { operation: 'trading-core.personalized-matches' } as const
const PROFILE_REQUEST = { operation: 'trading-core.risk-profile' } as const
const STRATEGIES_REQUEST = { operation: 'trading-core.strategies', input: { limit: 100 } } as const
const EVENTS_REQUEST = { operation: 'market-watch.news-events', input: { limit: 20 } } as const
const SHADOW_STATUS_REQUEST = { operation: 'trading-core.shadow-status' } as const
const SHADOW_POSITIONS_REQUEST = { operation: 'trading-core.shadow-positions' } as const
const SHADOW_EQUITY_REQUEST = { operation: 'trading-core.shadow-equity', input: { limit: 120 } } as const
const EVOLUTION_STATUS_REQUEST = { operation: 'trading-core.evolution-status' } as const
const EVOLUTION_ATTRIBUTION_REQUEST = { operation: 'trading-core.evolution-attribution' } as const

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function usePageResource(requestData: RequestData, request: InvestmentDataRequest): PageResource {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState({
    value: undefined as unknown,
    loading: true,
    loaded: false,
    error: '',
  })

  useEffect(() => {
    let current = true
    setState(previous => ({ ...previous, loading: true, error: '' }))
    requestData(request).then((value) => {
      if (current) setState({ value, loading: false, loaded: true, error: '' })
    }, (reason: unknown) => {
      if (current) setState(previous => ({ ...previous, loading: false, error: errorText(reason) }))
    })
    return () => { current = false }
  }, [nonce, request, requestData])

  return { ...state, refresh: useCallback(() => { setNonce(value => value + 1) }, []) }
}

function PageHead({
  title, description, children,
}: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className={css.pageHeader}>
      <div><h1>{title}</h1><p>{description}</p></div>
      <div>{children}</div>
    </div>
  )
}

function Panel({
  title, subtitle, children, className,
}: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`${css.v2Panel}${className === undefined ? '' : ` ${className}`}`}>
      <div className={css.v2PanelHead}>
        <div><strong>{title}</strong>{subtitle !== undefined && <span>{subtitle}</span>}</div>
      </div>
      <div className={css.v2PanelBody}>{children}</div>
    </section>
  )
}

function Stat({ label, value, note, tone }: {
  label: string
  value: string
  note: string
  tone?: 'positive' | 'negative'
}) {
  return (
    <div className={css.v2Stat}>
      <span>{label}</span>
      <strong className={tone === 'positive' ? css.positive : tone === 'negative' ? css.negative : undefined}>{value}</strong>
      <small>{note}</small>
    </div>
  )
}

function LoadState({ resource, empty = '暂无数据' }: { resource: PageResource; empty?: string }) {
  if (resource.loading && !resource.loaded) return <div className={css.v2Skeleton}><i /><i /><i /></div>
  if (resource.error !== '' && !resource.loaded) {
    return (
      <div className={css.v2InlineError} role="alert">
        <div><strong>数据暂不可用</strong><span>{resource.error}</span></div>
        <button type="button" onClick={resource.refresh}>重试</button>
      </div>
    )
  }
  if (!resource.loaded) return <div className={css.v2Empty}>{empty}</div>
  return null
}

function arrayItems(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value)
  return Array.isArray(value) ? records(value) : records(record.items)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

function compactMoney(value: number): string {
  if (value >= 100_000_000) return `¥${(value / 100_000_000).toFixed(2)} 亿`
  if (value >= 10_000) return `¥${(value / 10_000).toFixed(1)} 万`
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}

interface BusinessActionState {
  readonly phase: 'idle' | 'running' | 'done' | 'error'
  readonly message: string
  readonly result?: unknown
}

const IDLE_ACTION: BusinessActionState = { phase: 'idle', message: '' }

function ActionNotice({ state }: { state: BusinessActionState }) {
  if (state.phase === 'idle') return null
  return (
    <div className={css.v2ActionNotice} data-phase={state.phase} role={state.phase === 'error' ? 'alert' : 'status'}>
      {state.phase === 'running' && <i />}
      <span>{state.message}</span>
    </div>
  )
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { window.setTimeout(resolve, ms) })
}

async function runBackendTask(
  requestData: RequestData,
  start: InvestmentDataRequest,
  onProgress: (message: string) => void,
): Promise<unknown> {
  const started = asRecord(await requestData(start))
  const taskId = text(started.task_id, '')
  if (taskId === '') throw new Error('后端没有返回 task_id。')
  onProgress(`任务已创建（${taskId}），正在等待后端执行…`)
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const status = asRecord(await requestData({ operation: 'trading-core.task-status', input: { task_id: taskId } }))
    const phase = text(status.status, 'pending')
    if (phase === 'done') {
      return requestData({ operation: 'trading-core.task-result', input: { task_id: taskId } })
    }
    if (phase === 'failed') throw new Error(text(status.error, '后端任务执行失败。'))
    onProgress(`后端正在${phase === 'pending' ? '排队' : '执行'}（${taskId}）…`)
    await pause(750)
  }
  throw new Error('任务仍在后端运行，请稍后刷新查看结果。')
}

/** Daily research dashboard backed by independently settling user data. */
export function DashboardPage({ requestData, onAnalyze, onNavigate }: {
  requestData: RequestData
  onAnalyze: (prompt: string) => void
  onNavigate: (route: 'analysis' | 'portfolio' | 'strategy') => void
}) {
  const holdings = usePageResource(requestData, HOLDINGS_REQUEST)
  const alerts = usePageResource(requestData, ALERTS_REQUEST)
  const cards = usePageResource(requestData, CARDS_REQUEST)
  const matches = usePageResource(requestData, MATCHES_REQUEST)
  const profile = usePageResource(requestData, PROFILE_REQUEST)
  const [bucket, setBucket] = useState('all')
  const [feedback, setFeedback] = useState<Record<string, 'useful' | 'useless'>>({})
  const [feedbackBusy, setFeedbackBusy] = useState<Record<string, boolean>>({})
  const [feedbackError, setFeedbackError] = useState('')
  const [briefAction, setBriefAction] = useState<BusinessActionState>(IDLE_ACTION)

  const positions = arrayItems(holdings.value)
  const alertItems = arrayItems(alerts.value)
  const cardItems = arrayItems(cards.value)
  const matchItems = arrayItems(matches.value)
  const profileRecord = asRecord(profile.value)
  const filteredCards = cardItems.filter(item => bucket === 'all' || text(item.bucket, '') === bucket)
  const estimatedAssets = positions.reduce((total, item) => {
    const quantity = number(item.quantity) ?? 0
    const price = number(item.market_price) ?? number(item.current_price) ?? number(item.cost_price) ?? 0
    return total + quantity * price
  }, 0)
  const highAlerts = alertItems.filter(item => text(item.severity, '') === '高').length
  const profileLabel = text(profileRecord.label, text(profileRecord.risk_level, text(profileRecord.profile, '待完善')))

  const refresh = (): void => {
    holdings.refresh(); alerts.refresh(); cards.refresh(); matches.refresh(); profile.refresh()
  }

  const submitFeedback = (cardId: string, sentiment: 'useful' | 'useless'): void => {
    const previous = feedback[cardId]
    setFeedback(current => ({ ...current, [cardId]: sentiment }))
    setFeedbackBusy(current => ({ ...current, [cardId]: true }))
    setFeedbackError('')
    void requestData({
      operation: 'trading-core.personalized-feedback',
      input: { card_id: cardId, sentiment, meta: { surface: 'dashboard' } },
    }).catch(() => {
      setFeedback((current) => {
        if (previous === undefined) {
          return Object.fromEntries(Object.entries(current).filter(([key]) => key !== cardId))
        }
        return { ...current, [cardId]: previous }
      })
      setFeedbackError('反馈保存失败，请稍后重试。')
    }).finally(() => {
      setFeedbackBusy(current => ({ ...current, [cardId]: false }))
    })
  }

  const generatePreMarketBrief = (): void => {
    setBriefAction({ phase: 'running', message: '正在创建盘前简报任务…' })
    void runBackendTask(
      requestData,
      { operation: 'trading-core.brief-run', input: { period: 'pre_market', scope: 'all' } },
      (message) => { setBriefAction({ phase: 'running', message }) },
    ).then((result) => {
      const resultRecord = asRecord(result)
      setBriefAction({
        phase: 'done',
        message: text(resultRecord.summary, '盘前简报已由后端生成。'),
        result,
      })
    }, (reason: unknown) => {
      setBriefAction({ phase: 'error', message: errorText(reason) })
    })
  }

  return (
    <div className={css.pageScroll}>
      <PageHead title="研究工作台" description="集中查看与你有关的事件、风险和策略机会。">
        <button type="button" className={css.secondaryButton} onClick={refresh}>刷新</button>
        <button type="button" className={css.primaryButton} disabled={briefAction.phase === 'running'} onClick={generatePreMarketBrief}>{briefAction.phase === 'running' ? '生成中…' : '生成盘前简报'}</button>
      </PageHead>

      <ActionNotice state={briefAction} />

      <div className={css.v2StatGrid}>
        <Stat label="组合资产" value={holdings.loaded ? compactMoney(estimatedAssets) : '—'} note={`${positions.length} 只持仓`} />
        <Stat label="高优先级预警" value={alerts.loaded ? String(highAlerts) : '—'} note={`共 ${alertItems.length} 条`} {...(highAlerts > 0 ? { tone: 'negative' as const } : {})} />
        <Stat label="策略匹配" value={matches.loaded ? String(matchItems.length) : '—'} note="按当前画像排序" />
        <Stat label="当前画像" value={profile.loaded ? profileLabel : '—'} note="用于风险预算校准" />
      </div>

      <div className={css.v2MainSide}>
        <Panel title="与你相关的市场事件" subtitle="按持仓、自选与策略相关度排序">
          {feedbackError !== '' && <div className={css.v2InlineError} role="alert">{feedbackError}</div>}
          <div className={css.v2Tabs} role="group" aria-label="事件范围">
            {([
              ['all', '全部'], ['holdings', '持仓'], ['watchlist', '自选'], ['strategy', '策略'],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={bucket === value} className={bucket === value ? css.v2TabActive : undefined} onClick={() => { setBucket(value) }}>{label}</button>
            ))}
          </div>
          <LoadState resource={cards} empty="完成持仓与风险画像后，这里会出现与你相关的研究事件。" />
          {cards.loaded && filteredCards.map((item, index) => {
            const cardId = text(item.card_id, text(item.id, String(index)))
            const direction = text(item.direction, '中性')
            return (
              <article key={cardId} className={css.v2FeedCard}>
                <div className={css.v2FeedMeta}>
                  <span>{text(item.bucket, '市场')}</span>
                  <span data-tone={direction === '利好' ? 'positive' : direction === '利空' ? 'negative' : undefined}>{direction}</span>
                  {number(item.relevance_score) !== undefined && <span>相关度 {number(item.relevance_score)?.toFixed(0)}</span>}
                  <time>{text(item.time, text(item.ts, ''))}</time>
                </div>
                <h3>{text(item.title, '市场事件')}</h3>
                <p>{text(item.summary, text(item.detail, '暂无事件摘要'))}</p>
                <div className={css.v2ReasonList}>
                  {(Array.isArray(item.reasons) ? item.reasons : []).map((reason, reasonIndex) => (
                    <span key={reasonIndex}>{String(reason)}</span>
                  ))}
                </div>
                <div className={css.v2Feedback}>
                  <button type="button" disabled={feedbackBusy[cardId]} aria-pressed={feedback[cardId] === 'useful'} onClick={() => { submitFeedback(cardId, 'useful') }}>有用</button>
                  <button type="button" disabled={feedbackBusy[cardId]} aria-pressed={feedback[cardId] === 'useless'} onClick={() => { submitFeedback(cardId, 'useless') }}>没用</button>
                  <button type="button" onClick={() => { onAnalyze(`请展开分析这条市场事件及其对我当前持仓的影响：${text(item.title, '')}`) }}>深入研究</button>
                </div>
              </article>
            )
          })}
          {cards.loaded && filteredCards.length === 0 && <div className={css.v2Empty}>当前范围没有相关事件。</div>}
        </Panel>

        <div className={css.v2Stack}>
          <Panel title="风险预警" subtitle="优先处理高严重度事项">
            <LoadState resource={alerts} empty="当前没有风险预警。" />
            {alerts.loaded && alertItems.slice(0, 6).map((item, index) => (
              <article className={css.v2Alert} key={text(item.id, String(index))}>
                <i data-severity={text(item.severity, '低')} />
                <div><strong>{text(item.title, '风险提醒')}</strong><p>{text(item.detail, '')}</p></div>
              </article>
            ))}
            {alerts.loaded && alertItems.length === 0 && <div className={css.v2Good}>当前没有需要处理的风险预警</div>}
            <button type="button" className={css.v2TextButton} onClick={() => { onNavigate('portfolio') }}>查看我的投研 →</button>
          </Panel>
          <Panel title="策略匹配" subtitle="结合画像与分散化预算">
            <LoadState resource={matches} empty="暂无匹配策略。" />
            {matches.loaded && matchItems.slice(0, 3).map((item, index) => (
              <button key={text(item.strategy_id, String(index))} type="button" className={css.v2Match} onClick={() => { onNavigate('strategy') }}>
                <span><strong>{text(item.name, text(item.strategy_name, '策略'))}</strong><small>{text(item.match_reason, text(item.caution, '查看匹配详情'))}</small></span>
                <b>{number(item.match_score)?.toFixed(0) ?? '—'}</b>
              </button>
            ))}
          </Panel>
        </div>
      </div>
    </div>
  )
}

const ANALYSIS_CARDS = [
  { id: 'stock', title: '个股多智能体分析', note: '基本面、技术面、新闻与风险统一研判' },
  { id: 'holdings', title: '持仓风险分析', note: '从集中度、相关性与风险预算检查组合' },
  { id: 'brief', title: '市场简报', note: '盘前、盘中或盘后生成研究摘要' },
  { id: 'backtest', title: '历史决策回测', note: '复盘既有决策并检查风险收益表现' },
] as const

/** Entry page for long-running investment analysis workflows. */
export function AnalysisPage({ requestData, onAnalyze, onPortfolio }: {
  requestData: RequestData
  onAnalyze: (input: InvestmentAssistantActionInput) => void
  onPortfolio: () => void
}) {
  const [code, setCode] = useState('600519')
  const [depth, setDepth] = useState('standard')
  const [briefPeriod, setBriefPeriod] = useState<'pre_market' | 'now' | 'post_market'>('now')
  const [backtestWindow, setBacktestWindow] = useState(10)
  const [actions, setActions] = useState<Partial<Record<typeof ANALYSIS_CARDS[number]['id'], BusinessActionState>>>({})

  const run = (id: typeof ANALYSIS_CARDS[number]['id']): void => {
    const start = {
      stock: { operation: 'trading-core.analyze', input: { ticker: code.trim(), research_depth: depth } },
      holdings: { operation: 'trading-core.holdings-analyze', input: { mode: 'deep', use_saved: true } },
      brief: { operation: 'trading-core.brief-run', input: { period: briefPeriod, scope: 'all' } },
      backtest: {
        operation: 'trading-core.backtest-run',
        input: { ...(code.trim() === '' ? {} : { code: code.trim() }), eval_window_days: backtestWindow },
      },
    }[id] as InvestmentDataRequest
    setActions(current => ({ ...current, [id]: { phase: 'running', message: '正在创建后端分析任务…' } }))
    void runBackendTask(requestData, start, (message) => {
      setActions(current => ({ ...current, [id]: { phase: 'running', message } }))
    }).then((result) => {
      setActions(current => ({ ...current, [id]: { phase: 'done', message: '后端分析已完成，结果已返回当前页面。', result } }))
    }, (reason: unknown) => {
      setActions(current => ({ ...current, [id]: { phase: 'error', message: errorText(reason) } }))
    })
  }

  return (
    <div className={css.pageScroll}>
      <PageHead title="智能分析" description="通过后端任务完成个股、持仓、简报与历史决策分析，结果保留在当前页面。" />
      <div className={css.v2AnalysisGrid}>
        {ANALYSIS_CARDS.map((card) => {
          const action = actions[card.id] ?? IDLE_ACTION
          const result = asRecord(action.result)
          const signal = asRecord(result.signal)
          const summary = asRecord(result.summary)
          const detail = card.id === 'brief'
            ? text(result.summary, text(signal.summary, '简报已生成。'))
            : card.id === 'stock'
              ? text(signal.reasoning, text(result.summary, '个股分析已完成。'))
              : card.id === 'holdings'
                ? strings(signal.rebalance_suggestions)[0] ?? '持仓风险分析已完成。'
                : `已评估 ${number(summary.evaluated_count) ?? number(result.evaluated_count) ?? 0} 条历史决策。`
          return <Panel key={card.id} title={card.title} subtitle={card.note}>
            {card.id === 'stock' && (
              <div className={css.v2FormGrid}>
                <label><span>股票代码</span><input value={code} onChange={(event) => { setCode(event.target.value) }} /></label>
                <label><span>研究深度</span><select value={depth} onChange={(event) => { setDepth(event.target.value) }}><option value="quick">快速</option><option value="standard">标准</option><option value="deep">深度</option><option value="full">完整</option></select></label>
              </div>
            )}
            {card.id === 'holdings' && <div className={css.v2Callout}>使用“我的投研”中已保存的持仓与当前风险画像。</div>}
            {card.id === 'brief' && <div className={css.v2ChoiceRow}>{([['pre_market', '盘前'], ['now', '盘中'], ['post_market', '盘后']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={briefPeriod === value} onClick={() => { setBriefPeriod(value) }}>{label}</button>)}</div>}
            {card.id === 'backtest' && <div className={css.v2FormGrid}><label><span>股票代码（可留空）</span><input value={code} onChange={(event) => { setCode(event.target.value) }} /></label><label><span>前瞻窗口</span><select value={backtestWindow} onChange={(event) => { setBacktestWindow(Number(event.target.value)) }}><option value="5">5 个交易日</option><option value="10">10 个交易日</option><option value="20">20 个交易日</option><option value="60">60 个交易日</option></select></label></div>}
            <ActionNotice state={action} />
            {action.phase === 'done' && (
              <div className={css.v2AnalysisResult}>
                <strong>{card.id === 'stock' ? text(signal.action, '分析完成') : card.id === 'holdings' ? `组合风险 ${number(signal.weighted_risk_score)?.toFixed(2) ?? '已计算'}` : card.id === 'brief' ? '简报已生成' : '回测已完成'}</strong>
                <p>{detail}</p>
                <button type="button" className={css.v2TextButton} onClick={() => { onAnalyze({ intent: `analysis.${card.id}.interpret`, module: 'analysis', question: `解读本次${card.title}结果，说明关键结论、风险与下一步。`, data: { task: card.id, parameters: { code, depth, briefPeriod, backtestWindow }, result: action.result } }) }}>让投研助理解读结果 →</button>
              </div>
            )}
            <div className={css.v2ActionRow}>
              {card.id === 'holdings' && <button type="button" className={css.secondaryButton} onClick={onPortfolio}>查看持仓</button>}
              <button type="button" className={css.primaryButton} disabled={action.phase === 'running' || (card.id === 'stock' && code.trim() === '')} onClick={() => { run(card.id) }}>{action.phase === 'running' ? '运行中…' : card.id === 'brief' ? '生成简报' : card.id === 'backtest' ? '运行回测' : '开始分析'}</button>
            </div>
          </Panel>
        })}
      </div>
      <Panel title="分析任务" subtitle="每类任务在当前页面独立保留状态">
        <div className={css.v2TaskList}>{ANALYSIS_CARDS.map((card) => {
          const state = actions[card.id] ?? IDLE_ACTION
          return <div key={card.id}><span>{card.title}</span><strong data-phase={state.phase}>{state.phase === 'idle' ? '尚未运行' : state.phase === 'running' ? '运行中' : state.phase === 'done' ? '已完成' : '失败'}</strong></div>
        })}</div>
      </Panel>
    </div>
  )
}

/** Strategy pool and event-to-hypothesis workflow. */
export function StrategyPage({ requestData, onAnalyze: _onAnalyze }: { requestData: RequestData; onAnalyze: (prompt: string) => void }) {
  const strategies = usePageResource(requestData, STRATEGIES_REQUEST)
  const events = usePageResource(requestData, EVENTS_REQUEST)
  const [filter, setFilter] = useState('all')
  const [hypotheses, setHypotheses] = useState<Record<string, unknown>[]>([])
  const [hypothesisAction, setHypothesisAction] = useState<BusinessActionState>(IDLE_ACTION)
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [selectedStrategy, setSelectedStrategy] = useState<Record<string, unknown> | null>(null)
  const [strategyAction, setStrategyAction] = useState<BusinessActionState>(IDLE_ACTION)
  const rows = arrayItems(strategies.value)
  const filtered = rows.filter(row => filter === 'all' || text(row.status, '') === filter)
  const eventCount = arrayItems(events.value).length

  const hypothesize = (dryRun: boolean): void => {
    setHypothesisAction({ phase: 'running', message: dryRun ? '正在调用后端生成假设预览…' : '正在生成候选策略并写入策略池…' })
    void requestData({
      operation: 'trading-core.strategies-hypothesize',
      input: { limit: eventCount || 20, dry_run: dryRun },
    }).then((value) => {
      const result = asRecord(value)
      const nextHypotheses = records(result.hypotheses)
      const candidates = Array.isArray(result.candidates) ? result.candidates.map(String) : []
      setHypotheses(nextHypotheses)
      setConfirmCreate(dryRun && nextHypotheses.length > 0)
      setHypothesisAction({
        phase: 'done',
        message: text(result.note, dryRun
          ? `已从 ${number(result.n_events)?.toFixed(0) ?? eventCount} 条事件生成 ${nextHypotheses.length} 条假设预览，尚未写入策略池。`
          : `已写入 ${candidates.length} 个去重后的候选策略。`),
        result: value,
      })
      if (!dryRun) strategies.refresh()
    }, (reason: unknown) => {
      setHypothesisAction({ phase: 'error', message: errorText(reason) })
    })
  }

  const openStrategy = (strategyId: string): void => {
    setStrategyAction({ phase: 'running', message: '正在读取策略详情…' })
    void requestData({ operation: 'trading-core.strategy-detail', input: { strategy_id: strategyId } }).then((value) => {
      setSelectedStrategy(asRecord(value))
      setStrategyAction(IDLE_ACTION)
    }, (reason: unknown) => {
      setStrategyAction({ phase: 'error', message: errorText(reason) })
    })
  }

  const runStrategy = (): void => {
    const strategyId = text(selectedStrategy?.strategy_id, text(selectedStrategy?.id, ''))
    if (strategyId === '') return
    setStrategyAction({ phase: 'running', message: '正在创建样本外回测任务…' })
    void runBackendTask(
      requestData,
      { operation: 'trading-core.strategy-run', input: { strategy_id: strategyId } },
      (message) => { setStrategyAction({ phase: 'running', message }) },
    ).then(() => {
      setStrategyAction({ phase: 'done', message: '策略回测完成，策略状态和指标已刷新。' })
      strategies.refresh()
      openStrategy(strategyId)
    }, (reason: unknown) => {
      setStrategyAction({ phase: 'error', message: errorText(reason) })
    })
  }

  const transitionStrategy = (action: 'activate' | 'reject' | 'retire'): void => {
    const strategyId = text(selectedStrategy?.strategy_id, text(selectedStrategy?.id, ''))
    if (strategyId === '') return
    setStrategyAction({ phase: 'running', message: '正在更新策略状态…' })
    void requestData({ operation: 'trading-core.strategy-action', input: { strategy_id: strategyId, action } }).then(() => {
      setStrategyAction({ phase: 'done', message: '策略状态已更新。' })
      strategies.refresh()
      openStrategy(strategyId)
    }, (reason: unknown) => {
      setStrategyAction({ phase: 'error', message: errorText(reason) })
    })
  }

  return (
    <div className={css.pageScroll}>
      <PageHead title="策略研究" description="把结构化事件转化为投资假设，并完成回测与状态管理。">
        <button type="button" className={css.secondaryButton} disabled={hypothesisAction.phase === 'running'} onClick={() => { hypothesize(true) }}>预览投资假设</button>
        <button type="button" className={css.primaryButton} disabled={hypothesisAction.phase === 'running'} onClick={() => { setConfirmCreate(true) }}>生成候选策略</button>
      </PageHead>
      <ActionNotice state={hypothesisAction} />
      {confirmCreate && (
        <section className={css.v2Confirm} role="dialog" aria-label="确认生成候选策略">
          <div><strong>确认写入候选策略池？</strong><p>后端会重新读取最近 {eventCount || 20} 条事件、生成并校验假设，并按事件、类型和标的去重后写入。</p></div>
          <button type="button" className={css.secondaryButton} onClick={() => { setConfirmCreate(false) }}>取消</button>
          <button type="button" className={css.primaryButton} onClick={() => { setConfirmCreate(false); hypothesize(false) }}>确认生成并入池</button>
        </section>
      )}
      <div className={css.v2Pipeline} aria-label="策略研究流程">
        {['市场事件', '投资假设', '样本外回测', '画像匹配', '影子验证', '自进化'].map((label, index) => <span key={label} data-active={index <= 2 ? 'true' : undefined}><b>{index + 1}</b>{label}</span>)}
      </div>
      {hypotheses.length > 0 && (
        <Panel title="投资假设预览" subtitle={`${hypotheses.length} 条 · 预览不会写入策略池`}>
          <div className={css.v2HypothesisList}>{hypotheses.map((item, index) => (
            <article key={`${text(item.event_idx, String(index))}-${index}`}>
              <div><span>{text(item.direction, '中性')}</span><strong>{text(item.kind, '策略假设')}</strong><small>{Array.isArray(item.symbols) ? item.symbols.join(' · ') : '未识别标的'}</small></div>
              <p>{text(item.rationale, '暂无假设说明')}</p>
              <small>建议持有 {number(item.holding_window_days)?.toFixed(0) ?? '—'} 天</small>
            </article>
          ))}</div>
        </Panel>
      )}
      <Panel title="策略池" subtitle={strategies.loaded ? `${rows.length} 个策略` : '正在读取策略'}>
        <div className={css.v2Tabs} role="group" aria-label="策略状态">
          {([
            ['all', '全部'], ['candidate', '候选'], ['active', '活跃'], ['watch', '观察'], ['rejected', '拒绝'], ['retired', '退役'],
          ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? css.v2TabActive : undefined} onClick={() => { setFilter(value) }}>{label}</button>)}
        </div>
        <LoadState resource={strategies} empty="策略池为空，可先从市场事件生成候选策略。" />
        {strategies.loaded && filtered.length > 0 && (
          <div className={css.v2TableWrap}>
            <table><thead><tr><th>策略</th><th>类型 / 标的</th><th>状态</th><th>样本外胜率</th><th>交易数</th><th /></tr></thead><tbody>
              {filtered.map((row, index) => (
                <tr key={text(row.strategy_id, text(row.id, String(index)))}>
                  <td><strong>{text(row.name, '未命名策略')}</strong><small>{text(row.strategy_id, text(row.id, ''))}</small></td>
                  <td>{text(row.kind, '—')}<small>{Array.isArray(row.symbols) ? row.symbols.join(' · ') : text(row.symbols, '')}</small></td>
                  <td><span className={css.v2Status} data-status={text(row.status, '')}>{text(row.status, '—')}</span></td>
                  <td>{percent(asRecord(row.backtest).oos_win_rate ?? row.oos_win_rate)}</td>
                  <td>{number(asRecord(row.backtest).oos_trades ?? row.trades)?.toFixed(0) ?? '—'}</td>
                  <td><button type="button" className={css.secondaryButton} onClick={() => { openStrategy(text(row.strategy_id, text(row.id, ''))) }}>详情</button></td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
        {strategies.loaded && filtered.length === 0 && <div className={css.v2Empty}>当前状态没有策略。</div>}
      </Panel>
      {selectedStrategy !== null && (
        <Panel title={text(selectedStrategy.name, '策略详情')} subtitle={text(selectedStrategy.strategy_id, text(selectedStrategy.id, ''))}>
          <ActionNotice state={strategyAction} />
          <div className={css.v2DetailGrid}>
            <div><span>投资假设</span><p>{text(selectedStrategy.hypothesis, '暂无')}</p></div>
            <div><span>类型</span><strong>{text(selectedStrategy.kind, '—')}</strong></div>
            <div><span>状态</span><strong>{text(selectedStrategy.status, '—')}</strong></div>
            <div><span>标的</span><strong>{Array.isArray(selectedStrategy.symbols) ? selectedStrategy.symbols.join(' · ') : '—'}</strong></div>
          </div>
          <div className={css.v2ActionRow}>
            <button type="button" className={css.primaryButton} disabled={strategyAction.phase === 'running'} onClick={runStrategy}>运行样本外回测</button>
            <button type="button" className={css.secondaryButton} disabled={strategyAction.phase === 'running'} onClick={() => { transitionStrategy('activate') }}>激活</button>
            <button type="button" className={css.secondaryButton} disabled={strategyAction.phase === 'running'} onClick={() => { transitionStrategy('reject') }}>拒绝</button>
            <button type="button" className={css.secondaryButton} disabled={strategyAction.phase === 'running'} onClick={() => { transitionStrategy('retire') }}>退役</button>
          </div>
        </Panel>
      )}
    </div>
  )
}

function equityPoints(rows: Record<string, unknown>[]): string {
  const values = [...rows]
    .reverse()
    .map(row => number(row.overall_nav) ?? number(row.nav))
    .filter((value): value is number => value !== undefined)
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  return values.map((value, index) => `${(index / (values.length - 1)) * 100},${92 - ((value - min) / range) * 72}`).join(' ')
}

/** Shadow validation overview with real status, positions, and equity history. */
export function ShadowPage({ requestData, onAnalyze: _onAnalyze }: { requestData: RequestData; onAnalyze: (prompt: string) => void }) {
  const status = usePageResource(requestData, SHADOW_STATUS_REQUEST)
  const positions = usePageResource(requestData, SHADOW_POSITIONS_REQUEST)
  const equity = usePageResource(requestData, SHADOW_EQUITY_REQUEST)
  const [runAction, setRunAction] = useState<BusinessActionState>(IDLE_ACTION)
  const statusRecord = asRecord(status.value)
  const positionRows = arrayItems(positions.value)
  const equityRows = arrayItems(equity.value)
  const points = equityPoints(equityRows)
  const latest = equityRows[0]
  const latestNav = number(latest?.overall_nav) ?? number(statusRecord.overall_nav)

  const runShadow = (): void => {
    setRunAction({ phase: 'running', message: '正在创建今日影子验证任务…' })
    void runBackendTask(
      requestData,
      { operation: 'trading-core.shadow-run', input: { force: false } },
      (message) => { setRunAction({ phase: 'running', message }) },
    ).then((result) => {
      const record = asRecord(result)
      setRunAction({ phase: 'done', message: text(record.note, '今日影子验证已完成，净值与持仓已刷新。'), result })
      status.refresh(); positions.refresh(); equity.refresh()
    }, (reason: unknown) => {
      setRunAction({ phase: 'error', message: errorText(reason) })
    })
  }

  return (
    <div className={css.pageScroll}>
      <PageHead title="影子验证" description="跟踪活跃策略的逐日模拟持仓、净值和运行状态。">
        <button type="button" className={css.secondaryButton} onClick={() => { status.refresh(); positions.refresh(); equity.refresh() }}>刷新</button>
        <button type="button" className={css.primaryButton} disabled={runAction.phase === 'running'} onClick={runShadow}>{runAction.phase === 'running' ? '运行中…' : '运行今日影子验证'}</button>
      </PageHead>
      <ActionNotice state={runAction} />
      <div className={css.v2StatGrid}>
        <Stat label="整体净值" value={latestNav?.toFixed(3) ?? '—'} note={text(latest?.date, text(statusRecord.trade_date, '暂无记录'))} />
        <Stat label="运行策略" value={String(number(statusRecord.strategy_count) ?? number(statusRecord.strategies) ?? '—')} note="活跃状态" />
        <Stat label="影子持仓" value={positions.loaded ? String(positionRows.length) : '—'} note="按策略与代码统计" />
        <Stat label="最近运行" value={text(statusRecord.trade_date, text(statusRecord.as_of, '—'))} note={text(statusRecord.note, text(statusRecord.status, '等待运行'))} />
      </div>
      <Panel title="影子净值曲线" subtitle="历史净值随数据返回逐步更新">
        <LoadState resource={equity} empty="运行影子验证后，这里会展示净值历史。" />
        {equity.loaded && points !== '' && (
          <div className={css.v2Chart}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="影子净值曲线"><polyline points={points} /></svg>
          </div>
        )}
        {equity.loaded && points === '' && <div className={css.v2Empty}>净值记录不足，至少需要两个交易日才能绘制曲线。</div>}
      </Panel>
      <Panel title="当前影子持仓" subtitle={positions.loaded ? `${positionRows.length} 项` : '正在读取'}>
        <LoadState resource={positions} />
        {positions.loaded && positionRows.length > 0 && (
          <div className={css.v2TableWrap}><table><thead><tr><th>策略</th><th>代码</th><th>方向</th><th>数量</th><th>成本</th></tr></thead><tbody>{positionRows.map((row, index) => <tr key={`${text(row.strategy_id, '')}-${text(row.ticker, text(row.code, String(index)))}`}><td>{text(row.strategy_name, text(row.strategy_id))}</td><td>{text(row.ticker, text(row.code))}</td><td>{text(row.side, text(row.direction))}</td><td>{number(row.quantity)?.toLocaleString('zh-CN') ?? '—'}</td><td>{money(row.cost_price)}</td></tr>)}</tbody></table></div>
        )}
      </Panel>
    </div>
  )
}

/** Evolution readiness and strategy attribution overview. */
export function EvolutionPage({ requestData, onAnalyze: _onAnalyze }: { requestData: RequestData; onAnalyze: (prompt: string) => void }) {
  const status = usePageResource(requestData, EVOLUTION_STATUS_REQUEST)
  const attribution = usePageResource(requestData, EVOLUTION_ATTRIBUTION_REQUEST)
  const [evolutionAction, setEvolutionAction] = useState<BusinessActionState>(IDLE_ACTION)
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  const [confirmApply, setConfirmApply] = useState(false)
  const statusRecord = asRecord(status.value)
  const attributionRecord = asRecord(attribution.value)
  const overall = asRecord(attributionRecord.overall)
  const rows = records(attributionRecord.strategies)
  const ready = statusRecord.ready === true
  const days = number(statusRecord.days_of_data) ?? number(attributionRecord.days_of_data)
  const minDays = number(statusRecord.min_days) ?? number(attributionRecord.min_days)
  const actions = preview === null ? [] : records(preview.actions)

  const runEvolution = (apply: boolean): void => {
    setEvolutionAction({ phase: 'running', message: apply ? '正在应用本轮自进化动作…' : '正在由后端计算本轮动作预览…' })
    void requestData({ operation: 'trading-core.evolution-run', input: { apply } }).then((value) => {
      const result = asRecord(value)
      setPreview(result)
      setConfirmApply(false)
      const waiting = text(result.status, '') === 'waiting_data'
      setEvolutionAction({
        phase: 'done',
        message: waiting
          ? text(result.note, `影子数据不足（${number(result.days_of_data) ?? 0}/${number(result.min_days) ?? '—'} 天），本轮不会修改策略池。`)
          : apply ? `已应用 ${records(result.actions).length} 项策略动作。` : `已生成 ${records(result.actions).length} 项动作预览，尚未修改策略池。`,
        result: value,
      })
      if (apply) {
        status.refresh(); attribution.refresh()
      }
    }, (reason: unknown) => {
      setEvolutionAction({ phase: 'error', message: errorText(reason) })
    })
  }

  return (
    <div className={css.pageScroll}>
      <PageHead title="自进化" description="先检查业绩归因，再预览策略动作，确认后才应用变化。">
        <button type="button" className={css.secondaryButton} disabled={!ready || evolutionAction.phase === 'running'} onClick={() => { runEvolution(false) }}>预览本轮动作</button>
        <button type="button" className={css.primaryButton} disabled={!ready || actions.length === 0 || evolutionAction.phase === 'running'} onClick={() => { setConfirmApply(true) }}>确认并应用</button>
      </PageHead>
      <ActionNotice state={evolutionAction} />
      {confirmApply && (
        <section className={css.v2Confirm} role="dialog" aria-label="确认应用自进化动作">
          <div><strong>确定应用这 {actions.length} 项动作？</strong><p>这会写入策略池，可能升级、降级或退役策略，并生成待重新回测的变异候选。</p></div>
          <button type="button" className={css.secondaryButton} onClick={() => { setConfirmApply(false) }}>取消</button>
          <button type="button" className={css.primaryButton} onClick={() => { runEvolution(true) }}>确认写入策略池</button>
        </section>
      )}
      <div className={css.v2StatGrid3}>
        <Stat label="影子数据" value={days === undefined ? '—' : `${days} 天`} note={minDays === undefined ? '等待就绪检查' : ready ? `已满足至少 ${minDays} 天` : `还需 ${Math.max(0, minDays - (days ?? 0))} 天`} />
        <Stat label="策略累计收益" value={percent(overall.return_pct)} note={`最大回撤 ${percent(overall.max_drawdown_pct)}`} tone={(number(overall.return_pct) ?? 0) >= 0 ? 'positive' : 'negative'} />
        <Stat label="可执行状态" value={ready ? '已就绪' : '等待数据'} note={text(statusRecord.note, '预览后方可确认应用')} />
      </div>
      <Panel title="策略业绩归因" subtitle="比较收益、回撤、平仓数量与胜率">
        <LoadState resource={attribution} empty="影子数据积累后会生成策略归因。" />
        {attribution.loaded && rows.length > 0 && (
          <div className={css.v2TableWrap}><table><thead><tr>
            <th>策略</th><th>收益</th><th>最大回撤</th><th>已平仓</th><th>胜率</th><th>判断</th>
          </tr></thead><tbody>{rows.map((row, index) => {
            const returnPct = number(row.return_pct)
            return <tr key={text(row.strategy_id, String(index))}><td><strong>{text(row.name, '策略')}</strong><small>{text(row.strategy_id, '')}</small></td><td className={returnPct !== undefined && returnPct < 0 ? css.negative : css.positive}>{percent(row.return_pct)}</td><td>{percent(row.max_drawdown_pct)}</td><td>{number(row.closed_count)?.toFixed(0) ?? number(row.closed_trades)?.toFixed(0) ?? '—'}</td><td>{percent(row.win_rate_pct ?? row.closed_win_rate_pct)}</td><td><span className={css.v2Status} data-status={text(row.status, '')}>{text(row.status, '待评估')}</span></td></tr>
          })}</tbody></table></div>
        )}
      </Panel>
      <Panel title="本轮动作预览" subtitle="预览不会修改策略池">
        {!ready && <div className={css.v2Empty}>数据尚未满足自进化要求；请先持续运行每日影子验证，达到最少交易日后再预览。</div>}
        {ready && preview === null && <div className={css.v2Empty}>点击“预览本轮动作”，后端会按影子净值、回撤、胜率和冷却期计算升级、降级、淘汰与变异。</div>}
        {ready && preview !== null && actions.length === 0 && <div className={css.v2Good}>本轮没有满足阈值的策略动作，策略池不会改变。</div>}
        {actions.length > 0 && <div className={css.v2EvolutionList}>{actions.map((action, index) => {
          const kind = text(action.type, 'unknown')
          const labels: Record<string, string> = { promote: '升级', demote: '降级观察', retire: '淘汰', mutate: '变异回流' }
          return <article key={`${kind}-${text(action.sid, text(action.parent, String(index)))}`} data-action={kind}>
            <span>{labels[kind] ?? kind}</span>
            <div><strong>{text(action.name, text(action.sid, text(action.parent, '策略动作')))}</strong><p>{text(action.reason, '后端未返回原因')}</p></div>
            <small>{text(action.from, '')}{text(action.to, '') === '' ? '' : ` → ${text(action.to, '')}`}</small>
          </article>
        })}</div>}
      </Panel>
    </div>
  )
}

/** Industry-chain query entry that keeps unsupported graph data out of the browser. */
export function ChainPage({ onAnalyze }: { onAnalyze: (prompt: string) => void }) {
  const [query, setQuery] = useState('')
  const submit = (): void => {
    const normalized = query.trim()
    if (normalized !== '') onAnalyze(`请查询 ${normalized} 的产业链，展示公司档案、上游供应、材料设备、主营产品、下游客户和关键风险。`)
  }

  return (
    <div className={css.pageScroll}>
      <PageHead title="产业链" description="从公司出发梳理供应商、材料设备、主营产品与下游客户。">
        <button type="button" className={css.secondaryButton} disabled={query.trim() === ''} onClick={() => { onAnalyze(`请查询 ${query.trim()} 的多层上下游产业链，并标明每层关系。`) }}>展开上下游</button>
        <button type="button" className={css.primaryButton} onClick={() => { onAnalyze('请展示当前产业链图谱的全局网络，并按重要度提炼核心节点。') }}>全局网络</button>
      </PageHead>
      <Panel title="公司检索" subtitle="输入公司名称、代码或行业">
        <form className={css.v2SearchForm} onSubmit={(event) => { event.preventDefault(); submit() }}>
          <input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder="例如：中芯国际 / 688981 / 半导体" aria-label="搜索公司、代码或行业" />
          <button type="submit" className={css.primaryButton} disabled={query.trim() === ''}>搜索</button>
        </form>
      </Panel>
      <Panel title="单公司产业链" subtitle="供应商 → 材料 / 设备 → 研究标的 → 主营产品 → 下游客户">
        <div className={css.v2Chain}>
          {['供应商', '材料 / 设备', '研究标的', '主营产品', '下游客户 / 应用'].map((label, index) => (
            <div key={label} data-center={index === 2 ? 'true' : undefined}>
              <span>{label}</span>
              <button type="button" disabled>{index === 2 ? '等待选择公司' : '—'}</button>
              <button type="button" disabled>{index === 2 ? '输入名称或代码' : '—'}</button>
            </div>
          ))}
        </div>
        <div className={css.v2Empty}>选择公司后，投研助理会读取真实产业链数据并展示关键关系。</div>
      </Panel>
    </div>
  )
}
