import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import { createPortal } from 'react-dom'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantIntent } from './assistant-intent.ts'
import { asRecord, money, number, productErrorText, records, text } from './data.ts'
import { DetailDialog } from './DetailDialogs.tsx'
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
            error: productErrorText(reason),
          }))
        }
      },
    )
  }, [requestData])
  return { state, run }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
}

interface TickerDisplay {
  readonly code: string
  readonly name: string
}

function tickerItems(value: unknown): TickerDisplay[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const raw = item.trim()
      if (raw === '') return []
      const labelled = raw.match(/^(.+?)\s*[（(](\d{6})[）)]$/u)
      if (labelled !== null) return [{ code: labelled[2] ?? '', name: labelled[1]?.trim() ?? '' }]
      return /^\d{6}$/u.test(raw) ? [{ code: raw, name: '' }] : []
    }
    const ticker = asRecord(item)
    const code = text(ticker.code, '').trim()
    const name = text(ticker.name, '').trim()
    return code === '' ? [] : [{ code, name }]
  })
}

function impactSourceSecurityNames(value: unknown): Record<string, string> {
  const names: Record<string, string> = {}
  for (const source of strings(value)) {
    for (const match of source.matchAll(/(?:^|[：:、/])\s*([^（）(),，、/:：]+?)\s*[（(](\d{6})[）)]/gu)) {
      const name = match[1]?.trim() ?? ''
      const code = match[2] ?? ''
      if (name !== '' && code !== '') names[code] = name
    }
  }
  return names
}

interface StrategyTicker {
  readonly code: string
  readonly name: string
}

function strategyTickers(item: Record<string, unknown>): StrategyTicker[] {
  const embedded = Array.isArray(item.tickers) ? item.tickers : []
  const byCode = new Map<string, string>()
  for (const value of embedded) {
    const ticker = asRecord(value)
    const code = text(ticker.code, '').trim()
    const name = text(ticker.name, '').trim()
    if (code !== '') byCode.set(code, name)
  }
  for (const code of strings(item.symbols)) {
    if (!byCode.has(code)) byCode.set(code, '')
  }
  return [...byCode].map(([code, name]) => ({ code, name }))
}

function strategyKindLabel(value: unknown): string {
  const kind = text(value, '')
  return {
    ma_cross: '均线趋势',
    rsi_reversal: '超跌反弹',
    momentum: '动量跟随',
    breakout: '通道突破',
    bollinger: '布林超跌',
    volume_breakout: '放量突破',
  }[kind] ?? (kind === '' ? '策略类型未返回' : '其他策略')
}

function strategyDirectionLabel(value: unknown): string {
  const direction = text(value, '').trim()
  const normalized = direction.toLowerCase()
  if (['利好', 'long', 'bullish', 'positive', 'up'].includes(normalized)) return '利好'
  if (['利空', 'short', 'bearish', 'negative', 'down'].includes(normalized)) return '利空'
  return direction
}

function strategyTargetLabel(item: Record<string, unknown>, resolved: Readonly<Record<string, string>>): string {
  const tickers = strategyTickers(item)
  const labels = tickers.map((ticker) => {
    const name = ticker.name || resolved[ticker.code] || ''
    return name === '' || name === ticker.code ? ticker.code : `${name} · ${ticker.code}`
  })
  if (labels.length > 0) return labels.slice(0, 2).join('、') + (labels.length > 2 ? `等${labels.length}只` : '')
  return text(item.name, text(item.id, '未命名策略'))
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
    positive: '正向', negative: '负向', neutral: '中性', bullish: '正向', bearish: '负向',
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
    backtest: '历史回测', strategy: '策略研究', shadow: '策略研究 · 影子验证',
  }[kind] ?? (kind === '' ? '投研分析' : kind)
}

const REPORT_TITLE_LABELS: Readonly<Record<string, string>> = {
  stock: '个股分析报告',
  holdings: '持仓分析报告',
  brief: '市场简报',
  backtest: '策略回测报告',
  strategy: '策略研究报告',
  shadow: '影子验证报告',
}

const STRATEGY_KINDS = new Set(['ma_cross', 'rsi_reversal', 'momentum', 'breakout', 'bollinger', 'volume_breakout'])

/** 回测样本窗口选项（年）。后端按 lookback_years × 366 天取日线，再按 70% 样本内 / 30% 样本外切分。 */
const BACKTEST_WINDOW_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 0.5, label: '6个月' },
  { value: 1, label: '1年' },
  { value: 2, label: '2年' },
  { value: 3, label: '3年' },
  { value: 5, label: '5年' },
]

function strategySubjectLabel(value: unknown, securityNames: Readonly<Record<string, string>> = {}): string {
  const raw = text(value, '').trim()
  if (raw === '') return ''
  const withoutId = raw.replace(/\s*（strat-[^）]+）\s*$/u, '').trim()
  const segments = withoutId.split('·').map(segment => segment.trim()).filter(Boolean)
  const kindIndex = segments.findIndex(segment => STRATEGY_KINDS.has(segment))
  if (kindIndex < 0) return withoutId.startsWith('strat-') ? '' : withoutId
  const direction = strategyDirectionLabel(segments.slice(0, kindIndex).join(' · '))
  const targetCode = segments.slice(kindIndex + 1).join(' · ')
  const securityName = securityNames[targetCode] ?? ''
  const target = securityName === '' || securityName === targetCode ? targetCode : `${securityName} · ${targetCode}`
  return [target, strategyKindLabel(segments[kindIndex]), direction].filter(Boolean).join(' · ')
}

function reportSubjectLabel(item: Record<string, unknown>, securityNames: Readonly<Record<string, string>> = {}): string {
  const raw = text(item.summary, '')
  const kind = text(item.kind, '')
  return kind === 'strategy' || kind === 'shadow' ? strategySubjectLabel(raw, securityNames) : raw
}

function reportTitleLabel(item: Record<string, unknown>, securityNames: Readonly<Record<string, string>> = {}): string {
  const raw = text(item.title, '投研报告')
  const kind = text(item.kind, '')
  if (kind !== 'strategy' && kind !== 'shadow') return raw
  const subject = reportSubjectLabel(item, securityNames)
  return subject === '' ? (REPORT_TITLE_LABELS[kind] ?? raw) : `${REPORT_TITLE_LABELS[kind]} · ${subject}`
}

function reportSecurityCodes(items: readonly Record<string, unknown>[]): string[] {
  const codes = new Set<string>()
  for (const item of items) {
    if (!['strategy', 'shadow'].includes(text(item.kind, ''))) continue
    const matches = `${text(item.title, '')}\n${text(item.summary, '')}`.match(/\d{6}/gu) ?? []
    for (const code of matches) codes.add(code)
  }
  return [...codes].sort()
}

function humanizeReportMarkdown(value: unknown, securityNames: Readonly<Record<string, string>> = {}): string {
  return text(value).split('\n').map((line) => {
    const strategy = line.match(/^(\s*-\s*策略：\s*)(.+)$/u)
    if (strategy !== null) return `${strategy[1]}${strategySubjectLabel(strategy[2], securityNames) || strategy[2]}`
    const identifier = line.match(/^(\s*-\s*)策略标识：(\s*)(strat-)?(.+)$/u)
    if (identifier !== null) return `${identifier[1]}策略编号：${identifier[2]}${identifier[4]}`
    const kind = line.match(/^(\s*-\s*规则类型：\s*)(\S+)\s*$/u)
    if (kind !== null) return `${kind[1]}${strategyKindLabel(kind[2])}`
    const lifecycle = line.match(/^(\s*-\s*生命周期状态：\s*)(\S+)\s*$/u)
    if (lifecycle !== null) return `${lifecycle[1]}${statusLabel(lifecycle[2] ?? '')}`
    const target = line.match(/^(\s*-\s*标的：\s*)(\d{6})\s*$/u)
    if (target !== null) {
      const securityName = securityNames[target[2] ?? ''] ?? ''
      if (securityName !== '') return `${target[1]}${securityName} · ${target[2]}`
    }
    return line
  }).join('\n')
}

