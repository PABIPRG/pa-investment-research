import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantIntent } from './assistant-intent.ts'
import { asRecord, money, number, records, text } from './data.ts'
import { TASK_CANCELLED, taskId, waitForTask } from './task-client.ts'
import css from './InvestmentShell.module.css'

export type InvestmentRequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface DataState {
  readonly phase: 'loading' | 'success' | 'error'
  readonly value: unknown
  readonly error: string
}

function useDataResource(requestData: InvestmentRequestData) {
  const generation = useRef(0)
  const settledKey = useRef('')
  const flights = useRef(new Map<string, Promise<unknown>>())
  const [state, setState] = useState<DataState>({ phase: 'loading', value: undefined, error: '' })
  useEffect(() => () => { generation.current += 1 }, [])
  const run = useCallback((request: InvestmentDataRequest): void => {
    const key = JSON.stringify(request)
    const current = ++generation.current
    setState(previous => ({
      phase: 'loading',
      value: settledKey.current === key ? previous.value : undefined,
      error: '',
    }))
    let flight = flights.current.get(key)
    if (flight === undefined) {
      flight = Promise.resolve().then(() => requestData(request))
      flights.current.set(key, flight)
      void flight.then(
        () => { if (flights.current.get(key) === flight) flights.current.delete(key) },
        () => { if (flights.current.get(key) === flight) flights.current.delete(key) },
      )
    }
    void flight.then(
      (value) => {
        if (current === generation.current) {
          settledKey.current = key
          setState({ phase: 'success', value, error: '' })
        }
      },
      (reason: unknown) => {
        if (current === generation.current) {
          setState(previous => ({
            phase: 'error',
            value: settledKey.current === key ? previous.value : undefined,
            error: errorText(reason),
          }))
        }
      },
    )
  }, [requestData])
  return { state, run }
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
}

function tickerLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return item.trim() === '' ? [] : [item.trim()]
    const ticker = asRecord(item)
    const code = text(ticker.code, '').trim()
    const name = text(ticker.name, '').trim()
    if (code !== '' && name !== '') return [`${name}（${code}）`]
    return code !== '' ? [code] : name !== '' ? [name] : []
  })
}

function useAliveRef() {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  return alive
}

function PageHeading({
  title, description, children,
}: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className={css.pageHeader}>
      <div><h1>{title}</h1><p>{description}</p></div>
      <div>{children}</div>
    </div>
  )
}

function DataError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className={css.errorCard} role="alert">
      <div><strong>真实数据暂不可用</strong><p>{message}</p></div>
      <button type="button" onClick={retry}>重试</button>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div className={css.emptyPanel}>{children}</div>
}

function BusyRows() {
  return <div className={css.loadingSkeleton} aria-hidden="true"><span /><span /><span /></div>
}

function StatusBadge({ value }: { value: string }) {
  return <span className={css.statusBadge} data-status={value}>{statusLabel(value)}</span>
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    candidate: '候选', active: '生效中', rejected: '已拒绝', retired: '已退役',
    pending: '等待中', running: '运行中', done: '已完成', failed: '失败',
    waiting_data: '等待数据', preview: '待确认', applied: '已应用',
    promote: '升级', demote: '降级观察', retire: '退役', mutate: '生成变体', ready: '就绪',
  }
  return labels[value] ?? (value === '' ? '未知' : value)
}

function compactMetric(value: unknown, suffix = ''): string {
  const numeric = number(value)
  return numeric === undefined ? '—' : `${numeric.toFixed(2)}${suffix}`
}

function reportKindLabel(value: unknown): string {
  const kind = text(value, '')
  return {
    stock: '个股分析', holdings: '持仓分析', brief: '市场简报',
    backtest: '历史回测', strategy: '策略研究', shadow: '影子验证',
  }[kind] ?? (kind === '' ? '投研分析' : kind)
}

function reportTimeLabel(value: unknown): string {
  const raw = text(value, '')
  if (raw === '') return '—'
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(parsed)
}

interface StrategyResearchPageProps {
  readonly requestData: InvestmentRequestData
  readonly selectedStrategyId: string
  readonly onSelectStrategy: (strategyId: string) => void
  readonly onOpenShadow: (strategyId: string) => void
  readonly onAnalyze: (intent: AssistantIntent) => void
}

/** Event hypotheses, evidence and lifecycle decisions backed by the strategy store. */
export function StrategyResearchPage({
  requestData, selectedStrategyId, onSelectStrategy, onOpenShadow, onAnalyze,
}: StrategyResearchPageProps) {
  const strategies = useDataResource(requestData)
  const alive = useAliveRef()
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(() => {
    strategies.run({ operation: 'trading-core.strategies', input: { limit: 50 } })
  }, [strategies.run])
  useEffect(load, [load])
  const items = records(asRecord(strategies.state.value).items)

  const hypothesize = async (): Promise<void> => {
    if (busyAction !== '') return
    setBusyAction('hypothesize'); setNotice('正在从真实事件生成假设…')
    try {
      const result = asRecord(await requestData({
        operation: 'trading-core.strategies-hypothesize', input: { limit: 20, dry_run: false },
      }))
      if (!alive.current) return
      const count = Array.isArray(result.candidates) ? result.candidates.length : 0
      setNotice(count > 0 ? `已生成 ${count} 个候选策略。` : text(result.note, '本轮没有生成新候选。'))
      load()
    } catch (reason) {
      if (alive.current) setNotice(`生成失败：${errorText(reason)}`)
    } finally {
      if (alive.current) setBusyAction('')
    }
  }

  const runStrategy = async (strategyId: string): Promise<void> => {
    if (busyAction !== '') return
    setBusyAction(`run:${strategyId}`); setNotice('正在启动样本内与样本外回测…')
    try {
      const started = await requestData({
        operation: 'trading-core.strategy-run',
        input: { strategy_id: strategyId, lookback_years: 2, oos_frac: 0.3, min_oos_trades: 4 },
      })
      const id = taskId(started)
      if (id === '') throw new Error('后端没有返回任务编号')
      const result = await waitForTask(
        requestData,
        id,
        (label) => { if (alive.current) setNotice(label) },
        () => alive.current,
      )
      if (result === TASK_CANCELLED) return
      const resultRecord = asRecord(result)
      const archived = Object.keys(asRecord(resultRecord.reports)).length > 0
      setNotice(archived
        ? '回测完成，正式结果已进入投研报告。'
        : '回测完成，但本次结果没有生成可归档报告。')
      load()
    } catch (reason) {
      if (alive.current) setNotice(errorText(reason))
    } finally {
      if (alive.current) setBusyAction('')
    }
  }

  const activate = async (strategyId: string): Promise<void> => {
    if (busyAction !== '') return
    setBusyAction(`activate:${strategyId}`); setNotice('正在更新策略生命周期…')
    try {
      await requestData({
        operation: 'trading-core.strategy-transition', input: { strategy_id: strategyId, action: 'activate' },
      })
      if (!alive.current) return
      setNotice('策略已进入生效状态，可以开始影子验证。')
      load()
    } catch (reason) {
      if (alive.current) setNotice(`状态更新失败：${errorText(reason)}`)
    } finally {
      if (alive.current) setBusyAction('')
    }
  }

  return (
    <div className={css.pageScroll}>
      <PageHeading title="策略研究" description="把真实事件转成可证伪假设，用样本外回测决定是否进入影子验证">
        <button type="button" className={css.secondaryButton} disabled={busyAction !== ''} onClick={load}>刷新</button>
        <button type="button" className={css.primaryButton} disabled={busyAction !== ''} onClick={() => { void hypothesize() }}>
          {busyAction === 'hypothesize' ? '生成中…' : '从事件生成候选'}
        </button>
      </PageHeading>
      <div className={css.lifecycleStrip} aria-label="策略生命周期">
        <span>事件与假设</span><b aria-hidden="true">→</b><span>样本外回测</span><b aria-hidden="true">→</b><span>影子验证</span><b aria-hidden="true">→</b><span>进化观察</span>
      </div>
      <div className={css.contextHint}>页面只保存策略标识；AI 评审时会通过 investment_context 工具读取当前策略上下文。</div>
      {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
      {strategies.state.phase === 'loading' && strategies.state.value === undefined && <BusyRows />}
      {strategies.state.phase === 'error' && <DataError message={strategies.state.error} retry={load} />}
      {strategies.state.phase !== 'error' && items.length === 0 && strategies.state.phase === 'success' && (
        <Empty>策略池尚无真实候选。先从事件生成假设，生成过程可能需要几十秒。</Empty>
      )}
      <section className={css.moduleGrid} aria-label="策略候选池">
        {items.map((item, index) => {
          const id = text(item.id, `strategy-${index}`)
          const status = text(item.status, 'candidate')
          const backtest = asRecord(item.backtest)
          const hasBacktest = Object.keys(backtest).length > 0
          const outOfSample = asRecord(backtest.out_of_sample)
          const outOfSampleTrades = number(outOfSample.trades) ?? number(outOfSample.n_evaluated)
          const selected = selectedStrategyId === id
          return (
            <article key={id} className={`${css.moduleCard} ${selected ? css.reportItemActive : ''}`}>
              <div className={css.sectionHeading}>
                <div><strong>{text(item.name, id)}</strong><small>{text(item.kind, '未标注策略类型')}</small></div>
                <StatusBadge value={status} />
              </div>
              <p>{text(item.hypothesis, text(item.thesis, '策略假设由后端策略库维护。'))}</p>
              <dl className={css.reportMeta}>
                <div><dt>方向</dt><dd>{text(item.direction)}</dd></div>
                <div><dt>标的数</dt><dd>{strings(item.symbols).length || '—'}</dd></div>
                <div><dt>样本外胜率</dt><dd>{compactMetric(outOfSample.win_rate_pct, '%')}</dd></div>
                <div><dt>样本外交易</dt><dd>{outOfSampleTrades?.toFixed(0) ?? '—'}</dd></div>
              </dl>
              {hasBacktest && text(backtest.reason, '') !== '' && (
                <p className={css.contextHint}>回测结论：{text(backtest.reason)}</p>
              )}
              <div className={css.moduleToolbar}>
                <button type="button" className={css.secondaryButton} disabled={busyAction !== ''} onClick={() => { onSelectStrategy(id); void runStrategy(id) }}>
                  {busyAction === `run:${id}` ? '回测中…' : '运行回测'}
                </button>
                {status === 'candidate' && (
                  <button type="button" className={css.secondaryButton} disabled={busyAction !== '' || !hasBacktest} title={hasBacktest ? '人工确认策略生效' : '完成回测后才能确认生效'} onClick={() => { onSelectStrategy(id); void activate(id) }}>
                    {busyAction === `activate:${id}` ? '更新中…' : '人工确认生效'}
                  </button>
                )}
                <button type="button" className={css.secondaryButton} onClick={() => { onSelectStrategy(id); onAnalyze({ kind: 'strategy', strategyId: id }) }}>AI 评审</button>
                <button type="button" className={css.primaryButton} disabled={status !== 'active'} onClick={() => { onSelectStrategy(id); onOpenShadow(id) }}>进入影子验证</button>
              </div>
            </article>
          )
        })}
      </section>
    </div>
  )
}

interface ShadowValidationPageProps {
  readonly requestData: InvestmentRequestData
  readonly selectedStrategyId: string
  readonly onOpenEvolution: () => void
  readonly onAnalyze: (intent: AssistantIntent) => void
}

/** Paper-account evidence; no real order is placed from this UI. */
export function ShadowValidationPage({
  requestData, selectedStrategyId, onOpenEvolution, onAnalyze,
}: ShadowValidationPageProps) {
  const status = useDataResource(requestData)
  const alive = useAliveRef()
  const positions = useDataResource(requestData)
  const equity = useDataResource(requestData)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(() => {
    status.run({ operation: 'trading-core.shadow-status' })
    positions.run({
      operation: 'trading-core.shadow-positions',
      input: selectedStrategyId === '' ? {} : { strategy_id: selectedStrategyId },
    })
    equity.run({
      operation: 'trading-core.shadow-equity',
      input: selectedStrategyId === '' ? { limit: 30 } : { strategy_id: selectedStrategyId, limit: 30 },
    })
  }, [equity.run, positions.run, selectedStrategyId, status.run])
  useEffect(load, [load])

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setNotice('正在启动影子验证…')
    try {
      const started = await requestData({
        operation: 'trading-core.shadow-run',
        input: selectedStrategyId === '' ? { force: false } : { force: false, strategy_id: selectedStrategyId },
      })
      const id = taskId(started)
      if (id === '') throw new Error('后端没有返回任务编号')
      const result = await waitForTask(
        requestData,
        id,
        (label) => { if (alive.current) setNotice(label) },
        () => alive.current,
      )
      if (result === TASK_CANCELLED) return
      const resultRecord = asRecord(result)
      if (resultRecord.skipped === true) {
        setNotice(`影子验证未执行：${text(resultRecord.reason, '当前不满足运行条件')}`)
      } else {
        const archived = Object.keys(asRecord(resultRecord.reports)).length > 0
        setNotice(archived
          ? '影子验证完成，正式结果已进入投研报告。'
          : '影子验证完成，但本次结果没有生成可归档报告。')
      }
      load()
    } catch (reason) {
      if (alive.current) setNotice(errorText(reason))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const statusRecord = asRecord(status.state.value)
  const positionItems = records(asRecord(positions.state.value).items)
  const equityItems = records(asRecord(equity.state.value).items)
  const firstError = [status.state, positions.state, equity.state].find(item => item.phase === 'error')

  return (
    <div className={css.pageScroll}>
      <PageHeading title="影子验证" description="用真实行情在纸面账户验证已生效策略，不触发真实交易">
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={load}>刷新</button>
        <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void start() }}>{busy ? '验证中…' : '运行影子验证'}</button>
      </PageHeading>
      <div className={css.lifecycleStrip} aria-label="当前验证对象">
        <span>策略研究</span><b aria-hidden="true">→</b><span>{selectedStrategyId === '' ? '全部生效策略' : selectedStrategyId}</span><b aria-hidden="true">→</b><span>自进化</span>
      </div>
      {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
      {firstError !== undefined && <DataError message={firstError.error} retry={load} />}
      <section className={css.moduleGrid} aria-label="影子验证概览">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>最近运行</strong><StatusBadge value={text(statusRecord.trade_date, '') === '' ? 'waiting_data' : 'done'} /></div>
          <dl className={css.reportMeta}>
            <div><dt>交易日</dt><dd>{text(statusRecord.trade_date)}</dd></div>
            <div><dt>策略数</dt><dd>{number(statusRecord.strategy_count)?.toFixed(0) ?? '—'}</dd></div>
            <div><dt>运行时间</dt><dd>{text(statusRecord.ran_at)}</dd></div>
            <div><dt>组合净值</dt><dd>{compactMetric(statusRecord.overall_nav)}</dd></div>
          </dl>
          {text(statusRecord.note, '') !== '' && <p>{text(statusRecord.note)}</p>}
        </article>
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>纸面持仓</strong><span>{positionItems.length} 项</span></div>
          <div className={css.dataList}>
            {positionItems.slice(0, 12).map((item, index) => (
              <div className={css.dataRow} key={`${text(item.strategy_id)}-${text(item.symbol)}-${index}`}>
                <div><strong>{text(item.symbol, text(item.code))}</strong><small>{text(item.strategy_id)}</small></div>
                <span>{number(item.qty ?? item.quantity)?.toLocaleString('zh-CN') ?? money(item.market_value)}</span>
              </div>
            ))}
            {positionItems.length === 0 && positions.state.phase === 'success' && <Empty>当前没有纸面持仓。</Empty>}
          </div>
        </article>
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>净值证据</strong><span>{equityItems.length} 日</span></div>
          <div className={css.dataList}>
            {equityItems.slice(0, 12).map((item, index) => {
              const strategy = asRecord(item.strategy)
              return (
                <div className={css.dataRow} key={`${text(item.date)}-${index}`}>
                  <span>{text(item.date)}</span>
                  <strong>{compactMetric(strategy.nav ?? item.overall_nav)}</strong>
                </div>
              )
            })}
            {equityItems.length === 0 && equity.state.phase === 'success' && <Empty>尚无净值历史，需要先运行影子验证。</Empty>}
          </div>
        </article>
      </section>
      <div className={css.moduleToolbar}>
        <button type="button" className={css.secondaryButton} onClick={() => {
          onAnalyze(selectedStrategyId === '' ? { kind: 'shadow' } : { kind: 'shadow', strategyId: selectedStrategyId })
        }}>AI 解读验证证据</button>
        <button type="button" className={css.primaryButton} onClick={onOpenEvolution}>进入自进化</button>
      </div>
    </div>
  )
}

interface EvolutionPageProps {
  readonly requestData: InvestmentRequestData
  readonly onAnalyze: (intent: AssistantIntent) => void
}

/** Preview-first evolution workflow with a deliberate write confirmation. */
export function EvolutionPage({ requestData, onAnalyze }: EvolutionPageProps) {
  const status = useDataResource(requestData)
  const alive = useAliveRef()
  const attribution = useDataResource(requestData)
  const [preview, setPreview] = useState<Record<string, unknown>>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(() => {
    status.run({ operation: 'trading-core.evolution-status' })
    attribution.run({ operation: 'trading-core.evolution-attribution' })
  }, [attribution.run, status.run])
  useEffect(load, [load])

  const evolve = async (apply: boolean): Promise<void> => {
    if (busy) return
    setBusy(true); setNotice(apply ? '正在应用已预览的进化动作…' : '正在计算只读进化预案…')
    try {
      const result = asRecord(await requestData({ operation: 'trading-core.evolution-run', input: { apply } }))
      if (!alive.current) return
      setPreview(result)
      setNotice(apply ? '进化动作已应用，策略池状态已刷新。' : '预案已生成；确认前不会写入策略库。')
      if (apply) load()
    } catch (reason) {
      if (alive.current) setNotice(`进化计算失败：${errorText(reason)}`)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const statusRecord = asRecord(status.state.value)
  const counts = asRecord(statusRecord.counts)
  const attributionRecord = asRecord(attribution.state.value)
  const overall = asRecord(attributionRecord.overall)
  const strategyRows = records(attributionRecord.strategies)
  const actions = records(preview?.actions)
  const previewReady = preview !== undefined && text(preview.status, '') !== 'waiting_data' && actions.length > 0

  return (
    <div className={css.pageScroll}>
      <PageHeading title="自进化" description="先归因、再预览、后确认；任何策略升降级或变异都不会静默写入">
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={load}>刷新</button>
        <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void evolve(false) }}>{busy ? '计算中…' : '生成进化预案'}</button>
      </PageHeading>
      <div className={css.contextHint}>AI 只负责解释证据和建议；实际写入必须在本页查看预案后由你确认。</div>
      {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
      <section className={css.moduleGrid} aria-label="进化状态与归因">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>闭环就绪状态</strong><StatusBadge value={statusRecord.ready === true ? 'done' : 'waiting_data'} /></div>
          <dl className={css.reportMeta}>
            <div><dt>数据天数</dt><dd>{number(statusRecord.days_of_data)?.toFixed(0) ?? '—'}</dd></div>
            <div><dt>生效策略</dt><dd>{number(counts.active)?.toFixed(0) ?? '—'}</dd></div>
            <div><dt>变异候选</dt><dd>{number(counts.mutated)?.toFixed(0) ?? '—'}</dd></div>
            <div><dt>退役策略</dt><dd>{number(counts.retired)?.toFixed(0) ?? '—'}</dd></div>
          </dl>
        </article>
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>整体影子归因</strong><span>{number(attributionRecord.days_of_data)?.toFixed(0) ?? '0'} 日</span></div>
          <dl className={css.reportMeta}>
            <div><dt>累计收益</dt><dd>{compactMetric(overall.return_pct, '%')}</dd></div>
            <div><dt>最大回撤</dt><dd>{compactMetric(overall.max_drawdown_pct, '%')}</dd></div>
            <div><dt>起始净值</dt><dd>{compactMetric(overall.start_nav)}</dd></div>
            <div><dt>当前净值</dt><dd>{compactMetric(overall.end_nav)}</dd></div>
          </dl>
          {text(attributionRecord.data_note, '') !== '' && <p>{text(attributionRecord.data_note)}</p>}
        </article>
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>分策略证据</strong><span>{strategyRows.length} 项</span></div>
          <div className={css.dataList}>
            {strategyRows.slice(0, 10).map((item, index) => (
              <div className={css.dataRow} key={`${text(item.strategy_id)}-${index}`}>
                <div><strong>{text(item.name, text(item.strategy_id))}</strong><small>回撤 {compactMetric(item.max_drawdown_pct, '%')}</small></div>
                <strong>{compactMetric(item.return_pct, '%')}</strong>
              </div>
            ))}
            {strategyRows.length === 0 && attribution.state.phase === 'success' && <Empty>影子证据不足，暂不能归因。</Empty>}
          </div>
        </article>
      </section>
      {preview !== undefined && (
        <section className={css.confirmPanel} aria-labelledby="evolution-preview-title">
          <div>
            <h2 id="evolution-preview-title">进化动作预览</h2>
            <p>{actions.length === 0 ? text(preview.data_note, text(preview.note, '当前没有满足条件的进化动作。')) : `共 ${actions.length} 项；确认后将写入策略库。`}</p>
          </div>
          <div className={css.dataList}>
            {actions.map((item, index) => (
              <div className={css.dataRow} key={`${text(item.sid)}-${text(item.type)}-${index}`}>
                <div><strong>{text(item.strategy_name, text(item.sid))}</strong><small>{text(item.reason)}</small></div>
                <StatusBadge value={text(item.type)} />
              </div>
            ))}
          </div>
          <div className={css.moduleToolbar}>
            <button type="button" className={css.secondaryButton} onClick={() => { onAnalyze({ kind: 'evolution' }) }}>AI 复核预案</button>
            <button type="button" className={css.primaryButton} disabled={!previewReady || busy} onClick={() => { void evolve(true) }}>确认并应用</button>
          </div>
        </section>
      )}
    </div>
  )
}

interface IndustryChainPageProps {
  readonly requestData: InvestmentRequestData
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly onAnalyze: (intent: AssistantIntent) => void
}

/** Industry transmission view from backend-expanded event impacts. */
export function IndustryChainPage({ requestData, query, onQuery, onAnalyze }: IndustryChainPageProps) {
  const impact = useDataResource(requestData)
  const load = useCallback(() => {
    impact.run({ operation: 'trading-core.personalized-impact', input: { limit: 20 } })
  }, [impact.run])
  useEffect(load, [load])
  const events = records(asRecord(impact.state.value).events)
  const keyword = query.trim().toLowerCase()
  const filtered = useMemo(() => events.filter((event) => {
    if (keyword === '') return true
    return [
      text(event.summary, ''),
      ...tickerLabels(event.tickers),
      ...strings(event.industries),
      ...strings(event.impact_codes),
      ...strings(event.impact_industries),
      ...strings(event.impact_by),
    ]
      .some(value => text(value, '').toLowerCase().includes(keyword))
  }), [events, keyword])

  return (
    <div className={css.pageScroll}>
      <PageHeading title="产业链" description="查看真实事件经影响图谱扩展后的标的、行业与传导来源；图谱不可用时明确降级为空">
        <button type="button" className={css.secondaryButton} onClick={load}>刷新</button>
        <button type="button" className={css.primaryButton} onClick={() => {
          onAnalyze(query === '' ? { kind: 'industry' } : { kind: 'industry', reference: query })
        }}>AI 解读产业链</button>
      </PageHeading>
      <label className={css.inlineForm}>
        <span>筛选事件、股票或行业</span>
        <input className={css.fieldInput} value={query} onChange={(event) => { onQuery(event.target.value) }} placeholder="例如：半导体、688981、设备" />
      </label>
      {impact.state.phase === 'loading' && impact.state.value === undefined && <BusyRows />}
      {impact.state.phase === 'error' && <DataError message={impact.state.error} retry={load} />}
      <section className={css.moduleGrid} aria-label="事件产业链影响">
        {filtered.map((event, index) => {
          const codes = strings(event.impact_codes)
          const industries = strings(event.impact_industries)
          const sources = strings(event.impact_by)
          return (
            <article className={css.moduleCard} key={`${text(event.id)}-${index}`}>
              <div className={css.sectionHeading}><strong>{text(event.summary, '未命名事件')}</strong><StatusBadge value={text(event.direction)} /></div>
              <dl className={css.reportMeta}>
                <div><dt>直接标的</dt><dd>{tickerLabels(event.tickers).join('、') || '—'}</dd></div>
                <div><dt>直接行业</dt><dd>{strings(event.industries).join('、') || '—'}</dd></div>
                <div><dt>扩展标的</dt><dd>{codes.join('、') || '图谱暂无扩展'}</dd></div>
                <div><dt>扩展行业</dt><dd>{industries.join('、') || '图谱暂无扩展'}</dd></div>
              </dl>
              <small>传导来源：{sources.join('、') || '未返回；当前保持事件原样'}</small>
            </article>
          )
        })}
      </section>
      {impact.state.phase === 'success' && filtered.length === 0 && <Empty>{events.length === 0 ? '当前事件源没有可展示的产业链事件。' : '没有匹配当前筛选条件的事件。'}</Empty>}
    </div>
  )
}

interface ReportCenterProps {
  readonly requestData: InvestmentRequestData
  readonly onClose: () => void
  readonly onAnalyze: (intent: AssistantIntent) => void
}

/** One global entry for reports generated by every asynchronous research task. */
export function ReportCenter({ requestData, onClose, onAnalyze }: ReportCenterProps) {
  const list = useDataResource(requestData)
  const detail = useDataResource(requestData)
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [selectedId, setSelectedId] = useState('')
  const load = useCallback(() => { list.run({ operation: 'trading-core.reports', input: { limit: 100 } }) }, [list.run])
  useEffect(load, [load])
  const items = records(asRecord(list.state.value).items)

  useEffect(() => {
    if (selectedId !== '' || items.length === 0) return
    setSelectedId(text(items[0]?.id, ''))
  }, [items, selectedId])
  useEffect(() => {
    if (selectedId !== '') {
      detail.run({ operation: 'trading-core.report', input: { report_id: selectedId } })
    }
  }, [detail.run, selectedId])
  useEffect(() => {
    closeRef.current?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'Tab') return
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
      if (focusable === undefined || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown) }
  }, [onClose])

  const report = asRecord(detail.state.value)
  const sections = records(report.sections)
  const fallbackReports = asRecord(report.reports)
  const fallbackSections = Object.entries(fallbackReports).map(([key, value]) => ({ key, title: key, content: value }))
  const visibleSections = sections.length > 0 ? sections : fallbackSections
  const selectedListItem = items.find(item => text(item.id, '') === selectedId)
  const title = text(report.title, text(selectedListItem?.title, '投研报告'))

  const dialog = (
    <div className={css.reportBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={panelRef} id="investment-report-center" className={css.reportDrawer} role="dialog" aria-modal="true" aria-labelledby="report-center-title">
        <header className={css.drawerHeader}>
          <div><h2 id="report-center-title">投研报告</h2><p>所有正式分析、回测与验证结果统一归档</p></div>
          <button ref={closeRef} type="button" aria-label="关闭投研报告" onClick={onClose}>×</button>
        </header>
        <div className={css.reportLayout}>
          <aside className={css.reportList} aria-label="报告列表">
            <button type="button" className={css.secondaryButton} onClick={load}>刷新报告</button>
            {list.state.phase === 'loading' && list.state.value === undefined && <BusyRows />}
            {list.state.phase === 'error' && <DataError message={list.state.error} retry={load} />}
            {items.map((item, index) => {
              const id = text(item.id, `report-${index}`)
              return (
                <button key={id} type="button" className={`${css.reportItem} ${selectedId === id ? css.reportItemActive : ''}`} aria-pressed={selectedId === id} onClick={() => { setSelectedId(id) }}>
                  <strong>{text(item.title, '未命名报告')}</strong>
                  <span>{reportKindLabel(item.kind)} · {reportTimeLabel(item.created_at)}</span>
                </button>
              )
            })}
            {list.state.phase === 'success' && items.length === 0 && <Empty>尚无正式报告。完成一次分析、回测或影子验证后会自动归档到这里。</Empty>}
          </aside>
          <article className={css.reportBody} aria-busy={detail.state.phase === 'loading'}>
            {selectedId === '' && <Empty>从左侧选择一份报告查看。</Empty>}
            {selectedId !== '' && detail.state.phase === 'loading' && detail.state.value === undefined && <BusyRows />}
            {detail.state.phase === 'error' && <DataError message={detail.state.error} retry={() => { detail.run({ operation: 'trading-core.report', input: { report_id: selectedId } }) }} />}
            {detail.state.value !== undefined && (
              <>
                <div className={css.sectionHeading}>
                  <div><h2>{title}</h2><p>{text(report.summary, text(selectedListItem?.summary, ''))}</p></div>
                  <button type="button" className={css.secondaryButton} onClick={() => { onAnalyze({ kind: 'reports', reportId: selectedId }); onClose() }}>AI 复核</button>
                </div>
                <dl className={css.reportMeta}>
                  <div><dt>类型</dt><dd>{reportKindLabel(report.kind ?? selectedListItem?.kind)}</dd></div>
                  <div><dt>生成时间</dt><dd>{reportTimeLabel(report.created_at ?? selectedListItem?.created_at)}</dd></div>
                  <div><dt>报告编号</dt><dd>{selectedId}</dd></div>
                </dl>
                <div className={css.reportSections}>
                  {visibleSections.map((section, index) => (
                    <section key={`${text(section.key)}-${index}`}>
                      <h3>{text(section.title, text(section.key, `章节 ${index + 1}`))}</h3>
                      <div className={css.reportMarkdown}><MarkdownText text={text(section.content)} /></div>
                    </section>
                  ))}
                  {visibleSections.length === 0 && <Empty>这份报告没有可展示的正文。</Empty>}
                </div>
              </>
            )}
          </article>
        </div>
      </section>
    </div>
  )
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