function compactIdentifier(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
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

type StrategyCategory = 'verified' | 'unverified' | 'failed' | 'archived'
type StrategyFilter = 'all' | StrategyCategory

const STRATEGY_CATEGORY_LABELS: Record<StrategyFilter, string> = {
  all: '全部',
  verified: '已验证通过',
  unverified: '未验证',
  failed: '验证未通过',
  archived: '已归档',
}

function strategyCategory(item: Record<string, unknown>): StrategyCategory {
  const explicit = text(item.verification_status, '')
  const backtest = asRecord(item.backtest)
  const reason = text(backtest.reason, '')
  if (text(item.archived_at, '') !== '' || explicit === 'archived') return 'archived'
  if (explicit === 'passed') return 'verified'
  if (explicit === 'failed') return 'failed'
  if (explicit === 'pending') return 'unverified'
  if (backtest.thresholds_pass === true) return 'verified'
  if (Object.keys(backtest).length > 0 && backtest.thresholds_pass === false) {
    return reason.includes('成交不足') || reason.includes('样本不足') ? 'unverified' : 'failed'
  }
  // Lifecycle alone is not verification evidence. An active/rejected record
  // without a usable backtest remains unverified until the backend returns an
  // explicit verification result or thresholds evidence.
  return 'unverified'
}

function strategyRule(item: Record<string, unknown>): { trigger: string; exit: string; params: string[] } {
  const kind = text(item.kind, '')
  const params = asRecord(item.params)
  if (kind === 'ma_cross') {
    const fast = number(params.fast)?.toFixed(0)
    const slow = number(params.slow)?.toFixed(0)
    const complete = fast !== undefined && slow !== undefined
    return {
      trigger: complete
        ? `${fast} 日均线高于 ${slow} 日均线后，按下一交易日开盘价进入纸面持仓。`
        : '数据不足：后端未返回完整的快线和慢线参数，无法还原触发规则。',
      exit: complete
        ? `${fast} 日均线回落至 ${slow} 日均线下方后，按下一交易日开盘价退出。`
        : '数据不足：后端未返回完整的快线和慢线参数，无法还原退出规则。',
      params: [`快线 ${fast === undefined ? '未返回' : `${fast} 日`}`, `慢线 ${slow === undefined ? '未返回' : `${slow} 日`}`],
    }
  }
  if (kind === 'rsi_reversal') {
    const period = number(params.n)?.toFixed(0)
    const oversold = number(params.oversold)?.toFixed(0)
    const overbought = number(params.overbought)?.toFixed(0)
    return {
      trigger: period !== undefined && oversold !== undefined
        ? `${period} 日 RSI 低于 ${oversold} 后，按下一交易日开盘价进入纸面持仓。`
        : '数据不足：后端未返回完整的 RSI 周期和超卖阈值，无法还原触发规则。',
      exit: overbought !== undefined
        ? `RSI 高于 ${overbought} 后，按下一交易日开盘价退出。`
        : '数据不足：后端未返回 RSI 超买阈值，无法还原退出规则。',
      params: [
        `RSI 周期 ${period === undefined ? '未返回' : `${period} 日`}`,
        `超卖阈值 ${oversold ?? '未返回'}`,
        `超买阈值 ${overbought ?? '未返回'}`,
      ],
    }
  }
  if (kind === 'momentum') {
    const period = number(params.n)?.toFixed(0)
    return {
      trigger: period === undefined
        ? '数据不足：后端未返回动量窗口，无法还原触发规则。'
        : `收盘价高于 ${period} 个交易日前收盘价后，按下一交易日开盘价进入纸面持仓。`,
      exit: period === undefined
        ? '数据不足：后端未返回动量窗口，无法还原退出规则。'
        : '动量条件失效后，按下一交易日开盘价退出。',
      params: [`动量窗口 ${period === undefined ? '未返回' : `${period} 日`}`],
    }
  }
  if (kind === 'breakout') {
    const n = number(params.n)?.toFixed(0)
    return {
      trigger: n === undefined
        ? '数据不足：后端未返回突破窗口，无法还原触发规则。'
        : `收盘价突破前 ${n} 日最高价后，按下一交易日开盘价进入纸面持仓。`,
      exit: n === undefined
        ? '数据不足：后端未返回突破窗口，无法还原退出规则。'
        : `收盘价跌破前 ${n} 日最低价后，按下一交易日开盘价退出。`,
      params: [`突破窗口 ${n === undefined ? '未返回' : `${n} 日`}`],
    }
  }
  if (kind === 'bollinger') {
    const n = number(params.n)?.toFixed(0)
    const k = number(params.k)
    return {
      trigger: n !== undefined && k !== undefined
        ? `收盘价跌破 ${n} 日布林带下轨（中轨 − ${k} 倍标准差）后，按下一交易日开盘价进入纸面持仓。`
        : '数据不足：后端未返回完整的布林窗口和带宽系数，无法还原触发规则。',
      exit: n === undefined
        ? '数据不足：后端未返回布林窗口，无法还原退出规则。'
        : `收盘价回升至 ${n} 日中轨上方后，按下一交易日开盘价退出。`,
      params: [
        `布林窗口 ${n === undefined ? '未返回' : `${n} 日`}`,
        `带宽系数 ${k === undefined ? '未返回' : k}`,
      ],
    }
  }
  if (kind === 'volume_breakout') {
    const n = number(params.n)?.toFixed(0)
    const mult = number(params.vol_mult)
    return {
      trigger: n !== undefined && mult !== undefined
        ? `收盘价突破前 ${n} 日最高价，且成交量达到前 ${n} 日均量 ${mult} 倍以上后，按下一交易日开盘价进入纸面持仓。`
        : '数据不足：后端未返回完整的突破窗口和放量倍数，无法还原触发规则。',
      exit: n === undefined
        ? '数据不足：后端未返回突破窗口，无法还原退出规则。'
        : `收盘价跌破前 ${n} 日最低价后，按下一交易日开盘价退出。`,
      params: [
        `突破窗口 ${n === undefined ? '未返回' : `${n} 日`}`,
        `放量倍数 ${mult === undefined ? '未返回' : `${mult} 倍`}`,
      ],
    }
  }
  const kindReason = kind === '' ? '后端未返回策略类型' : `后端返回了暂不支持解释的策略类型“${kind}”`
  return {
    trigger: `数据不足：${kindReason}，无法解释触发规则。`,
    exit: `数据不足：${kindReason}，无法解释退出规则。`,
    params: [Object.keys(params).length === 0 ? '策略参数 未返回' : '策略参数 已返回，但因类型未知未作解释'],
  }
}

function verificationExplanation(category: StrategyCategory): string {
  return {
    verified: '样本外阈值已通过，可以进入影子验证继续积累真实行情下的纸面证据。',
    unverified: '尚未形成足够的样本外证据，需先运行回测或补足样本，不能直接视为有效策略。',
    failed: '样本外证据未达到准入线，建议复核假设与参数后重测，或保留失败结论。',
    archived: '策略已退出当前验证队列，仅保留历史假设、回测与生命周期记录供追溯。',
  }[category]
}

interface StrategyHypothesisPreview {
  readonly eventCount: number | undefined
  readonly hypotheses: readonly Record<string, unknown>[]
  readonly note: string
}

function HypothesisPreviewDialog({
  preview, busy, status, onClose, onConfirm,
}: {
  preview: StrategyHypothesisPreview
  busy: boolean
  status: string
  onClose: () => void
  onConfirm: () => void
}) {
  const eventSummary = preview.eventCount === undefined
    ? '后端未返回本次读取的事件数量'
    : `本次读取 ${preview.eventCount} 条事件`
  return (
    <DetailDialog
      title="候选假设预览"
      description={`${eventSummary}，生成 ${preview.hypotheses.length} 条假设；确认前不会写入，确认后服务会按当前事件重新生成并加入候选池。`}
      eyebrow="只读预览"
      wide
      onClose={onClose}
      actions={<>
        <button type="button" className={css.secondaryButton} onClick={onClose}>关闭预览</button>
        <button type="button" className={css.primaryButton} disabled={busy || preview.hypotheses.length === 0} onClick={onConfirm}>
          {busy ? '正在加入…' : '确认加入候选池'}
        </button>
      </>}
    >
      {status !== '' && <div className={css.contextHint} role="status">{status}</div>}
      {preview.hypotheses.length === 0 ? (
        <Empty>{preview.note || '本轮没有返回可预览的策略假设，未写入策略池。'}</Empty>
      ) : preview.hypotheses.map((hypothesis, index) => {
        const rule = strategyRule(hypothesis)
        const symbols = strings(hypothesis.symbols)
        const holdingWindow = number(hypothesis.holding_window_days)?.toFixed(0)
        return (
          <section key={`${text(hypothesis.kind, 'unknown')}-${index}`} className={css.detailSection}>
            <h3>假设 {index + 1} · {strategyKindLabel(hypothesis.kind)}</h3>
            <p><strong>假设依据：</strong>{text(hypothesis.rationale, '后端未返回假设说明。')}</p>
            <p><strong>触发规则：</strong>{rule.trigger}</p>
            <p><strong>退出规则：</strong>{rule.exit}</p>
            <div className={css.detailEvidenceRow}>
              <span>交易方向 <strong>{text(hypothesis.direction, '未返回')}</strong></span>
              <span>关联标的 <strong>{symbols.length === 0 ? '未返回' : symbols.join('、')}</strong></span>
              <span>建议观察窗口 <strong>{holdingWindow === undefined ? '未返回' : `${holdingWindow} 天`}</strong></span>
            </div>
            <div className={css.detailTags}>{rule.params.map(param => <span key={param}>{param}</span>)}</div>
          </section>
        )
      })}
    </DetailDialog>
  )
}

function StrategyDetailDialog({
  item, busy, onClose, onRun, onAnalyze, onShadow,
}: {
  item: Record<string, unknown>
  busy: boolean
  onClose: () => void
  onRun: () => void
  onAnalyze: () => void
  onShadow: () => void
}) {
  const id = text(item.id, '未返回')
  const status = text(item.status, '')
  const category = strategyCategory(item)
  const backtest = asRecord(item.backtest)
  const inSample = asRecord(backtest.in_sample)
  const outOfSample = asRecord(backtest.out_of_sample)
  const symbols = strings(item.symbols)
  const symbolErrors = Object.keys(asRecord(backtest.symbol_errors))
  const rule = strategyRule(item)
  const sourceEventId = text(item.source_event_id, '')
  const sourceEventSummary = text(item.source_event_summary, '')
  const holdingWindow = number(item.holding_window_days)?.toFixed(0)
  const metric = (value: unknown, suffix = ''): string => {
    const formatted = compactMetric(value, suffix)
    return formatted === '—' ? '数据不足' : formatted
  }
  const evidenceRows = [
    ['交易数', number(inSample.n_evaluated)?.toFixed(0) ?? '数据不足', number(outOfSample.n_evaluated)?.toFixed(0) ?? '数据不足'],
    ['胜率', metric(inSample.win_rate_pct, '%'), metric(outOfSample.win_rate_pct, '%')],
    ['平均模拟收益', metric(inSample.avg_simulated_return_pct, '%'), metric(outOfSample.avg_simulated_return_pct, '%')],
    ['年化 Sharpe', metric(inSample.sharpe_annualized), metric(outOfSample.sharpe_annualized)],
    ['最大回撤', metric(inSample.max_drawdown_pct, '%'), metric(outOfSample.max_drawdown_pct, '%')],
  ] as const
  return (
    <DetailDialog
      title={text(item.name, id)}
      description={text(item.hypothesis, text(item.thesis, '策略库尚未返回假设说明。'))}
      eyebrow="策略详情"
      wide
      onClose={onClose}
      actions={<>
        <button type="button" className={css.secondaryButton} onClick={onClose}>关闭</button>
        <button type="button" className={css.secondaryButton} onClick={onAnalyze}>AI 评审</button>
        <button type="button" className={css.secondaryButton} disabled={busy || category === 'archived'} onClick={onRun}>{busy ? '回测中…' : '运行回测'}</button>
        <button type="button" className={css.primaryButton} disabled={status !== 'active'} onClick={onShadow}>进入影子验证</button>
      </>}
    >
      <div data-testid="strategy-detail-dialog" className={css.detailTags} aria-label="策略标签">
        <span>{STRATEGY_CATEGORY_LABELS[category]}</span>
        <span>{status === '' ? '状态未返回' : statusLabel(status)}</span>
        <span>{text(item.kind, '策略类型未返回')}</span>
        {text(item.direction, '') !== '' && <span>{text(item.direction)}</span>}
        {symbols.map(symbol => <span key={symbol}>{symbol}</span>)}
      </div>
      <dl className={css.detailMetaGrid}>
        <div><dt>策略标识</dt><dd>{id}</dd></div>
        <div><dt>验证分类</dt><dd>{STRATEGY_CATEGORY_LABELS[category]}</dd></div>
        <div><dt>回测时间</dt><dd>{reportTimeLabel(backtest.ran_at).replace('—', '未返回')}</dd></div>
        <div><dt>更新时间</dt><dd>{reportTimeLabel(item.updated_at).replace('—', '未返回')}</dd></div>
      </dl>
      <section className={css.detailSection} data-field="strategy-description">
        <h3>策略逻辑与投资假设</h3>
        <p><strong>投资假设：</strong>{text(item.hypothesis, text(item.thesis, '后端策略库暂未返回假设说明。'))}</p>
        <p><strong>触发规则：</strong>{rule.trigger}</p>
        <p><strong>退出规则：</strong>{rule.exit}</p>
        <div className={css.detailEvidenceRow}>
          <span>建议观察窗口 <strong>{holdingWindow === undefined ? '未返回' : `${holdingWindow} 天`}</strong></span>
          <span>交易方向 <strong>{text(item.direction, '未返回')}</strong></span>
        </div>
        <div className={css.detailTags}>{rule.params.map(param => <span key={param}>{param}</span>)}</div>
      </section>
      <section className={css.detailSection}>
        <h3>验证结论</h3>
        <p>{verificationExplanation(category)}</p>
        <p><strong>后端判定：</strong>{text(backtest.reason, Object.keys(backtest).length === 0 ? '尚未运行样本外回测。' : '未返回判定原因。')}</p>
      </section>
      <section className={css.detailSection} data-testid="verification-summary">
        <h3>样本内 / 样本外证据</h3>
        <div className={css.strategyEvidenceTable}>
          <table>
            <thead><tr><th>指标</th><th>样本内</th><th>样本外</th></tr></thead>
            <tbody>{evidenceRows.map(row => <tr key={row[0]}><td>{row[0]}</td><td>{row[1]}</td><td>{row[2]}</td></tr>)}</tbody>
          </table>
        </div>
        {symbolErrors.length > 0 && <p className={css.detailFootnote}>行情获取异常标的：{symbolErrors.join('、')}</p>}
      </section>
      <section className={css.detailSection} data-testid="strategy-sources">
        <h3>数据来源与准入说明</h3>
        <ul className={css.detailList}>
          <li>策略名称、假设、规则类型和标的来自后端策略库。</li>
          <li>来源事件：{sourceEventId === '' ? '暂未返回稳定事件标识' : sourceEventId}{sourceEventSummary === '' ? '' : ` · ${sourceEventSummary}`}</li>
          <li>指标来自策略回测引擎返回的 in_sample / out_of_sample 结果，页面不补算或伪造。</li>
          <li>当前运行请求的准入线为样本外交易不少于 4 笔、胜率不低于 50%、平均模拟收益大于 0；最终以 thresholds_pass 与 reason 为准。</li>
          <li>信号只使用当时及之前的数据，统一按“当日信号 → 下一交易日开盘”模拟成交；序列末仍持仓时按最后收盘价退出。</li>
          <li>影子验证只使用纸面账户，不会发出真实交易指令。</li>
        </ul>
      </section>
    </DetailDialog>
  )
}

interface StrategyResearchPageProps {
  readonly requestData: InvestmentRequestData
  readonly selectedStrategyId: string
  readonly onSelectStrategy: (strategyId: string) => void
  readonly onOpenShadow: (strategyId: string) => void
  readonly onOpenReports: () => void
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly initialView?: 'pool' | 'shadow'
  readonly onOpenEvolution?: () => void
}

/** Event hypotheses, evidence and lifecycle decisions backed by the strategy store. */
export function StrategyResearchPage({
  requestData, selectedStrategyId, onSelectStrategy, onOpenShadow, onOpenReports, onAnalyze,
  initialView = 'pool', onOpenEvolution = () => {},
}: StrategyResearchPageProps) {
  const strategies = useDataResource(requestData)
  const alive = useAliveRef()
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState('')
  const [reportReady, setReportReady] = useState(false)
  const [view, setView] = useState<'pool' | 'shadow'>(initialView)
  const [filter, setFilter] = useState<StrategyFilter>('all')
  const [backtestYears, setBacktestYears] = useState<number>(2)
  const [detailItem, setDetailItem] = useState<Record<string, unknown>>()
  const [hypothesisPreview, setHypothesisPreview] = useState<StrategyHypothesisPreview>()
  const [hypothesisStatus, setHypothesisStatus] = useState('')
  useEffect(() => { setView(initialView) }, [initialView])
  const load = useCallback(() => {
    strategies.run({ operation: 'trading-core.strategies', input: { limit: 50 } })
  }, [strategies.run])
  useEffect(load, [load])
  const items = records(asRecord(strategies.state.value).items)
  const unresolvedSymbolKey = [...new Set(items.flatMap(item => (
    strategyTickers(item).filter(ticker => ticker.name === '').map(ticker => ticker.code)
  )))].sort().join('|')
  const [securityNames, setSecurityNames] = useState<Record<string, string>>({})
  useEffect(() => {
    const codes = unresolvedSymbolKey === '' ? [] : unresolvedSymbolKey.split('|')
    if (codes.length === 0) return
    const requestState = { cancelled: false }
    void (async () => {
      // The desktop bridge intentionally limits concurrent backend requests. Resolve
      // legacy strategy symbols in small batches so one large strategy pool does not
      // leave most cards stuck on machine codes after request saturation.
      for (let start = 0; start < codes.length; start += 3) {
        const batch = codes.slice(start, start + 3)
        const resolved = await Promise.all(batch.map(async (code): Promise<readonly [string, string]> => {
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
        setSecurityNames(current => ({ ...current, ...Object.fromEntries(resolved) }))
      }
    })()
    return () => { requestState.cancelled = true }
  }, [requestData, unresolvedSymbolKey])
  const filteredItems = filter === 'all' ? items : items.filter(item => strategyCategory(item) === filter)
  const categoryCounts = items.reduce<Record<StrategyCategory, number>>((counts, item) => {
    const category = strategyCategory(item)
    counts[category] += 1
    return counts
  }, { verified: 0, unverified: 0, failed: 0, archived: 0 })

  const previewHypotheses = async (): Promise<void> => {
    if (busyAction !== '') return
    setBusyAction('hypothesize-preview')
    setNotice('正在从真实事件生成只读假设预览…')
    setHypothesisStatus('')
    try {
      const result = asRecord(await requestData({
        operation: 'trading-core.strategies-hypothesize', input: { limit: 20, dry_run: true },
      }))
      if (!alive.current) return
      const hypotheses = records(result.hypotheses)
      setHypothesisPreview({
        eventCount: number(result.n_events),
        hypotheses,
        note: text(result.note, ''),
      })
      setNotice(hypotheses.length > 0
        ? `已生成 ${hypotheses.length} 条只读假设预览，确认前不会写入策略池。`
        : text(result.note, '本轮没有返回可预览的策略假设，未写入策略池。'))
    } catch (reason) {
      if (alive.current) setNotice(`预览生成失败：${productErrorText(reason)}`)
    } finally {
      if (alive.current) setBusyAction('')
    }
  }

  const confirmHypotheses = async (): Promise<void> => {
    if (busyAction !== '' || hypothesisPreview === undefined || hypothesisPreview.hypotheses.length === 0) return
    setBusyAction('hypothesize-commit')
    setHypothesisStatus('正在按你的确认把候选写入策略池…')
    try {
      const result = asRecord(await requestData({
        operation: 'trading-core.strategies-hypothesize', input: { limit: 20, dry_run: false },
      }))
      if (!alive.current) return
      const count = Array.isArray(result.candidates) ? result.candidates.length : 0
      setNotice(count > 0 ? `已确认加入 ${count} 个候选策略。` : text(result.note, '确认完成，但本轮没有新增候选策略。'))
      setHypothesisStatus('')
      setHypothesisPreview(undefined)
      load()
    } catch (reason) {
      if (alive.current) {
        const message = `加入失败：${productErrorText(reason)}。本次未写入候选池。`
        setHypothesisStatus(message)
        setNotice(message)
      }
    } finally {
      if (alive.current) setBusyAction('')
    }
  }

  const runStrategy = async (strategyId: string): Promise<void> => {
    if (busyAction !== '') return
    setBusyAction(`run:${strategyId}`); setNotice('正在启动样本内与样本外回测…'); setReportReady(false)
    try {
      const started = await requestData({
        operation: 'trading-core.strategy-run',
        input: { strategy_id: strategyId, lookback_years: backtestYears, oos_frac: 0.3, min_oos_trades: 4 },
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
      setReportReady(archived)
      load()
    } catch (reason) {
      if (alive.current) setNotice(productErrorText(reason))
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
      if (alive.current) setNotice(`状态更新失败：${productErrorText(reason)}`)
    } finally {
      if (alive.current) setBusyAction('')
    }
  }

  return (
    <div className={css.pageScroll}>
      <PageHeading title="策略研究" description="策略池与影子验证已合并；从假设、样本外证据到纸面验证在同一处完成">
        {view === 'pool' && <>
          <label className={css.backtestWindow} title="回测样本窗口：按 70% 样本内 / 30% 样本外切分，窗口越长样本外证据越足">
            <span>回测窗口</span>
            <select className={css.backtestWindowSelect} value={backtestYears} disabled={busyAction !== ''} onChange={(event) => { setBacktestYears(Number(event.target.value)) }}>
              {BACKTEST_WINDOW_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button type="button" className={css.secondaryButton} disabled={busyAction !== ''} onClick={load}>刷新</button>
          <button type="button" className={css.primaryButton} disabled={busyAction !== ''} onClick={() => { void previewHypotheses() }}>
            {busyAction === 'hypothesize-preview' ? '生成预览中…' : '从事件新建策略'}
          </button>
        </>}
      </PageHeading>
      <div className={css.segmented} role="group" aria-label="策略研究视图">
        <button type="button" aria-pressed={view === 'pool'} className={view === 'pool' ? css.segmentActive : undefined} onClick={() => { setView('pool') }}>策略池</button>
        <button type="button" aria-pressed={view === 'shadow'} className={view === 'shadow' ? css.segmentActive : undefined} onClick={() => { setView('shadow') }}>影子验证</button>
      </div>
      <section className={css.lifecyclePanel} aria-labelledby="strategy-lifecycle-title">
        <div className={css.lifecycleIntro}>
          <div><h2 id="strategy-lifecycle-title">策略生命周期</h2><small>每条策略都沿着真实证据逐步推进，不会自动进入下一阶段</small></div>
          {view === 'pool' && <span>新建方式：点击右上角“从事件新建策略”</span>}
        </div>
        <div className={css.lifecycleStrip} aria-label="策略生命周期步骤">
          <span data-state="active"><b>1</b><strong>事件形成假设</strong><small>从真实市场事件生成候选</small></span><i aria-hidden="true">→</i>
          <span><b>2</b><strong>样本外回测</strong><small>用未参与构建的数据验证</small></span><i aria-hidden="true">→</i>
          <span><b>3</b><strong>影子验证</strong><small>纸面账户跟踪真实行情</small></span><i aria-hidden="true">→</i>
          <span><b>4</b><strong>进化观察</strong><small>归因后人工确认升降级</small></span>
        </div>
      </section>
      {view === 'pool' ? <>
        <div className={css.contextHint}>AI 评审会自动读取当前策略上下文；页面只保存策略标识，不会复制或覆盖策略内容。</div>
        {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
        {reportReady && (
          <div className={css.moduleToolbar}>
            <button type="button" className={css.secondaryButton} onClick={onOpenReports}>查看本次投研报告</button>
          </div>
        )}
        <div className={`${css.segmented} ${css.strategyFilters}`} role="group" aria-label="策略验证分类">
          {(['all', 'verified', 'unverified', 'failed', 'archived'] as const).map((category) => {
            const count = category === 'all' ? items.length : categoryCounts[category]
            return (
              <button key={category} type="button" aria-pressed={filter === category} className={filter === category ? css.segmentActive : undefined} onClick={() => { setFilter(category) }}>
                {STRATEGY_CATEGORY_LABELS[category]} <span>{count}</span>
              </button>
            )
          })}
        </div>
        {strategies.state.phase === 'loading' && strategies.state.value === undefined && <BusyRows />}
        {strategies.state.phase === 'error' && <DataError message={strategies.state.error} retry={load} />}
        {strategies.state.phase !== 'error' && items.length === 0 && strategies.state.phase === 'success' && (
          <Empty>策略池尚无真实候选。先从事件生成假设，生成过程可能需要几十秒。</Empty>
        )}
        {strategies.state.phase === 'success' && items.length > 0 && filteredItems.length === 0 && (
          <Empty>当前分类暂无策略，可以切换分类查看完整策略池。</Empty>
        )}
        <section className={css.moduleGrid} aria-label="策略候选池">
          {filteredItems.map((item, index) => {
            const id = text(item.id, `strategy-${index}`)
            const status = text(item.status, '')
            const category = strategyCategory(item)
            const backtest = asRecord(item.backtest)
            const hasBacktest = Object.keys(backtest).length > 0
            const outOfSample = asRecord(backtest.out_of_sample)
            const outOfSampleTrades = number(outOfSample.trades) ?? number(outOfSample.n_evaluated)
            const selected = selectedStrategyId === id
            const direction = strategyDirectionLabel(item.direction)
            const holdingWindow = number(item.holding_window_days)?.toFixed(0)
            return (
              <article key={id} className={`${css.moduleCard} ${css.strategyCard} ${selected ? css.reportItemActive : ''}`}>
                <div className={css.sectionHeading}>
                  <div className={css.strategyCardTitle}>
                    {direction !== '' && <span data-direction={direction}>{direction}</span>}
                    <strong>{strategyTargetLabel(item, securityNames)}</strong>
                    <small>{strategyKindLabel(item.kind)}</small>
                  </div>
                  <div className={css.strategyCardBadges}>
                    <span>{STRATEGY_CATEGORY_LABELS[category]}</span>
                    <StatusBadge value={status} />
                  </div>
                </div>
                <p>{text(item.hypothesis, text(item.thesis, '后端未返回策略假设。'))}</p>
                <dl className={css.reportMeta}>
                  <div><dt>标的数</dt><dd>{strings(item.symbols).length || '—'}</dd></div>
                  <div><dt>建议观察</dt><dd>{holdingWindow === undefined ? '—' : `${holdingWindow} 天`}</dd></div>
                  <div><dt>样本外胜率</dt><dd>{compactMetric(outOfSample.win_rate_pct, '%')}</dd></div>
                  <div><dt>样本外交易</dt><dd>{outOfSampleTrades?.toFixed(0) ?? '—'}</dd></div>
                </dl>
                {hasBacktest && text(backtest.reason, '') !== '' && (
                  <p className={css.contextHint}>回测结论：{text(backtest.reason)}</p>
                )}
                <div className={css.moduleToolbar}>
                  <button type="button" className={css.secondaryButton} aria-haspopup="dialog" onClick={() => { setDetailItem(item) }}>查看详情</button>
                  <button type="button" className={css.secondaryButton} disabled={busyAction !== '' || category === 'archived'} onClick={() => { onSelectStrategy(id); void runStrategy(id) }}>
                    {busyAction === `run:${id}` ? '回测中…' : '运行回测'}
                  </button>
                  {status === 'candidate' && (
                    <button type="button" className={css.secondaryButton} disabled={busyAction !== '' || !hasBacktest} title={hasBacktest ? '人工确认策略生效' : '完成回测后才能确认生效'} onClick={() => { onSelectStrategy(id); void activate(id) }}>
                      {busyAction === `activate:${id}` ? '更新中…' : '人工确认生效'}
                    </button>
                  )}
                  <button type="button" className={css.secondaryButton} onClick={() => { onSelectStrategy(id); onAnalyze({ kind: 'strategy', strategyId: id }) }}>AI 评审</button>
                  <button type="button" className={css.primaryButton} disabled={status !== 'active'} onClick={() => { onSelectStrategy(id); setView('shadow'); onOpenShadow(id) }}>进入影子验证</button>
                </div>
              </article>
            )
          })}
        </section>
      </> : (
        <ShadowValidationPage
          embedded
          requestData={requestData}
          selectedStrategyId={selectedStrategyId}
          onOpenEvolution={onOpenEvolution}
          onOpenReports={onOpenReports}
          onAnalyze={onAnalyze}
        />
      )}
      {detailItem !== undefined && (
        <StrategyDetailDialog
          item={detailItem}
          busy={busyAction === `run:${text(detailItem.id, '')}`}
          onClose={() => { setDetailItem(undefined) }}
          onRun={() => {
            const id = text(detailItem.id, '')
            setDetailItem(undefined)
            if (id !== '') { onSelectStrategy(id); void runStrategy(id) }
          }}
          onAnalyze={() => {
            const id = text(detailItem.id, '')
            setDetailItem(undefined)
            if (id !== '') { onSelectStrategy(id); onAnalyze({ kind: 'strategy', strategyId: id }) }
          }}
          onShadow={() => {
            const id = text(detailItem.id, '')
            setDetailItem(undefined)
            if (id !== '') { onSelectStrategy(id); setView('shadow'); onOpenShadow(id) }
          }}
        />
      )}
      {hypothesisPreview !== undefined && (
        <HypothesisPreviewDialog
          preview={hypothesisPreview}
          busy={busyAction === 'hypothesize-commit'}
          status={hypothesisStatus}
          onClose={() => {
            setHypothesisPreview(undefined)
            setHypothesisStatus('')
          }}
          onConfirm={() => { void confirmHypotheses() }}
        />
      )}
    </div>
  )
}

interface ShadowValidationPageProps {
  readonly requestData: InvestmentRequestData
  readonly selectedStrategyId: string
  readonly onOpenEvolution: () => void
  readonly onOpenReports: () => void
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly embedded?: boolean
}

/** Paper-account evidence; no real order is placed from this UI. */
export function ShadowValidationPage({
  requestData, selectedStrategyId, onOpenEvolution, onOpenReports, onAnalyze, embedded = false,
}: ShadowValidationPageProps) {
  const status = useDataResource(requestData)
  const alive = useAliveRef()
  const positions = useDataResource(requestData)
  const equity = useDataResource(requestData)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [reportReady, setReportReady] = useState(false)
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
    setBusy(true); setNotice('正在启动影子验证…'); setReportReady(false)
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
        setReportReady(false)
      } else {
        const archived = Object.keys(asRecord(resultRecord.reports)).length > 0
        setNotice(archived
          ? '影子验证完成，正式结果已进入投研报告。'
          : '影子验证完成，但本次结果没有生成可归档报告。')
        setReportReady(archived)
      }
      load()
    } catch (reason) {
      if (alive.current) setNotice(productErrorText(reason))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const statusRecord = asRecord(status.state.value)
  const positionItems = records(asRecord(positions.state.value).items)
  const equityItems = records(asRecord(equity.state.value).items)
  const firstError = [status.state, positions.state, equity.state].find(item => item.phase === 'error')
  const initialLoading = [status.state, positions.state, equity.state]
    .some(item => item.phase === 'loading' && item.value === undefined)

  const content = <>
    {embedded ? (
      <div className={css.embeddedShadowHeader}>
        <div><h2>影子验证</h2><p>用真实行情在纸面账户验证已通过策略，不触发真实交易</p></div>
        <div>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={load}>刷新</button>
          <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void start() }}>{busy ? '验证中…' : '运行影子验证'}</button>
        </div>
      </div>
    ) : <PageHeading title="影子验证" description="用真实行情在纸面账户验证已生效策略，不触发真实交易">
      <button type="button" className={css.secondaryButton} disabled={busy} onClick={load}>刷新</button>
      <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void start() }}>{busy ? '验证中…' : '运行影子验证'}</button>
    </PageHeading>}
    <div className={css.lifecycleStrip} aria-label="当前验证对象">
      <span>策略研究</span><b aria-hidden="true">→</b><span>{selectedStrategyId === '' ? '全部生效策略' : selectedStrategyId}</span><b aria-hidden="true">→</b><span>自进化</span>
    </div>
    {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
    {firstError !== undefined && <DataError message={firstError.error} retry={load} />}
    {initialLoading && <BusyRows />}
    {!initialLoading && <section className={css.moduleGrid} aria-label="影子验证概览">
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
            const nav = selectedStrategyId === '' ? item.overall_nav : strategy.nav
            return (
              <div className={css.dataRow} key={`${text(item.date)}-${index}`}>
                <span>{text(item.date)}</span>
                <strong>{compactMetric(nav)}</strong>
              </div>
            )
          })}
          {equityItems.length === 0 && equity.state.phase === 'success' && <Empty>尚无净值历史，需要先运行影子验证。</Empty>}
        </div>
      </article>
    </section>}
    <div className={css.moduleToolbar}>
      {reportReady && <button type="button" className={css.secondaryButton} onClick={onOpenReports}>查看本次投研报告</button>}
      <button type="button" className={css.secondaryButton} onClick={() => {
        onAnalyze(selectedStrategyId === '' ? { kind: 'shadow' } : { kind: 'shadow', strategyId: selectedStrategyId })
      }}>AI 解读验证证据</button>
      <button type="button" className={css.primaryButton} onClick={onOpenEvolution}>进入自进化</button>
    </div>
  </>
  return embedded
    ? <section className={css.embeddedShadow}>{content}</section>
    : <div className={css.pageScroll}>{content}</div>
}

interface EvolutionPageProps {
  readonly requestData: InvestmentRequestData
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onOpenStock?: (code: string) => void
}

/** Preview-first evolution workflow with a deliberate write confirmation. */
export function EvolutionPage({ requestData, onAnalyze, onOpenStock = () => {} }: EvolutionPageProps) {
  const status = useDataResource(requestData)
  const alive = useAliveRef()
  const attribution = useDataResource(requestData)
  const pendingPreview = useDataResource(requestData)
  const [preview, setPreview] = useState<Record<string, unknown>>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(() => {
    status.run({ operation: 'trading-core.evolution-status' })
    attribution.run({ operation: 'trading-core.evolution-attribution' })
    pendingPreview.run({ operation: 'trading-core.evolution-preview' })
  }, [attribution.run, pendingPreview.run, status.run])
  useEffect(load, [load])
  useEffect(() => {
    if (pendingPreview.state.phase !== 'success') return
    const current = asRecord(pendingPreview.state.value)
    if (text(current.preview_status, '') === 'pending') setPreview(current)
  }, [pendingPreview.state.phase, pendingPreview.state.value])

  const evolve = async (apply: boolean): Promise<void> => {
    if (busy) return
    const previewToken = text(preview?.preview_token, '')
    if (apply && !/^[0-9a-f]{32}$/.test(previewToken)) {
      setNotice('当前预案缺少有效确认令牌，请重新生成预案。')
      return
    }
    setBusy(true); setNotice(apply ? '正在应用已预览的进化动作…' : '正在计算只读进化预案…')
    try {
      const result = asRecord(await requestData({
        operation: 'trading-core.evolution-run',
        input: apply ? { apply: true, preview_token: previewToken } : { apply: false },
      }))
      if (!alive.current) return
      setPreview(result)
      setNotice(apply ? '进化动作已应用，策略池状态已刷新。' : '预案已生成；确认前不会写入策略库。')
      if (apply) load()
    } catch (reason) {
      if (alive.current) {
        if (apply) setPreview(current => current === undefined ? current : { ...current, preview_status: 'invalid' })
        setNotice(`${apply ? '预案未应用' : '进化计算失败'}：${productErrorText(reason)}`)
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const statusRecord = asRecord(status.state.value)
  const counts = asRecord(statusRecord.counts)
  const attributionRecord = asRecord(attribution.state.value)
  const overall = asRecord(attributionRecord.overall)
  const strategyRows = records(attributionRecord.strategies)
  const unresolvedSymbolKey = [...new Set(strategyRows.flatMap(item => strings(item.symbols)))].sort().join('|')
  const [securityNames, setSecurityNames] = useState<Record<string, string>>({})
  useEffect(() => {
    const codes = unresolvedSymbolKey === '' ? [] : unresolvedSymbolKey.split('|')
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
        setSecurityNames(current => ({ ...current, ...Object.fromEntries(resolved) }))
      }
    })()
    return () => { requestState.cancelled = true }
  }, [requestData, unresolvedSymbolKey])
  const actions = records(preview?.actions)
  const perStrategy = records(preview?.per_strategy)
  const previewStatus = text(preview?.preview_status, '')
  const previewApplied = preview?.applied === true || previewStatus === 'applied'
    && text(preview?.status, '') !== 'waiting_data'
    && actions.length > 0
  const firstError = [status.state, attribution.state].find(item => item.phase === 'error')
  const days = number(statusRecord.days_of_data) ?? 0
  const minDays = number(statusRecord.min_days) ?? 0
  const readiness = minDays <= 0 ? 0 : Math.min(100, (days / minDays) * 100)
  const previewAvailable = preview !== undefined && previewStatus === 'pending'

  return (
    <div className={css.pageScroll}>
      <PageHeading title="自进化" description="闭环每日自动应用进化（升级/降级/淘汰/变异）；本页可查看归因证据与判定依据，必要时人工干预确认">
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={load}>刷新</button>
        <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void evolve(false) }}>{busy ? '计算中…' : '生成进化预案'}</button>
      </PageHeading>
      <div className={css.evolutionGuide}>闭环已自动应用每日进化；本页可查看归因证据、各策略判定依据，手动确认仅作为干预入口。点击下面的步骤卡即可前往对应区域。</div>
      <section className={css.evolutionFlow} aria-label="自进化流程">
        <div data-state={days > 0 ? 'completed' : 'active'}><span>1</span><strong>累积影子数据</strong><small>{days}/{minDays || '—'} 个交易日</small></div>
        <button type="button" data-state={strategyRows.length > 0 ? 'completed' : days > 0 ? 'active' : undefined} onClick={() => { document.getElementById('evolution-evidence')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}><span>2</span><strong>查看策略归因</strong><small>{strategyRows.length} 条策略证据 · 点击查看</small></button>
        <button type="button" data-state={previewAvailable || previewApplied ? 'completed' : statusRecord.ready === true ? 'active' : undefined} disabled={busy} onClick={() => { void evolve(false) }}><span>3</span><strong>生成只读预案</strong><small>升降级、淘汰或变异 · 点击生成</small></button>
        <button type="button" data-state={previewApplied ? 'completed' : previewAvailable ? 'active' : undefined} disabled={!previewAvailable} onClick={() => { document.getElementById('evolution-preview-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}><span>4</span><strong>人工确认应用</strong><small>{previewAvailable ? '预案已就绪 · 点击核对' : '生成预案后可操作'}</small></button>
      </section>
      {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
      {firstError !== undefined && <DataError message={firstError.error} retry={load} />}
      {status.state.phase === 'loading' && status.state.value === undefined
        && attribution.state.phase === 'loading' && attribution.state.value === undefined && <BusyRows />}
      <section className={css.moduleGrid} aria-label="进化状态与归因">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>闭环就绪状态</strong><StatusBadge value={statusRecord.ready === true ? 'done' : 'waiting_data'} /></div>
          <div className={css.evolutionReadiness}>
            <div><span>数据完成度</span><strong>{Math.round(readiness)}%</strong></div>
            <progress max="100" value={readiness} aria-label="自进化数据完成度" />
            <small>{text(statusRecord.note, statusRecord.ready === true ? '数据门槛已满足；闭环会自动应用进化，生成预案可查看判定依据。' : '继续运行影子验证以累积真实数据。')}</small>
          </div>
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
        <article id="evolution-evidence" className={`${css.moduleCard} ${css.evolutionEvidenceCard}`}>
          <div className={css.sectionHeading}><strong>分策略证据</strong><span>{strategyRows.length} 项</span></div>
          <div className={css.dataList}>
            {strategyRows.slice(0, 10).map((item, index) => {
              const symbols = strings(item.symbols)
              const primaryCode = symbols[0]
              return (
                <button
                  type="button"
                  className={css.dataRow}
                  disabled={primaryCode === undefined}
                  key={`${text(item.strategy_id)}-${index}`}
                  onClick={() => { if (primaryCode !== undefined) onOpenStock(primaryCode) }}
                >
                  <div>
                    <strong>{strategyTargetLabel(item, securityNames)}</strong>
                    <small>{strategyKindLabel(item.kind)} · 回撤 {compactMetric(item.max_drawdown_pct, '%')} · 平仓胜率 {compactMetric(item.closed_win_rate_pct, '%')}</small>
                  </div>
                  <span className={css.evolutionEvidenceMeta}><strong>{compactMetric(item.return_pct, '%')}</strong><small>{primaryCode === undefined ? '暂无股票标的' : '查看个股 →'}</small></span>
                </button>
              )
            })}
            {strategyRows.length === 0 && attribution.state.phase === 'success' && <Empty>影子证据不足，暂不能归因。</Empty>}
          </div>
        </article>
      </section>
      {preview !== undefined && (
        <section className={css.confirmPanel} aria-labelledby="evolution-preview-title">
          <div>
            <h2 id="evolution-preview-title">{previewApplied ? '进化动作已应用' : '进化动作预览'}</h2>
            <p>{actions.length === 0
              ? text(preview.data_note, text(preview.note, preview.last_applied_at
                ? `闭环已自动应用上一轮进化（${text(preview.last_applied_at)}），下方为各策略判定依据。`
                : '闭环每日自动应用进化；下方为各策略判定依据。'))
              : previewApplied ? `已按确认预案应用 ${actions.length} 项动作。` : `共 ${actions.length} 项；确认后将写入策略库。`}</p>
          </div>
          <div className={css.dataList}>
            {actions.map((item, index) => {
              const source = strategyRows.find(strategy => text(strategy.strategy_id, '') === text(item.parent, text(item.sid, '')))
              const actionSymbols = strings(item.symbols)
              const primaryCode = actionSymbols[0] ?? strings(source?.symbols)[0]
              const target = source === undefined
                ? (primaryCode === undefined ? strategyKindLabel(item.kind) : `${securityNames[primaryCode] || '股票'} · ${primaryCode}`)
                : strategyTargetLabel(source, securityNames)
              return (
                <div className={css.dataRow} key={`${text(item.sid)}-${text(item.type)}-${index}`}>
                  <div><strong>{target}</strong><small>{text(item.reason)}</small></div>
                  <div className={css.evolutionActionMeta}>
                    <StatusBadge value={text(item.type)} />
                    {primaryCode !== undefined && <button type="button" onClick={() => { onOpenStock(primaryCode) }}>查看个股</button>}
                  </div>
                </div>
              )
            })}
            {actions.length === 0 && perStrategy.map((item, index) => (
              <div className={css.dataRow} key={`per-strategy-${text(item.strategy_id)}-${index}`}>
                <div>
                  <strong>{strategyTargetLabel(item, securityNames)}</strong>
                  <small>{text(item.reason)}</small>
                </div>
                <span className={css.evolutionEvidenceMeta}>
                  <strong>净值 {compactMetric(item.nav)}</strong>
                  <small>{text(item.behavior)}</small>
                </span>
              </div>
            ))}
          </div>
          <div className={css.moduleToolbar}>
            <button type="button" className={css.secondaryButton} disabled={previewStatus !== 'pending'} onClick={() => { onAnalyze({ kind: 'evolution' }) }}>AI 复核预案</button>
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
  readonly onOpenStock: (code: string) => void
}

type IndustryDataStatus = 'missing' | 'downloading' | 'ready' | 'error'

interface IndustryCompanySelection {
  readonly code: string
  readonly name: string
}

function industryDataStatus(value: unknown): IndustryDataStatus | '' {
  const status = text(asRecord(value).status, '')
  return status === 'missing' || status === 'downloading' || status === 'ready' || status === 'error'
    ? status
    : ''
}

function industryCount(value: unknown, suffix: string): string {
  const resolved = number(value)
  return resolved === undefined ? '—' : `${new Intl.NumberFormat('zh-CN').format(resolved)}${suffix}`
}

function industryRelation(value: unknown): string {
  const relation = text(value, '')
  return { direct: '直接关系', indirect: '间接关系' }[relation] ?? (relation === '' ? '关系未标注' : '其他关系')
}

function IndustryResourceFeedback({
  state, loading, unavailable, retry,
}: {
  readonly state: DataState
  readonly loading: string
  readonly unavailable: string
  readonly retry: () => void
}) {
  if (state.phase === 'loading' && state.value !== undefined) {
    return <div className={css.industryResourceNotice} role="status">{loading}，仍显示上次成功的数据。</div>
  }
  if (state.phase !== 'error') return null
  const retained = state.value !== undefined
  return (
    <div className={css.errorCard} data-retained={retained || undefined} role="alert">
      <div>
        <strong>{retained ? '刷新失败，继续显示上次数据' : '真实数据暂不可用'}</strong>
        <p>{unavailable}</p>
      </div>
      <button type="button" onClick={retry}>重试</button>
    </div>
  )
}

type IndustryGraphDirection = 'center' | 'up' | 'down'

interface IndustryGraphNodeData {
  readonly id: string
  readonly name: string
  readonly code: string
  readonly label: string
  readonly direction: IndustryGraphDirection
  readonly depth: number
  readonly expandable: boolean
  readonly share: number | undefined
  readonly x: number
  readonly y: number
}

interface IndustryGraphEdgeData {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly direction: 'up' | 'down'
}

interface IndustryGraphData {
  readonly nodes: readonly IndustryGraphNodeData[]
  readonly edges: readonly IndustryGraphEdgeData[]
}

interface IndustryGraphParticle {
  x: number
  y: number
  vx: number
  vy: number
  readonly targetX: number
  readonly targetY: number
  readonly direction: IndustryGraphDirection
}

function industryGraphData(
  center: Record<string, unknown>,
  upLevels: readonly Record<string, unknown>[],
  downLevels: readonly Record<string, unknown>[],
): IndustryGraphData {
  const nodes: IndustryGraphNodeData[] = []
  const edges: IndustryGraphEdgeData[] = []
  const centerCode = text(center.code, '')
  const centerName = text(center.name, '未命名公司')
  const centerId = `center-${centerCode || text(center.id, 'company')}`
  nodes.push({
    id: centerId,
    name: centerName,
    code: centerCode,
    label: centerCode === '' ? centerName : `${centerName}\n${centerCode}`,
    direction: 'center',
    depth: 0,
    expandable: true,
    share: undefined,
    x: 0,
    y: 0,
  })

  const appendLevels = (levels: readonly Record<string, unknown>[], direction: 'up' | 'down'): void => {
    const identifiers = new Map<string, string>()
    for (const value of [centerCode, text(center.id, ''), centerName]) {
      if (value !== '') identifiers.set(value, centerId)
    }
    for (const [levelIndex, level] of levels.entries()) {
      const levelNodes = records(level.nodes)
      const rawDepth = number(level.level)
      const depth = rawDepth === undefined ? levelIndex + 1 : Math.abs(rawDepth)
      const levelIds: Array<readonly [Record<string, unknown>, string]> = []
      for (const [nodeIndex, node] of levelNodes.entries()) {
        const rawId = text(node.id, text(node.name, `node-${nodeIndex}`))
        const nodeId = `${direction}-${depth}-${nodeIndex}-${rawId}`
        levelIds.push([node, nodeId])
        for (const value of [rawId, text(node.name, ''), text(node.code, '')]) {
          if (value !== '') identifiers.set(value, nodeId)
        }
      }
      for (const [nodeIndex, [node, nodeId]] of levelIds.entries()) {
        const name = text(node.name, '未命名环节')
        const code = text(node.code, '')
        const parentId = identifiers.get(text(node.parent_id, '')) ?? centerId
        const count = Math.max(levelIds.length, 1)
        const y = (nodeIndex - (count - 1) / 2) * 116
        const x = (direction === 'up' ? -1 : 1) * depth * 260
        nodes.push({
          id: nodeId,
          name,
          code,
          label: code === '' ? name : `${name}\n${code}`,
          direction,
          depth,
          expandable: code !== '',
          share: number(node.share),
          x,
          y,
        })
        edges.push({
          id: `edge-${direction}-${depth}-${nodeIndex}`,
          source: direction === 'up' ? nodeId : parentId,
          target: direction === 'up' ? parentId : nodeId,
          direction,
        })
      }
    }
  }

  appendLevels(upLevels, 'up')
  appendLevels(downLevels, 'down')
  return { nodes, edges }
}

function IndustryPhysicsGraph({
  center, upLevels, downLevels, onDrill, onLeaf, onReady,
}: {
  readonly center: Record<string, unknown>
  readonly upLevels: readonly Record<string, unknown>[]
  readonly downLevels: readonly Record<string, unknown>[]
  readonly onDrill: (company: IndustryCompanySelection) => void
  readonly onLeaf: (name: string) => void
  readonly onReady: (reset: (() => void) | undefined) => void
}) {
  const graph = useMemo(() => industryGraphData(center, upLevels, downLevels), [center, downLevels, upLevels])
  const particles = useRef(new Map<string, IndustryGraphParticle>())
  const frame = useRef<number>()
  const activeUntil = useRef(0)
  const interaction = useRef<{
    readonly kind: 'node' | 'pan'
    readonly pointerId: number
    readonly nodeId: string
    clientX: number
    clientY: number
    readonly panX: number
    readonly panY: number
    moved: boolean
  }>()
  const [positions, setPositions] = useState<Record<string, { readonly x: number; readonly y: number }>>({})
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)

  const renderParticles = useCallback(() => {
    setPositions(Object.fromEntries([...particles.current].map(([id, value]) => [id, { x: value.x, y: value.y }])))
  }, [])

  const runPhysics = useCallback((duration = 760) => {
    activeUntil.current = Math.max(activeUntil.current, performance.now() + duration)
    if (frame.current !== undefined) return
    const tick = (): void => {
      const values = [...particles.current.entries()]
      const draggedId = interaction.current?.kind === 'node' ? interaction.current.nodeId : ''
      for (const [id, particle] of values) {
        if (particle.direction === 'center' || id === draggedId) continue
        particle.vx += (particle.targetX - particle.x) * 0.012
        particle.vy += (particle.targetY - particle.y) * 0.006
      }
      for (let left = 0; left < values.length; left += 1) {
        for (let right = left + 1; right < values.length; right += 1) {
          const aEntry = values[left]
          const bEntry = values[right]
          if (aEntry === undefined || bEntry === undefined) continue
          const [, a] = aEntry
          const [, b] = bEntry
          const dx = b.x - a.x || 0.1
          const dy = b.y - a.y || 0.1
          const distanceSquared = Math.max(dx * dx + dy * dy, 900)
          if (distanceSquared > 90_000) continue
          const distance = Math.sqrt(distanceSquared)
          const force = 680 / distanceSquared
          const fx = dx / distance * force * 38
          const fy = dy / distance * force * 38
          if (a.direction !== 'center') { a.vx -= fx; a.vy -= fy }
          if (b.direction !== 'center') { b.vx += fx; b.vy += fy }
        }
      }
      for (const edge of graph.edges) {
        const source = particles.current.get(edge.source)
        const target = particles.current.get(edge.target)
        if (source === undefined || target === undefined) continue
        const dx = target.x - source.x
        const dy = target.y - source.y
        const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const stretch = (distance - 218) * 0.0028
        const fx = dx / distance * stretch
        const fy = dy / distance * stretch
        if (source.direction !== 'center' && edge.source !== draggedId) { source.vx += fx; source.vy += fy }
        if (target.direction !== 'center' && edge.target !== draggedId) { target.vx -= fx; target.vy -= fy }
      }
      let movement = 0
      for (const [id, particle] of values) {
        if (particle.direction === 'center') {
          particle.x = 0
          particle.y = 0
          particle.vx = 0
          particle.vy = 0
          continue
        }
        if (id === draggedId) continue
        particle.vx *= 0.82
        particle.vy *= 0.82
        particle.x += particle.vx
        particle.y += particle.vy
        movement += Math.abs(particle.vx) + Math.abs(particle.vy)
      }
      renderParticles()
      if (performance.now() < activeUntil.current || movement > 0.16) frame.current = window.requestAnimationFrame(tick)
      else frame.current = undefined
    }
    frame.current = window.requestAnimationFrame(tick)
  }, [graph.edges, renderParticles])

  useEffect(() => {
    const next = new Map<string, IndustryGraphParticle>()
    for (const node of graph.nodes) {
      next.set(node.id, {
        x: node.x * 0.86,
        y: node.y * 0.82,
        vx: 0,
        vy: 0,
        targetX: node.x,
        targetY: node.y,
        direction: node.direction,
      })
    }
    particles.current = next
    renderParticles()
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion) runPhysics(620)
    return () => {
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
      frame.current = undefined
    }
  }, [graph.nodes, renderParticles, runPhysics])

  useEffect(() => {
    onReady(() => {
      setPan({ x: 0, y: 0 })
      setZoom(1)
      runPhysics(420)
    })
    return () => { onReady(undefined) }
  }, [onReady, runPhysics])

  const startNodeDrag = (event: ReactPointerEvent<SVGGElement>, node: IndustryGraphNodeData): void => {
    if (node.direction === 'center' || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    interaction.current = {
      kind: 'node', pointerId: event.pointerId, nodeId: node.id,
      clientX: event.clientX, clientY: event.clientY, panX: pan.x, panY: pan.y, moved: false,
    }
    runPhysics(1_200)
  }
  const startPan = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    interaction.current = {
      kind: 'pan', pointerId: event.pointerId, nodeId: '',
      clientX: event.clientX, clientY: event.clientY, panX: pan.x, panY: pan.y, moved: false,
    }
  }
  const movePointer = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const active = interaction.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = rect.width === 0 ? 1 : 1_280 / rect.width
    const dx = (event.clientX - active.clientX) * scale / zoom
    const dy = (event.clientY - active.clientY) * scale / zoom
    if (Math.abs(dx) + Math.abs(dy) > 3) active.moved = true
    if (active.kind === 'pan') {
      setPan({ x: active.panX + dx * zoom, y: active.panY + dy * zoom })
      return
    }
    const particle = particles.current.get(active.nodeId)
    if (particle === undefined) return
    particle.x += dx
    particle.y += dy
    active.clientX = event.clientX
    active.clientY = event.clientY
    renderParticles()
  }
  const stopPointer = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const active = interaction.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    interaction.current = undefined
    if (active.kind === 'node') {
      const node = graph.nodes.find(item => item.id === active.nodeId)
      if (!active.moved && node !== undefined) {
        if (node.code === '') onLeaf(node.name)
        else onDrill({ code: node.code, name: node.name })
      } else {
        runPhysics(900)
      }
    }
  }
  const zoomGraph = (event: ReactWheelEvent<SVGSVGElement>): void => {
    event.preventDefault()
    setZoom(current => Math.min(2.2, Math.max(0.42, current * Math.exp(-event.deltaY * 0.0012))))
  }

  return (
    <svg
      className={css.industryPhysicsGraph}
      viewBox="-640 -400 1280 800"
      role="img"
      aria-label="可缩放、可拖动节点的产业链物理图谱"
      onPointerDown={startPan}
      onPointerMove={movePointer}
      onPointerUp={stopPointer}
      onPointerCancel={stopPointer}
      onWheel={zoomGraph}
    >
      <defs>
        <marker id="industry-graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 Z" />
        </marker>
      </defs>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        <g className={css.industryPhysicsEdges}>
          {graph.edges.map((edge) => {
            const source = positions[edge.source]
            const target = positions[edge.target]
            if (source === undefined || target === undefined) return null
            return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />
          })}
        </g>
        <g className={css.industryPhysicsNodes}>
          {graph.nodes.map((node) => {
            const position = positions[node.id] ?? { x: node.x, y: node.y }
            return (
              <g
                key={node.id}
                data-graph-node
                data-direction={node.direction}
                data-expandable={node.expandable || undefined}
                role={node.direction === 'center' ? undefined : 'button'}
                tabIndex={node.direction === 'center' ? undefined : 0}
                aria-label={node.direction === 'center'
                  ? `中心公司 ${node.name} ${node.code}`
                  : `${node.name}${node.code === '' ? '，叶子节点' : `，点击钻取 ${node.code}`}`}
                transform={`translate(${position.x} ${position.y})`}
                onPointerDown={(event) => { startNodeDrag(event, node) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (node.code === '') onLeaf(node.name)
                  else onDrill({ code: node.code, name: node.name })
                }}
              >
                <rect x={node.direction === 'center' ? -92 : -79} y={node.direction === 'center' ? -36 : -29} width={node.direction === 'center' ? 184 : 158} height={node.direction === 'center' ? 72 : 58} rx="12" />
                <text textAnchor="middle" dominantBaseline="middle">
                  <tspan x="0" dy={node.code === '' ? '0' : '-0.55em'}>{node.name}</tspan>
                  {node.code !== '' && <tspan x="0" dy="1.5em">{node.code}</tspan>}
                </text>
              </g>
            )
          })}
        </g>
      </g>
    </svg>
  )
}

/** Industry graph, company lookup and event transmission backed by two registered services. */
export function IndustryChainPage({ requestData, query, onQuery, onAnalyze, onOpenStock }: IndustryChainPageProps) {
  const dataStatus = useDataResource(requestData)
  const stats = useDataResource(requestData)
  const companies = useDataResource(requestData)
  const securityMatches = useDataResource(requestData)
  const chain = useDataResource(requestData)
  const impact = useDataResource(requestData)
  const alive = useAliveRef()
  const bootstrapPoll = useRef<number>()
  const initialQuery = useRef(query.trim())
  const initialSearchPending = useRef(initialQuery.current !== '')
  const chainExpandButtonRef = useRef<HTMLButtonElement>(null)
  const chainCloseButtonRef = useRef<HTMLButtonElement>(null)
  const chainGraphResetRef = useRef<() => void>()
  const [searchedKeyword, setSearchedKeyword] = useState('')
  const [searchAttempted, setSearchAttempted] = useState(false)
  const [searchValidation, setSearchValidation] = useState('')
  const [selectedCompany, setSelectedCompany] = useState<IndustryCompanySelection>()
  const [chainPath, setChainPath] = useState<readonly IndustryCompanySelection[]>([])
  const [chainLeafNotice, setChainLeafNotice] = useState('')
  const [impactSecurityNames, setImpactSecurityNames] = useState<Record<string, string>>({})
  const [chainExpanded, setChainExpanded] = useState(false)
  const [bootstrapBusy, setBootstrapBusy] = useState(false)
  const [bootstrapFailed, setBootstrapFailed] = useState(false)
  const closeExpandedChain = useCallback(() => {
    setChainExpanded(false)
    window.setTimeout(() => { chainExpandButtonRef.current?.focus() }, 0)
  }, [])
  useEffect(() => {
    if (!chainExpanded) return
    chainCloseButtonRef.current?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeExpandedChain()
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown) }
  }, [chainExpanded, closeExpandedChain])
  const stopBootstrapPoll = useCallback(() => {
    const timer = bootstrapPoll.current
    bootstrapPoll.current = undefined
    if (timer !== undefined) window.clearInterval(timer)
  }, [])

  const loadDataStatus = useCallback(() => {
    dataStatus.run({ operation: 'industry-chain.data-status' })
  }, [dataStatus.run])
  const loadStats = useCallback(() => {
    stats.run({ operation: 'industry-chain.stats' })
  }, [stats.run])
  const loadImpact = useCallback(() => {
    impact.run({ operation: 'trading-core.personalized-impact', input: { limit: 20 } })
  }, [impact.run])
  const searchCompanies = useCallback((keyword: string) => {
    const cleanKeyword = keyword.trim()
    if (cleanKeyword === '') {
      setSearchValidation('请输入公司名称、行业或股票代码。')
      return
    }
    setSearchValidation('')
    setSearchedKeyword(cleanKeyword)
    setSearchAttempted(true)
    companies.run({ operation: 'industry-chain.companies', input: { keyword: cleanKeyword, limit: 20 } })
    securityMatches.run({ operation: 'market-watch.security-search', input: { query: cleanKeyword, limit: 8 } })
  }, [companies.run, securityMatches.run])
  const loadChain = useCallback((company: IndustryCompanySelection) => {
    setChainLeafNotice('')
    chain.run({ operation: 'industry-chain.chain', input: { code: company.code } })
  }, [chain.run])
  const selectChainCompany = useCallback((company: IndustryCompanySelection, path?: readonly IndustryCompanySelection[]) => {
    setSelectedCompany(company)
    setChainPath(current => path ?? [...current, company])
    loadChain(company)
  }, [loadChain])
  const drillChainNode = useCallback((company: IndustryCompanySelection) => {
    setChainPath((current) => {
      const existing = current.findIndex(item => item.code === company.code)
      return existing >= 0 ? current.slice(0, existing + 1) : [...current, company]
    })
    setSelectedCompany(company)
    loadChain(company)
  }, [loadChain])
  const showChainLeaf = useCallback((name: string) => {
    setChainLeafNotice(`${name} 当前没有可继续展开的上市公司链路。`)
  }, [])
  const receiveChainGraphReset = useCallback((reset: (() => void) | undefined) => {
    chainGraphResetRef.current = reset
  }, [])

  useEffect(loadDataStatus, [loadDataStatus])
  useEffect(loadImpact, [loadImpact])

  const status = industryDataStatus(dataStatus.state.value)
  const industryReady = status === 'ready'
  useEffect(() => {
    if (!industryReady) return
    loadStats()
    if (initialSearchPending.current) {
      initialSearchPending.current = false
      searchCompanies(initialQuery.current)
    }
  }, [industryReady, loadStats, searchCompanies])

  useEffect(() => {
    if (status !== 'downloading' || bootstrapBusy) return
    const timer = window.setInterval(loadDataStatus, 900)
    return () => { window.clearInterval(timer) }
  }, [bootstrapBusy, loadDataStatus, status])
  useEffect(() => stopBootstrapPoll, [stopBootstrapPoll])

  const bootstrapData = useCallback(async (): Promise<void> => {
    if (bootstrapBusy) return
    setBootstrapBusy(true)
    setBootstrapFailed(false)
    bootstrapPoll.current = window.setInterval(loadDataStatus, 900)
    try {
      const result = asRecord(await requestData({ operation: 'industry-chain.data-bootstrap' }))
      if (!alive.current) return
      setBootstrapFailed(text(result.status, '') === 'error')
    } catch {
      if (alive.current) setBootstrapFailed(true)
    } finally {
      stopBootstrapPoll()
      if (alive.current) {
        setBootstrapBusy(false)
        loadDataStatus()
      }
    }
  }, [alive, bootstrapBusy, loadDataStatus, requestData, stopBootstrapPoll])

  const refresh = useCallback(() => {
    loadDataStatus()
    loadImpact()
    if (!industryReady) return
    loadStats()
    if (searchedKeyword !== '') searchCompanies(searchedKeyword)
    if (selectedCompany !== undefined) loadChain(selectedCompany)
  }, [industryReady, loadChain, loadDataStatus, loadImpact, loadStats, searchCompanies, searchedKeyword, selectedCompany])

  const companyItems = records(asRecord(companies.state.value).items)
  const companyCodes = new Set(companyItems.map(item => text(item.code, '').trim()).filter(Boolean))
  const securityOnlyItems = records(asRecord(securityMatches.state.value).items)
    .filter(item => {
      const code = text(item.code, '').trim()
      return code !== '' && !companyCodes.has(code)
    })
  const chainValue = asRecord(chain.state.value)
  const center = asRecord(chainValue.center)
  const upLevels = records(chainValue.up_levels)
  const downLevels = records(chainValue.down_levels)
  const events = records(asRecord(impact.state.value).events)
  const seededImpactNames: Record<string, string> = {}
  const impactCodes = new Set<string>()
  for (const event of events) {
    for (const ticker of tickerItems(event.tickers)) {
      impactCodes.add(ticker.code)
      if (ticker.name !== '') seededImpactNames[ticker.code] = ticker.name
    }
    for (const code of strings(event.impact_codes)) impactCodes.add(code)
    Object.assign(seededImpactNames, impactSourceSecurityNames(event.impact_by))
  }
  const unresolvedImpactCodeKey = [...impactCodes]
    .filter(code => (impactSecurityNames[code] ?? seededImpactNames[code] ?? '') === '')
    .sort()
    .join('|')
  useEffect(() => {
    const codes = unresolvedImpactCodeKey === '' ? [] : unresolvedImpactCodeKey.split('|')
    if (codes.length === 0) return
    const requestState = { cancelled: false }
    void (async () => {
      for (let start = 0; start < codes.length; start += 4) {
        const batch = codes.slice(start, start + 4)
        const resolved = await Promise.all(batch.map(async (code): Promise<readonly [string, string]> => {
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
        setImpactSecurityNames(current => ({ ...current, ...Object.fromEntries(resolved) }))
      }
    })()
    return () => { requestState.cancelled = true }
  }, [requestData, unresolvedImpactCodeKey])
  const statsValue = asRecord(stats.state.value)
  const statusValue = asRecord(dataStatus.state.value)
  const filesCompleted = number(statusValue.files_completed) ?? 0
  const filesTotal = number(statusValue.files_total) ?? 5
  const downloadedBytes = number(statusValue.downloaded_bytes) ?? 0
  const downloadActive = bootstrapBusy || status === 'downloading'
  const downloadFailed = bootstrapFailed || status === 'error'
  const selectedReference = selectedCompany === undefined
    ? ''
    : `${selectedCompany.code} ${selectedCompany.name}`.trim()
  const securityNames = { ...seededImpactNames, ...impactSecurityNames }
  const chainNavigationNodes = [
    ...upLevels.flatMap(level => records(level.nodes).map(node => ({ node, direction: '上游' }))),
    ...downLevels.flatMap(level => records(level.nodes).map(node => ({ node, direction: '下游' }))),
  ]
  const renderStockLinks = (codes: readonly string[], empty: string): ReactNode => {
    if (codes.length === 0) return empty
    return (
      <span className={css.securityLinkList}>
        {codes.map((code) => {
          const name = securityNames[code] ?? ''
          const label = name === '' ? code : `${name} · ${code}`
          return (
            <button
              type="button"
              className={css.codeButton}
              key={code}
              aria-label={`查看${label}个股详情`}
              onClick={() => { onOpenStock(code) }}
            >{label}</button>
          )
        })}
      </span>
    )
  }

  const renderLevels = (levels: readonly Record<string, unknown>[], direction: 'up' | 'down'): ReactNode => {
    if (levels.length === 0) {
      return <div className={css.industryLayerEmpty}>当前没有返回{direction === 'up' ? '上游' : '下游'}关系。</div>
    }
    return levels.map((level, levelIndex) => {
      const nodes = records(level.nodes)
      const rawLevel = number(level.level)
      const depth = rawLevel === undefined ? levelIndex + 1 : Math.abs(rawLevel)
      return (
        <section className={css.industryLayer} key={`${direction}-${depth}-${levelIndex}`}>
          <h4>{direction === 'up' ? '上游' : '下游'}第 {depth} 层</h4>
          {nodes.length === 0
            ? <div className={css.industryLayerEmpty}>本层没有返回关系。</div>
            : nodes.map((node, nodeIndex) => {
              const share = number(node.share)
              return (
                <article className={css.industryNode} key={`${text(node.id, text(node.name, 'node'))}-${nodeIndex}`}>
                  <div className={css.sectionHeading}>
                    <strong>{text(node.name, '未命名环节')}</strong>
                    {share !== undefined && <span>{share.toFixed(1)}%</span>}
                  </div>
                  <dl className={css.reportMeta}>
                    <div><dt>传导环节</dt><dd>{text(node.via, '未标注')}</dd></div>
                    <div><dt>关系类型</dt><dd>{industryRelation(node.type)}</dd></div>
                  </dl>
                  {text(node.note, '') !== '' && <p>{text(node.note, '')}</p>}
                </article>
              )
            })}
        </section>
      )
    })
  }

  const renderChainLayout = (expanded = false): ReactNode => (
    <div className={`${css.industryChainLayout} ${expanded ? css.industryChainLayoutExpanded : ''}`}>
      <div className={css.industryDirection} aria-label="上游分层关系">
        <h3>上游</h3>
        {renderLevels(upLevels, 'up')}
      </div>
      <article className={css.industryCenter}>
        <span>中心公司</span>
        <h3>{text(center.name, selectedCompany?.name ?? '未命名公司')}</h3>
        <strong>{text(center.code, selectedCompany?.code ?? '')}</strong>
        <p>{text(center.industry, '行业未标注')}</p>
        <dl className={css.reportMeta}>
          <div><dt>原材料</dt><dd>{industryCount(center.material_count, ' 项')}</dd></div>
          <div><dt>供应关系</dt><dd>{industryCount(center.supplier_count, ' 条')}</dd></div>
          <div><dt>主营产品</dt><dd>{industryCount(center.product_count, ' 项')}</dd></div>
          <div><dt>客户关系</dt><dd>{industryCount(center.customer_count, ' 条')}</dd></div>
        </dl>
      </article>
      <div className={css.industryDirection} aria-label="下游分层关系">
        <h3>下游</h3>
        {renderLevels(downLevels, 'down')}
      </div>
    </div>
  )

  const expandedChainDialog = chainExpanded && (
    <div className={css.industryGraphBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeExpandedChain()
    }}>
      <section
        className={css.industryGraphDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="industry-graph-dialog-title"
        aria-describedby="industry-graph-dialog-hint"
      >
        <header className={css.industryGraphHeader}>
          <div>
            <span>产业链图谱</span>
            <h2 id="industry-graph-dialog-title">
              {text(center.name, selectedCompany?.name ?? '未命名公司')} · {text(center.code, selectedCompany?.code ?? '')}
            </h2>
            <p id="industry-graph-dialog-hint">拖动画布平移、滚轮缩放；拖动节点可感受关系回弹，点击带代码的节点继续上下钻。</p>
          </div>
          <div className={css.moduleToolbar}>
            <button type="button" className={css.secondaryButton} onClick={() => {
              chainGraphResetRef.current?.()
            }}>适应画布</button>
            <button ref={chainCloseButtonRef} type="button" className={css.secondaryButton} onClick={closeExpandedChain}>关闭</button>
          </div>
        </header>
        <nav className={css.industryGraphBreadcrumbs} aria-label="产业链钻取路径">
          {chainPath.map((company, index) => (
            <span key={`${company.code}-${index}`}>
              {index > 0 && <i aria-hidden="true">›</i>}
              <button
                type="button"
                aria-current={index === chainPath.length - 1 ? 'page' : undefined}
                onClick={() => { selectChainCompany(company, chainPath.slice(0, index + 1)) }}
              >{company.name || company.code}</button>
            </span>
          ))}
        </nav>
        <div className={css.industryGraphViewport}>
          <IndustryPhysicsGraph
            center={center}
            upLevels={upLevels}
            downLevels={downLevels}
            onDrill={drillChainNode}
            onLeaf={showChainLeaf}
            onReady={receiveChainGraphReset}
          />
          <aside className={css.industryGraphNavigator} aria-label="可钻取公司节点">
            <strong>继续钻取</strong>
            {chainNavigationNodes.map(({ node, direction }, index) => {
              const name = text(node.name, '未命名环节')
              const code = text(node.code, '')
              return (
                <button
                  type="button"
                  disabled={code === ''}
                  key={`${direction}-${text(node.id, name)}-${index}`}
                  onClick={() => {
                    if (code === '') setChainLeafNotice(`${name} 当前没有可继续展开的上市公司链路。`)
                    else drillChainNode({ code, name })
                  }}
                >
                  <span>{name}</span>
                  <small>{code === '' ? '叶子节点' : `${direction} · ${code}`}</small>
                </button>
              )
            })}
          </aside>
          <div className={css.industryGraphLegend} aria-hidden="true">
            <span data-direction="up">上游</span>
            <span data-direction="center">中心公司</span>
            <span data-direction="down">下游</span>
            <small>虚线节点暂无可钻取公司</small>
          </div>
          {chainLeafNotice !== '' && (
            <div className={css.industryGraphNotice} role="status">
              <span>{chainLeafNotice}</span>
              <button type="button" onClick={() => { setChainLeafNotice('') }} aria-label="关闭提示">×</button>
            </div>
          )}
        </div>
      </section>
    </div>
  )

  return (
    <div className={css.pageScroll}>
      <PageHeading title="产业链" description="检索真实公司产业链，按层查看上下游关系与传导依据；事件传导作为次级参考单独展示">
        <button type="button" className={css.secondaryButton} onClick={refresh}>刷新</button>
        <button
          type="button"
          className={css.primaryButton}
          disabled={selectedReference === ''}
          title={selectedReference === '' ? '请先选择一家公司' : undefined}
          onClick={() => { onAnalyze({ kind: 'industry', reference: selectedReference }) }}
        >AI 解读所选公司</button>
      </PageHeading>

      {dataStatus.state.phase === 'loading' && dataStatus.state.value === undefined && <BusyRows />}
      {dataStatus.state.phase === 'loading' && dataStatus.state.value !== undefined && status !== 'ready' && (
        <div className={css.industryResourceNotice} role="status">正在检查本机产业链数据，暂时保留当前页面状态。</div>
      )}
      {dataStatus.state.phase === 'error' && status !== 'ready' && (
        <DataError message="无法确认本机产业链数据状态，请稍后重试。" retry={loadDataStatus} />
      )}
      {dataStatus.state.value !== undefined && status === 'ready' && (
        <IndustryResourceFeedback
          state={dataStatus.state}
          loading="正在检查本机产业链数据"
          unavailable="状态检查失败，当前继续使用上次确认可用的数据。"
          retry={loadDataStatus}
        />
      )}

      {!industryReady && status !== '' && dataStatus.state.phase === 'success' && (
        <section className={css.industryBootstrap} aria-busy={downloadActive} aria-labelledby="industry-data-title">
          <div>
            <h2 id="industry-data-title">{downloadActive ? '正在下载产业链数据' : downloadFailed ? '产业链数据下载未完成' : '首次使用需下载产业链数据'}</h2>
            <p>{downloadActive
              ? `已完成 ${filesCompleted}/${filesTotal} 个数据文件，已下载 ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB。`
              : downloadFailed
                ? '数据未能完整下载，未完成的文件已清理。请检查网络后重试。'
                : '产业链公司与上下游关系数据约 25 MB，仅在你明确确认后保存到本机应用数据目录。'}</p>
          </div>
          {downloadActive && (
            <progress
              className={css.industryProgress}
              max={Math.max(filesTotal, 1)}
              value={Math.min(filesCompleted, Math.max(filesTotal, 1))}
              aria-label="产业链数据下载进度"
            />
          )}
          <button
            type="button"
            className={css.primaryButton}
            disabled={downloadActive}
            aria-busy={downloadActive}
            onClick={() => { void bootstrapData() }}
          >{downloadActive ? '正在下载…' : downloadFailed ? '重新下载' : '下载并开始使用'}</button>
        </section>
      )}
      {dataStatus.state.phase === 'success' && status === '' && (
        <DataError message="无法识别本机产业链数据状态，请稍后重试。" retry={loadDataStatus} />
      )}

      {industryReady && (
        <>
          {stats.state.value !== undefined && (
            <section className={css.industryStats} aria-label="产业链数据概览">
              <div><span>核心公司</span><strong>{industryCount(statsValue.subject_count ?? statsValue.companies, ' 家')}</strong></div>
              <div><span>图谱节点</span><strong>{industryCount(statsValue.total_nodes, ' 个')}</strong></div>
              <div><span>传导关系</span><strong>{industryCount(statsValue.total_edges, ' 条')}</strong></div>
              <div><span>关系类型</span><strong>{industryCount(statsValue.relationships, ' 类')}</strong></div>
            </section>
          )}
          {stats.state.phase === 'loading' && stats.state.value === undefined && <BusyRows />}
          <IndustryResourceFeedback
            state={stats.state}
            loading="正在刷新产业链概览"
            unavailable="产业链概览暂时无法读取，请稍后重试。"
            retry={loadStats}
          />

          <section className={css.industrySearchPanel} aria-labelledby="industry-search-title">
            <div className={css.sectionHeading}>
              <div><h2 id="industry-search-title">公司产业链检索</h2><small>与顶部共用全市场证券检索，并叠加产业链公司与行业数据</small></div>
              {searchedKeyword !== '' && <span>当前结果：{searchedKeyword}</span>}
            </div>
            <form className={css.inlineForm} onSubmit={(event) => { event.preventDefault(); searchCompanies(query) }}>
              <label htmlFor="industry-chain-query">搜索公司、行业或股票代码</label>
              <input
                id="industry-chain-query"
                className={css.fieldInput}
                value={query}
                onChange={(event) => { onQuery(event.target.value); setSearchValidation('') }}
                placeholder="例如：宁德时代、电池、300750"
                aria-invalid={searchValidation !== '' || undefined}
                aria-describedby={searchValidation === '' ? undefined : 'industry-chain-query-error'}
              />
              <button
                type="submit"
                disabled={searchAttempted && (companies.state.phase === 'loading' || securityMatches.state.phase === 'loading')}
                aria-busy={searchAttempted && (companies.state.phase === 'loading' || securityMatches.state.phase === 'loading')}
              >搜索</button>
            </form>
            {searchValidation !== '' && <p className={css.inlineError} id="industry-chain-query-error" role="alert">{searchValidation}</p>}
            {searchAttempted && (companies.state.phase === 'loading' || securityMatches.state.phase === 'loading')
              && companies.state.value === undefined && securityMatches.state.value === undefined && <BusyRows />}
            {searchAttempted && (
              <IndustryResourceFeedback
                state={companies.state}
                loading="正在更新公司检索结果"
                unavailable="公司检索暂时不可用，请稍后重试。"
                retry={() => { searchCompanies(searchedKeyword) }}
              />
            )}
            {searchAttempted && companyItems.length > 0 && (
              <div className={css.dataList} aria-label="公司检索结果">
                {companyItems.map((company, index) => {
                  const code = text(company.code, '').trim()
                  const name = text(company.name, '').trim()
                  const active = code !== '' && selectedCompany?.code === code
                  return (
                    <button
                      type="button"
                      className={css.dataRow}
                      data-active={active}
                      disabled={code === ''}
                      key={`${code}-${index}`}
                      onClick={() => {
                        const selection = { code, name }
                        selectChainCompany(selection, [selection])
                      }}
                    >
                      <span><strong>{name || '未命名公司'}</strong><small>{text(company.industry, '行业未标注')}</small></span>
                      <span>{code || '代码缺失'}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {searchAttempted && securityOnlyItems.length > 0 && (
              <div className={css.securityMatchList} aria-label="证券匹配结果">
                <div className={css.securityMatchHeading}>
                  <strong>全市场证券匹配</strong>
                  <small>以下证券能在顶部搜索中找到，但当前没有产业链图谱；可直接查看个股。</small>
                </div>
                {securityOnlyItems.map((security, index) => {
                  const code = text(security.code, '').trim()
                  const name = text(security.name, '').trim()
                  return (
                    <button
                      type="button"
                      className={css.dataRow}
                      key={`${code}-${index}`}
                      onClick={() => { onOpenStock(code) }}
                    >
                      <span><strong>{name || code}</strong><small>暂无产业链图谱 · 查看个股</small></span>
                      <span>{code}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {searchAttempted && securityMatches.state.phase === 'error' && (
              <p className={css.inlineNote} role="status">全市场证券匹配暂不可用，产业链公司结果仍可正常使用。</p>
            )}
            {searchAttempted && companies.state.phase === 'success' && securityMatches.state.phase === 'success'
              && companyItems.length === 0 && securityOnlyItems.length === 0 && <Empty>没有找到匹配的公司或证券。</Empty>}
            {!searchAttempted && <div className={css.contextHint}>输入关键词后按 Enter 或点击“搜索”，再选择一家公司查看真实上下游链路。</div>}
          </section>

          <section className={css.industryChainPanel} aria-labelledby="industry-chain-title">
            <div className={css.sectionHeading}>
              <div><h2 id="industry-chain-title">上下游链路</h2><small>按服务端返回的层级与传导字段展示，不补画缺失关系</small></div>
              {selectedCompany !== undefined && (
                <div className={css.industryChainActions}>
                  <span>{selectedCompany.name}（{selectedCompany.code}）</span>
                  {Object.keys(center).length > 0 && (
                    <button
                      ref={chainExpandButtonRef}
                      type="button"
                      className={css.secondaryButton}
                      onClick={() => { setChainExpanded(true) }}
                    >放大查看</button>
                  )}
                </div>
              )}
            </div>
            {selectedCompany === undefined && <Empty>请先从公司检索结果中选择一家公司。</Empty>}
            {selectedCompany !== undefined && chain.state.phase === 'loading' && chain.state.value === undefined && <BusyRows />}
            {selectedCompany !== undefined && (
              <IndustryResourceFeedback
                state={chain.state}
                loading="正在刷新所选公司的上下游链路"
                unavailable="所选公司的产业链暂时无法读取，请稍后重试。"
                retry={() => { loadChain(selectedCompany) }}
              />
            )}
            {selectedCompany !== undefined && chain.state.value !== undefined && Object.keys(center).length === 0 && chain.state.phase === 'success' && (
              <Empty>该公司当前没有可展示的产业链数据。</Empty>
            )}
            {Object.keys(center).length > 0 && renderChainLayout()}
          </section>
        </>
      )}

      <section className={css.industryImpactPanel} aria-labelledby="industry-impact-title">
        <div className={css.sectionHeading}>
          <div><h2 id="industry-impact-title">事件传导参考</h2><small>来自投研事件的直接与扩展影响，和公司产业链检索分别加载</small></div>
        </div>
        {impact.state.phase === 'loading' && impact.state.value === undefined && <BusyRows />}
        <IndustryResourceFeedback
          state={impact.state}
          loading="正在刷新事件传导参考"
          unavailable="事件传导参考暂时无法读取，请稍后重试。"
          retry={loadImpact}
        />
        <div className={css.moduleGrid} aria-label="事件产业链影响">
          {events.map((event, index) => {
            const codes = strings(event.impact_codes)
            const directCodes = tickerItems(event.tickers).map(ticker => ticker.code)
            const industries = strings(event.impact_industries)
            const sources = strings(event.impact_by)
            return (
              <article className={css.moduleCard} key={`${text(event.id)}-${index}`}>
                <div className={css.sectionHeading}><strong>{text(event.summary, '未命名事件')}</strong><StatusBadge value={text(event.direction)} /></div>
                <dl className={css.reportMeta}>
                  <div><dt>直接标的</dt><dd>{renderStockLinks(directCodes, '—')}</dd></div>
                  <div><dt>直接行业</dt><dd>{strings(event.industries).join('、') || '—'}</dd></div>
                  <div><dt>扩展标的</dt><dd>{renderStockLinks(codes, '图谱暂无扩展')}</dd></div>
                  <div><dt>扩展行业</dt><dd>{industries.join('、') || '图谱暂无扩展'}</dd></div>
                </dl>
                <small>传导来源：{sources.join('、') || '未返回；当前保持事件原样'}</small>
              </article>
            )
          })}
        </div>
        {impact.state.phase === 'success' && events.length === 0 && <Empty>当前事件源没有可展示的产业链事件。</Empty>}
      </section>
      {expandedChainDialog && (typeof document === 'undefined'
        ? expandedChainDialog
        : createPortal(expandedChainDialog, document.body))}
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
  const [detailFor, setDetailFor] = useState('')
  const load = useCallback(() => { list.run({ operation: 'trading-core.reports', input: { limit: 100 } }) }, [list.run])
  useEffect(load, [load])
  const items = records(asRecord(list.state.value).items)
  const securityCodeKey = reportSecurityCodes(items).join('|')
  const [securityNames, setSecurityNames] = useState<Record<string, string>>({})
  useEffect(() => {
    const codes = securityCodeKey === '' ? [] : securityCodeKey.split('|')
    if (codes.length === 0) return
    const requestState = { cancelled: false }
    void (async () => {
      for (let start = 0; start < codes.length; start += 3) {
        const batch = codes.slice(start, start + 3)
        const resolved = await Promise.all(batch.map(async (code): Promise<readonly [string, string]> => {
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
        setSecurityNames(current => ({ ...current, ...Object.fromEntries(resolved) }))
      }
    })()
    return () => { requestState.cancelled = true }
  }, [requestData, securityCodeKey])

  const selectedListItem = items.find(item => text(item.id, '') === selectedId)
  useEffect(() => {
    if (list.state.phase !== 'success') return
    if (selectedListItem !== undefined) return
    setSelectedId(text(items[0]?.id, ''))
  }, [items, list.state.phase, selectedListItem])
  useEffect(() => {
    if (selectedId !== '' && selectedListItem !== undefined) {
      setDetailFor(selectedId)
      detail.run({ operation: 'trading-core.report', input: { report_id: selectedId } })
    }
  }, [detail.run, selectedId, selectedListItem])
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
  const title = reportTitleLabel(Object.keys(report).length > 0 ? report : asRecord(selectedListItem), securityNames)
  const detailMatchesSelection = selectedListItem !== undefined && detailFor === selectedId

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
                  <strong>{reportTitleLabel(item, securityNames)}</strong>
                  <span>{reportKindLabel(item.kind)} · {reportTimeLabel(item.created_at)}</span>
                </button>
              )
            })}
            {list.state.phase === 'success' && items.length === 0 && <Empty>尚无正式报告。完成一次分析、回测或影子验证后会自动归档到这里。</Empty>}
          </aside>
          <article className={css.reportBody} aria-busy={detail.state.phase === 'loading'}>
            {(selectedId === '' || selectedListItem === undefined) && <Empty>从左侧选择一份报告查看。</Empty>}
            {detailMatchesSelection && detail.state.phase === 'loading' && detail.state.value === undefined && <BusyRows />}
            {detailMatchesSelection && detail.state.phase === 'error' && <DataError message={detail.state.error} retry={() => { detail.run({ operation: 'trading-core.report', input: { report_id: selectedId } }) }} />}
            {detailMatchesSelection && detail.state.value !== undefined && (
              <>
                <div className={css.sectionHeading}>
                  <div>
                    <h2>{title}</h2>
                    <p>{reportSubjectLabel(report, securityNames)
                      || reportSubjectLabel(asRecord(selectedListItem), securityNames)}</p>
                  </div>
                  <button type="button" className={css.secondaryButton} onClick={() => { onAnalyze({ kind: 'reports', reportId: selectedId }); onClose() }}>AI 复核</button>
                </div>
                <dl className={css.reportMeta}>
                  <div><dt>类型</dt><dd>{reportKindLabel(report.kind ?? selectedListItem.kind)}</dd></div>
                  <div><dt>生成时间</dt><dd>{reportTimeLabel(report.created_at ?? selectedListItem.created_at)}</dd></div>
                  <div><dt>报告编号</dt><dd title={selectedId}>{compactIdentifier(selectedId)}</dd></div>
                </dl>
                <div className={css.reportSections}>
                  {visibleSections.map((section, index) => (
                    <section key={`${text(section.key)}-${index}`}>
                      <h3>{text(section.title, text(section.key, `章节 ${index + 1}`))}</h3>
                      <div className={css.reportMarkdown}>
                        <MarkdownText text={humanizeReportMarkdown(section.content, securityNames)} />
                      </div>
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
