import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  PointerEvent as ReactPointerEvent, ReactNode, SetStateAction, WheelEvent as ReactWheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantIntent } from './assistant-intent.ts'
import { asRecord, money, number, productErrorText, records, text } from './data.ts'
import { DetailDialog } from './DetailDialogs.tsx'
import { useSecurityNames } from './security-names.ts'
import { StrategyEvolutionDiagnostics } from './StrategyEvolutionDiagnostics.tsx'
import type { StrategyResearchStage } from './state.ts'
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
    pending: '等待中', queued: '排队中', running: '运行中', done: '已完成', failed: '失败',
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

const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  active: '生效策略',
  candidate: '待验证候选',
  mutated: '变异衍生',
  retired: '退役策略',
  watch: '观察中',
  rejected: '已拒绝',
}

/** 同一策略出现在多个生命周期分组时，取真实状态（变异是来源标注而非独立状态）。 */
const LIFECYCLE_PRIORITY: Readonly<Record<string, number>> = {
  active: 6, watch: 5, candidate: 4, retired: 3, rejected: 2,
}

/** 策略稳定标号：取 id 后 6 位，全站统一，方便对话中指认策略。 */
function strategyLabel(strategyId: string): string {
  const short = strategyId.replace(/^strat-/, '').slice(0, 6)
  return short === '' ? strategyId : `#${short}`
}

/** 回测样本窗口选项（年）。后端按 lookback_years × 366 天取日线，再按 70% 样本内 / 30% 样本外切分。 */
const BACKTEST_WINDOW_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 0.5, label: '6个月' },
  { value: 1, label: '1年' },
  { value: 2, label: '2年' },
  { value: 3, label: '3年' },
  { value: 5, label: '5年' },
]

const CUSTOM_WINDOW_VALUE = 'custom'

/** 回测任务执行来源：手动页面触发 / 自动（首次入池或 15 天复测巡检）。 */
function backtestSourceLabel(source: unknown): string {
  return text(source, '') === 'auto' ? '自动' : '手动'
}

/** 回测任务的显式时间窗口标签（自动任务带「2年」预设；手动可为自定义区间）。 */
function backtestWindowLabel(task: Record<string, unknown>): string {
  const window = asRecord(task.window)
  const years = number(task.lookback_years)
  const start = text(window.start, '')
  const end = text(window.end, '')
  if (start !== '' && end !== '') {
    return years === undefined ? `${start} ~ ${end}` : `${years}年（${start} ~ ${end}）`
  }
  return '未记录窗口'
}

/** 任务状态的中文徽标文案（独立于策略生命周期状态）。 */
function taskStatusLabel(status: unknown): string {
  return statusLabel(text(status, 'unknown'))
}

/** 回测任务的验证结论：通过 / 待定 / 未达标（thresholds_pass 优先于 verification_status）。 */
function backtestVerdictLabel(task: Record<string, unknown>): string {
  const thresholds = task.thresholds_pass
  if (thresholds === true) return '通过'
  if (thresholds === false) return '未达标'
  const verification = text(task.verification_status, '')
  if (verification === 'passed') return '通过'
  if (verification === 'pending') return '样本不足待定'
  if (verification === 'failed') return '未达标'
  return '—'
}
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
type LifecycleHelpStage = 1 | 2 | 3 | 4

const STRATEGY_CATEGORY_LABELS: Record<StrategyFilter, string> = {
  all: '全部',
  verified: '已验证通过',
  unverified: '未验证',
  failed: '验证未通过',
  archived: '已归档',
}

const LIFECYCLE_HELP: Record<LifecycleHelpStage, string> = {
  1: '从真实市场事件形成候选；点击查看全部候选。',
  2: '候选产生回测证据后进入；点击筛选待验证策略。',
  3: '回测通过并激活后进入；点击打开纸面账户验证。',
  4: '影子验证积累证据后查看判定；进入前需先选择策略。',
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
  item, tasks, busy, tasksBusy, onClose, onAnalyze, onShadow, onRefreshTasks, onCreateTask,
}: {
  item: Record<string, unknown>
  tasks: readonly Record<string, unknown>[]
  busy: boolean
  tasksBusy: boolean
  onClose: () => void
  onAnalyze: () => void
  onShadow: () => void
  onRefreshTasks: () => void
  onCreateTask: () => void
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
  const latestTask = tasks.find(task => text(task.status, '') === 'completed') ?? tasks[0]
  const manageDisabled = busy || category === 'archived'
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
      <section className={css.detailSection} data-testid="backtest-management" aria-label="回测管理">
        <h3>回测管理</h3>
        <p className={css.detailFootnote}>
          每次手动或自动回测都是一条独立任务；自动任务由策略首次入池与每 15 天复测巡检创建，
          统一进入下方历史清单。最新一次证据会同步到“验证结论/样本内外证据”。
        </p>
        {latestTask === undefined ? (
          <p className={css.detailFootnote}>暂无回测任务记录。策略首次进入策略池后会由自动回测创建首测任务。</p>
        ) : (
          <dl className={css.detailMetaGrid}>
            <div><dt>最近状态</dt><dd>{taskStatusLabel(latestTask.status)}</dd></div>
            <div><dt>执行来源</dt><dd>{backtestSourceLabel(latestTask.source)}</dd></div>
            <div><dt>时间窗口</dt><dd>{backtestWindowLabel(latestTask)}</dd></div>
            <div><dt>创建 / 完成</dt><dd>{reportTimeLabel(latestTask.created_at)} → {reportTimeLabel(latestTask.completed_at)}</dd></div>
            <div><dt>验证结论</dt><dd>{latestTask.status === 'completed' ? backtestVerdictLabel(latestTask) : '—'}</dd></div>
          </dl>
        )}
        {latestTask !== undefined && text(latestTask.failure_reason, '') !== '' && (
          <p className={css.detailFootnote}>失败原因：{text(latestTask.failure_reason)}</p>
        )}
        <div className={css.moduleToolbar}>
          <button type="button" className={css.secondaryButton} disabled={tasksBusy || busy} onClick={onRefreshTasks}>刷新任务</button>
          <button type="button" className={css.primaryButton} disabled={manageDisabled} onClick={onCreateTask}>
            {busy ? '回测中…' : '新建回测任务'}
          </button>
        </div>
        {tasks.length > 0 ? (
          <div className={css.strategyEvidenceTable}>
            <table>
              <thead><tr><th>时间窗口</th><th>来源</th><th>状态</th><th>创建时间</th><th>开始 / 完成</th><th>结果</th><th>失败原因</th></tr></thead>
              <tbody>
                {tasks.map((task) => {
                  const taskIdText = text(task.task_id, '')
                  const summary = asRecord(task.summary)
                  const failed = text(task.status, '') === 'failed'
                  const trades = number(summary.oos_trades)
                  const verdict = failed ? '—' : `${backtestVerdictLabel(task)}${trades === undefined ? '' : ` · 样本外${trades}笔`}`
                  return (
                    <tr key={taskIdText}>
                      <td>{backtestWindowLabel(task)}</td>
                      <td>{backtestSourceLabel(task.source)}</td>
                      <td>{taskStatusLabel(task.status)}</td>
                      <td>{reportTimeLabel(task.created_at)}</td>
                      <td>{reportTimeLabel(task.started_at)} → {reportTimeLabel(task.completed_at)}</td>
                      <td>{verdict}</td>
                      <td>{failed ? text(task.failure_reason, '') : ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={css.detailFootnote}>暂无回测任务历史。</p>
        )}
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

interface NewBacktestOptions {
  readonly years?: number
  readonly startDate?: string
  readonly endDate?: string
  readonly capital?: number
}

function NewBacktestTaskDialog({
  item, busy, onClose, onConfirm,
}: {
  item: Record<string, unknown>
  busy: boolean
  onClose: () => void
  onConfirm: (options: NewBacktestOptions) => void
}) {
  const id = text(item.id, '未返回')
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const [mode, setMode] = useState<string>('2')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [capital, setCapital] = useState('')
  const [error, setError] = useState('')

  const submit = (): void => {
    const parsedCapital = capital.trim() === '' ? undefined : Number(capital)
    if (parsedCapital !== undefined && (!Number.isFinite(parsedCapital) || parsedCapital <= 0)) {
      setError('初始资金必须是大于 0 的金额。')
      return
    }
    if (mode === CUSTOM_WINDOW_VALUE) {
      if (startDate === '' || endDate === '') {
        setError('请同时填写起始日期与截止日期。')
        return
      }
      if (startDate >= endDate) {
        setError('起始日期必须早于截止日期。')
        return
      }
      if (endDate > todayIso) {
        setError('截止日期不能晚于今天。')
        return
      }
    }
    const windowOptions: NewBacktestOptions = mode === CUSTOM_WINDOW_VALUE
      ? { startDate, endDate }
      : { years: Number(mode) }
    onConfirm(parsedCapital === undefined ? windowOptions : { ...windowOptions, capital: parsedCapital })
  }

  return (
    <DetailDialog
      title="新建回测任务"
      description="创建一条独立回测任务，完成后写入该策略的任务历史并刷新验证证据。"
      eyebrow={`策略 ${strategyLabel(id)}`}
      closeDisabled={busy}
      onClose={onClose}
      actions={<>
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className={css.primaryButton} disabled={busy} onClick={submit}>
          {busy ? '回测中…' : '开始回测'}
        </button>
      </>}
    >
      <label className={css.importField}>
        <span>回测时间窗口</span>
        <select
          className={css.backtestWindowSelect}
          value={mode}
          disabled={busy}
          onChange={(event) => { setMode(event.target.value) }}
        >
          {BACKTEST_WINDOW_OPTIONS.map(option => (
            <option key={option.value} value={String(option.value)}>{option.label}</option>
          ))}
          <option value={CUSTOM_WINDOW_VALUE}>自定义起止日期</option>
        </select>
      </label>
      {mode === CUSTOM_WINDOW_VALUE && (
        <>
          <label className={css.importField}>
            <span>起始日期</span>
            <input className={css.fieldInput} type="date" value={startDate} max={endDate === '' ? todayIso : endDate} disabled={busy} onChange={(event) => { setStartDate(event.target.value) }} />
          </label>
          <label className={css.importField}>
            <span>截止日期</span>
            <input className={css.fieldInput} type="date" value={endDate} max={todayIso} disabled={busy} onChange={(event) => { setEndDate(event.target.value) }} />
          </label>
        </>
      )}
      <label className={css.importField}>
        <span>初始资金（元）</span>
        <input
          className={css.fieldInput}
          type="number"
          inputMode="numeric"
          min="1"
          step="1000"
          value={capital}
          placeholder="留空使用默认 100000"
          disabled={busy}
          onChange={(event) => { setCapital(event.target.value) }}
        />
      </label>
      <p className={css.detailFootnote}>窗口越长样本外证据越足；样本内 70% / 样本外 30% 自动切分。</p>
      {error !== '' && <p className={css.detailFootnote} role="alert">{error}</p>}
    </DetailDialog>
  )
}

function ArchiveStrategyDialog({
  item, busy, onClose, onConfirm,
}: {
  item: Record<string, unknown>
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const id = text(item.id, '未返回')
  return (
    <DetailDialog
      title="归档策略"
      description="归档后将停止后续回测、影子验证与推荐，但会保留历史证据和投研记录。"
      eyebrow="需要二次确认"
      closeDisabled={busy}
      onClose={onClose}
      actions={<>
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className={css.dangerButton} disabled={busy} onClick={onConfirm}>
          {busy ? '归档中…' : '确认归档'}
        </button>
      </>}
    >
      <p>策略：<strong>{strategyTargetLabel(item, {})}</strong></p>
      <p className={css.detailFootnote}>策略标识：{id}</p>
    </DetailDialog>
  )
}

function strategyLifecycleStage(item: Record<string, unknown>): StrategyResearchStage {
  const status = text(item.status, '')
  if (strategyCategory(item) === 'archived' || status === 'watch' || status === 'retired') return 'evolution'
  if (status === 'active') return 'shadow'
  if (Object.keys(asRecord(item.backtest)).length > 0) return 'backtest'
  return 'form'
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
  readonly onOpenStock?: (code: string) => void
  readonly initialStage?: StrategyResearchStage
  readonly onBackEvolution?: () => void
}

export const STRATEGY_EVOLUTION_HANDOFF_KEY = 'dsh.investment.strategy-evolution-handoff.v2'

function evolutionHandoffSuppressed(): boolean {
  try {
    return asRecord(JSON.parse(
      window.localStorage.getItem(STRATEGY_EVOLUTION_HANDOFF_KEY) ?? 'null',
    )).suppressed === true
  } catch {
    return false
  }
}

/** Event hypotheses, evidence and lifecycle decisions backed by the strategy store. */
export function StrategyResearchPage({
  requestData, selectedStrategyId, onSelectStrategy, onOpenShadow, onOpenReports, onAnalyze,
  initialView = 'pool', onOpenEvolution = () => {}, onOpenStock = () => {},
  initialStage = 'form', onBackEvolution = onOpenEvolution,
}: StrategyResearchPageProps) {
  const strategies = useDataResource(requestData)
  const backtestTasks = useDataResource(requestData)
  const alive = useAliveRef()
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState('')
  const [reportReady, setReportReady] = useState(false)
  const [view, setView] = useState<'pool' | 'shadow' | 'evolution'>(initialStage === 'evolution' ? 'evolution' : initialView)
  const [evolutionEducationOpen, setEvolutionEducationOpen] = useState(false)
  const [suppressEvolutionEducation, setSuppressEvolutionEducation] = useState(false)
  const [filter, setFilter] = useState<StrategyFilter>('all')
  const [lifecycleHelpOpen, setLifecycleHelpOpen] = useState(false)
  const [detailItem, setDetailItem] = useState<Record<string, unknown>>()
  const [newTaskItem, setNewTaskItem] = useState<Record<string, unknown>>()
  const [archiveItem, setArchiveItem] = useState<Record<string, unknown>>()
  const [hypothesisPreview, setHypothesisPreview] = useState<StrategyHypothesisPreview>()
  const [hypothesisStatus, setHypothesisStatus] = useState('')
  const [lifecycleHelpStage, setLifecycleHelpStage] = useState<LifecycleHelpStage>()
  useEffect(() => { setView(initialStage === 'evolution' ? 'evolution' : initialView) }, [initialStage, initialView])
  const load = useCallback(() => {
    strategies.run({ operation: 'trading-core.strategies', input: { limit: 50 } })
  }, [strategies.run])
  useEffect(load, [load])
  const detailId = text(detailItem?.id, '')
  const refreshBacktestTasks = useCallback((): void => {
    if (detailId === '') return
    backtestTasks.run({ operation: 'trading-core.strategy-backtests', input: { strategy_id: detailId, limit: 50 } })
  }, [detailId, backtestTasks.run])
  useEffect(() => {
    if (detailId !== '') refreshBacktestTasks()
  }, [detailId, refreshBacktestTasks])
  const backtestTaskList = records(asRecord(backtestTasks.state.value).tasks)
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
  const strategyNames = Object.fromEntries(items.map((item, index) => {
    const id = text(item.id, `strategy-${index}`)
    const target = strategyTargetLabel(item, securityNames)
    return [id, target === '' ? text(item.name, '未命名策略') : target]
  }))
  const filteredItems = filter === 'all' ? items : items.filter(item => strategyCategory(item) === filter)
  const categoryCounts = items.reduce<Record<StrategyCategory, number>>((counts, item) => {
    const category = strategyCategory(item)
    counts[category] += 1
    return counts
  }, { verified: 0, unverified: 0, failed: 0, archived: 0 })
  const selectedItem = items.find(item => text(item.id, '') === selectedStrategyId)
  const currentLifecycleStage = selectedItem === undefined
    ? undefined
    : view === 'shadow' ? 'shadow' : strategyLifecycleStage(selectedItem)

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

  const runBacktest = async (strategyId: string, options: NewBacktestOptions): Promise<void> => {
    if (busyAction !== '') return
    setBusyAction(`backtest:${strategyId}`); setNotice('正在启动样本内与样本外回测…'); setReportReady(false)
    try {
      const windowInput = options.startDate !== undefined && options.endDate !== undefined
        ? { strategy_id: strategyId, oos_frac: 0.3, min_oos_trades: 4, start_date: options.startDate, end_date: options.endDate }
        : { strategy_id: strategyId, oos_frac: 0.3, min_oos_trades: 4, lookback_years: options.years ?? 2 }
      const input = options.capital !== undefined && options.capital > 0
        ? { ...windowInput, initial_capital: options.capital }
        : windowInput
      const started = await requestData({ operation: 'trading-core.strategy-run', input })
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
      if (text(newTaskItem?.id, '') === strategyId) setNewTaskItem(undefined)
      load()
      refreshBacktestTasks()
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

  const archiveStrategy = async (strategyId: string): Promise<void> => {
    if (busyAction !== '') return
    setBusyAction(`archive:${strategyId}`)
    setNotice('正在归档策略…')
    try {
      await requestData({
        operation: 'trading-core.strategy-transition', input: { strategy_id: strategyId, action: 'retire' },
      })
      if (!alive.current) return
      setArchiveItem(undefined)
      if (text(detailItem?.id, '') === strategyId) setDetailItem(undefined)
      setNotice('策略已归档，历史证据仍可在“已归档”中查看。')
      load()
    } catch (reason) {
      if (alive.current) setNotice(`归档失败：${productErrorText(reason)}`)
    } finally {
      if (alive.current) setBusyAction('')
    }
  }

  const openEvolutionDiagnostics = (): void => {
    if (selectedStrategyId === '') {
      setNotice('请先选择策略后进入进化诊断。')
      return
    }
    if (evolutionHandoffSuppressed()) {
      setView('evolution')
      return
    }
    setSuppressEvolutionEducation(false)
    setEvolutionEducationOpen(true)
  }

  const continueEvolutionDiagnostics = (): void => {
    if (suppressEvolutionEducation) {
      try {
        window.localStorage.setItem(STRATEGY_EVOLUTION_HANDOFF_KEY, JSON.stringify({ suppressed: true }))
      } catch {
        // Browser storage is optional; the read-only diagnostics remains available.
      }
    }
    setEvolutionEducationOpen(false)
    setView('evolution')
  }

  if (view === 'evolution') {
    const selectedStatus = text(selectedItem?.status, '')
    return <div className={css.pageScroll}><StrategyEvolutionDiagnostics
      requestData={requestData}
      strategyId={selectedStrategyId}
      strategyLabel={text(selectedItem?.name, selectedStrategyId || '未选择策略')}
      strategyStatus={selectedStatus}
      archived={strategyCategory(selectedItem ?? {}) === 'archived'}
      onAnalyze={onAnalyze}
      onBack={onBackEvolution}
    /></div>
  }

  return (
    <div className={css.pageScroll}>
      <PageHeading title="策略研究" description="策略池与影子验证已合并；从假设、样本外证据到纸面验证在同一处完成">
        <button
          type="button"
          className={css.secondaryButton}
          aria-haspopup="dialog"
          onClick={() => { setLifecycleHelpOpen(true) }}
        >了解策略生命周期</button>
        {view === 'pool' && <>
          <span className={css.backtestWindow} title="回测入口已并入策略详情：可自选预设窗口或自定义起止日期">回测入口：策略详情 → 回测管理</span>
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
      {lifecycleHelpOpen && (
        <DetailDialog
          title="策略生命周期"
          description="从事件假设、进入策略池到回测、影子验证和自进化的完整路径"
          eyebrow="帮助"
          wide
          onClose={() => { setLifecycleHelpOpen(false) }}
          actions={<button type="button" className={css.primaryButton} onClick={() => { setLifecycleHelpOpen(false) }}>知道了</button>}
        >
          <section className={css.lifecyclePanel}>
            <div className={css.lifecycleIntro}>
              <small>每条策略都沿着真实证据逐步推进，不会自动进入下一阶段。</small>
              {view === 'pool' && <span>新建方式：使用页面上的“从事件新建策略”。</span>}
            </div>
            <nav className={css.lifecycleStrip} aria-label="策略生命周期步骤">
              <button
                type="button"
                aria-current={currentLifecycleStage === 'form' ? 'step' : undefined}
                aria-describedby={lifecycleHelpStage === 1 ? 'strategy-lifecycle-tooltip' : undefined}
                data-state={currentLifecycleStage === 'form' ? 'active' : undefined}
                onMouseEnter={() => { setLifecycleHelpStage(1) }}
                onMouseLeave={() => { setLifecycleHelpStage(undefined) }}
                onFocus={() => { setLifecycleHelpStage(1) }}
                onBlur={() => { setLifecycleHelpStage(undefined) }}
                onClick={() => { setLifecycleHelpOpen(false); setView('pool'); setFilter('all') }}
              ><b>1</b><strong>事件形成假设</strong><small>创建或查看事件候选</small></button><i aria-hidden="true">→</i>
              <button
                type="button"
                aria-current={currentLifecycleStage === 'backtest' ? 'step' : undefined}
                aria-describedby={lifecycleHelpStage === 2 ? 'strategy-lifecycle-tooltip' : undefined}
                data-state={currentLifecycleStage === 'backtest' ? 'active' : undefined}
                onMouseEnter={() => { setLifecycleHelpStage(2) }}
                onMouseLeave={() => { setLifecycleHelpStage(undefined) }}
                onFocus={() => { setLifecycleHelpStage(2) }}
                onBlur={() => { setLifecycleHelpStage(undefined) }}
                onClick={() => { setLifecycleHelpOpen(false); setView('pool'); setFilter('unverified') }}
              ><b>2</b><strong>样本外回测</strong><small>查看待验证策略与回测证据</small></button><i aria-hidden="true">→</i>
              <button
                type="button"
                aria-current={currentLifecycleStage === 'shadow' ? 'step' : undefined}
                aria-describedby={lifecycleHelpStage === 3 ? 'strategy-lifecycle-tooltip' : undefined}
                data-state={currentLifecycleStage === 'shadow' ? 'active' : undefined}
                onMouseEnter={() => { setLifecycleHelpStage(3) }}
                onMouseLeave={() => { setLifecycleHelpStage(undefined) }}
                onFocus={() => { setLifecycleHelpStage(3) }}
                onBlur={() => { setLifecycleHelpStage(undefined) }}
                onClick={() => { setLifecycleHelpOpen(false); setView('shadow') }}
              ><b>3</b><strong>影子验证</strong><small>进入纸面账户验证</small></button><i aria-hidden="true">→</i>
              <button
                type="button"
                aria-current={currentLifecycleStage === 'evolution' ? 'step' : undefined}
                aria-describedby={lifecycleHelpStage === 4 ? 'strategy-lifecycle-tooltip' : undefined}
                data-state={currentLifecycleStage === 'evolution' ? 'active' : undefined}
                onMouseEnter={() => { setLifecycleHelpStage(4) }}
                onMouseLeave={() => { setLifecycleHelpStage(undefined) }}
                onFocus={() => { setLifecycleHelpStage(4) }}
                onBlur={() => { setLifecycleHelpStage(undefined) }}
                onClick={openEvolutionDiagnostics}
              ><b>4</b><strong>进化诊断</strong><small>查看最新判定与闭环历史</small></button>
            </nav>
            {lifecycleHelpStage !== undefined && (
              <div className={css.lifecycleTooltip} id="strategy-lifecycle-tooltip" role="tooltip" style={{ position: 'absolute' }}>
                {LIFECYCLE_HELP[lifecycleHelpStage]}
              </div>
            )}
          </section>
        </DetailDialog>
      )}
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
                  <button type="button" className={css.secondaryButton} aria-haspopup="dialog" disabled={busyAction !== ''} onClick={() => { setDetailItem(item) }}>
                    回测管理
                  </button>
                  {status === 'candidate' && (
                    <button type="button" className={css.secondaryButton} disabled={busyAction !== '' || !hasBacktest} title={hasBacktest ? '人工确认策略生效' : '完成回测后才能确认生效'} onClick={() => { onSelectStrategy(id); void activate(id) }}>
                      {busyAction === `activate:${id}` ? '更新中…' : '人工确认生效'}
                    </button>
                  )}
                  <button type="button" className={css.secondaryButton} onClick={() => { onSelectStrategy(id); onAnalyze({ kind: 'strategy', strategyId: id }) }}>AI 评审</button>
                  {category !== 'archived' && (
                    <button type="button" className={css.dangerButton} aria-haspopup="dialog" disabled={busyAction !== ''} onClick={() => { setArchiveItem(item) }}>
                      {busyAction === `archive:${id}` ? '归档中…' : '归档'}
                    </button>
                  )}
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
          onOpenStock={onOpenStock}
          strategyNames={strategyNames}
        />
      )}
      {detailItem !== undefined && (
        <StrategyDetailDialog
          item={detailItem}
          tasks={backtestTaskList}
          busy={busyAction === `backtest:${text(detailItem.id, '')}`}
          tasksBusy={backtestTasks.state.phase === 'loading' && backtestTasks.state.value === undefined}
          onClose={() => { setDetailItem(undefined) }}
          onRefreshTasks={() => { refreshBacktestTasks() }}
          onCreateTask={() => { setNewTaskItem(detailItem) }}
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
      {newTaskItem !== undefined && (
        <NewBacktestTaskDialog
          item={newTaskItem}
          busy={busyAction === `backtest:${text(newTaskItem.id, '')}`}
          onClose={() => { if (busyAction === '') setNewTaskItem(undefined) }}
          onConfirm={(options) => {
            const id = text(newTaskItem.id, '')
            if (id !== '') void runBacktest(id, options)
          }}
        />
      )}
      {archiveItem !== undefined && (
        <ArchiveStrategyDialog
          item={archiveItem}
          busy={busyAction === `archive:${text(archiveItem.id, '')}`}
          onClose={() => { if (busyAction === '') setArchiveItem(undefined) }}
          onConfirm={() => { void archiveStrategy(text(archiveItem.id, '')) }}
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
      {evolutionEducationOpen && (
        <div className={css.dialogBackdrop} role="presentation">
          <section className={css.moduleCard} role="dialog" aria-modal="true" aria-label="进入当前策略的进化诊断">
            <h2>进入当前策略的进化诊断</h2>
            <p>这里仅展示当前策略证据、预计判定和自动执行历史；所有动作由统一自动闭环执行。</p>
            <label><input type="checkbox" checked={suppressEvolutionEducation} onChange={(event) => { setSuppressEvolutionEducation(event.target.checked) }} />以后不再提示（仅保存在此浏览器）</label>
            <div className={css.moduleToolbar}>
              <button type="button" className={css.secondaryButton} onClick={() => { setEvolutionEducationOpen(false) }}>取消</button>
              <button type="button" className={css.primaryButton} onClick={continueEvolutionDiagnostics}>继续进入</button>
            </div>
          </section>
        </div>
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
  readonly onOpenStock?: (code: string) => void
  readonly strategyNames?: Readonly<Record<string, string>>
  readonly embedded?: boolean
}

/** Paper-account evidence; no real order is placed from this UI. */
export function ShadowValidationPage({
  requestData, selectedStrategyId, onOpenEvolution, onOpenReports, onAnalyze,
  onOpenStock = () => {}, strategyNames = {}, embedded = false,
}: ShadowValidationPageProps) {
  const status = useDataResource(requestData)
  const alive = useAliveRef()
  const positions = useDataResource(requestData)
  const equity = useDataResource(requestData)
  const history = useDataResource(requestData)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [reportReady, setReportReady] = useState(false)
  // 影子验证历史两种粒度：有选中策略时默认「当前策略历史」，也可切到全局「全部策略运行记录」。
  const [historyView, setHistoryView] = useState<'strategy' | 'all'>(selectedStrategyId === '' ? 'all' : 'strategy')
  useEffect(() => {
    setHistoryView(selectedStrategyId === '' ? 'all' : 'strategy')
  }, [selectedStrategyId])
  const refreshHistory = useCallback((): void => {
    const single = historyView === 'strategy' && selectedStrategyId !== ''
    history.run(single
      ? { operation: 'trading-core.shadow-history', input: { strategy_id: selectedStrategyId, limit: 200 } }
      : { operation: 'trading-core.shadow-history', input: { limit: 200 } })
  }, [history.run, historyView, selectedStrategyId])
  useEffect(() => { refreshHistory() }, [refreshHistory])
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
    refreshHistory()
  }, [equity.run, positions.run, refreshHistory, selectedStrategyId, status.run])
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
  const positionNames = useSecurityNames(requestData, positionItems.map(item => text(item.symbol, text(item.code))))
  const selectedStrategyName = strategyNames[selectedStrategyId]?.trim() ?? ''
  const historyItems = records(asRecord(history.state.value).items)
  const historyLoading = history.state.phase === 'loading' && history.state.value === undefined
  const visibleHistoryItems = historyView === 'strategy' && selectedStrategyId !== ''
    ? historyItems.filter(item => text(item.strategy_id, '') === selectedStrategyId)
    : historyItems
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
    <div className={css.shadowScopeBar} aria-label="当前影子验证范围">
      <div>
        <span>当前验证范围</span>
        <strong>{selectedStrategyId === '' ? '全部生效策略' : selectedStrategyName || '已选策略'}</strong>
        <small>{selectedStrategyId === '' ? '每条生效策略独立使用纸面账户记账' : '只展示这条策略的持仓与净值证据'}</small>
      </div>
      <span>真实行情 · 虚拟资金 · 不会下单</span>
    </div>
    {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
    {firstError !== undefined && <DataError message={firstError.error} retry={load} />}
    {initialLoading && <BusyRows />}
    {!initialLoading && <>
      <section
        className={css.shadowRunSummary}
        aria-label={selectedStrategyId === '' ? '最近一次影子验证结果' : '全部策略最近运行'}
      >
        <div className={css.sectionHeading}>
          <div>
            <strong>{selectedStrategyId === '' ? '最近运行' : '全部策略最近运行'}</strong>
            {selectedStrategyId !== '' && (
              <small>下方持仓与净值仅展示“{selectedStrategyName || '已选策略'}”</small>
            )}
          </div>
          <StatusBadge value={text(statusRecord.trade_date, '') === '' ? 'waiting_data' : 'done'} />
        </div>
        <dl className={css.reportMeta}>
          <div><dt>交易日</dt><dd>{text(statusRecord.trade_date)}</dd></div>
          <div><dt>策略数</dt><dd>{number(statusRecord.strategy_count)?.toFixed(0) ?? '—'}</dd></div>
          <div><dt>运行时间</dt><dd>{text(statusRecord.ran_at)}</dd></div>
          <div><dt>组合净值</dt><dd>{compactMetric(statusRecord.overall_nav)}</dd></div>
        </dl>
        {text(statusRecord.note, '') !== '' && <p>{text(statusRecord.note)}</p>}
      </section>
      <section className={css.shadowEvidenceGrid} aria-label="影子验证证据">
        <article className={css.shadowEvidenceCard}>
          <div className={css.sectionHeading}>
            <div><strong>纸面持仓</strong><small>点击证券可查看个股详情</small></div><span>{positionItems.length} 项</span>
          </div>
          <div className={css.dataList}>
            {positionItems.slice(0, 12).map((item, index) => {
              const code = text(item.symbol, text(item.code, '')).trim()
              const canOpenStock = /^[0-9]{6,8}$/u.test(code)
              const resolvedName = positionNames[code]?.trim() ?? ''
              const name = canOpenStock
                ? resolvedName === '' || resolvedName === code ? code : resolvedName
                : '证券代码缺失'
              const strategyId = text(item.strategy_id)
              const strategyName = strategyNames[strategyId]?.trim() || '影子策略'
              const positionMeta = !canOpenStock || strategyName.includes(code)
                ? strategyName
                : `${code} · ${strategyName}`
              const quantity = number(item.qty ?? item.quantity)
              const row = <>
                <span><strong>{name}</strong><small>{positionMeta}</small></span>
                <span>
                  <b>{quantity === undefined ? money(item.market_value) : `${quantity.toLocaleString('zh-CN')} 股`}</b>
                  <small>{quantity === 0 ? '当前空仓' : `成本 ${money(item.avg_cost ?? item.entry_price)}`}</small>
                </span>
              </>
              return canOpenStock ? (
                <button
                  type="button"
                  className={css.shadowPositionRow}
                  key={`${strategyId}-${code}-${index}`}
                  aria-label={`查看${name} · ${code}个股详情`}
                  onClick={() => { onOpenStock(code) }}
                >
                  {row}
                </button>
              ) : (
                <div className={css.shadowPositionRow} data-disabled key={`${strategyId}-missing-${index}`}>
                  {row}
                </div>
              )
            })}
            {positionItems.length === 0 && positions.state.phase === 'success' && <Empty>当前没有纸面持仓。</Empty>}
          </div>
        </article>
        <article className={css.shadowEvidenceCard}>
          <div className={css.sectionHeading}>
            <div><strong>净值证据</strong><small>按交易日倒序展示纸面账户净值</small></div><span>{equityItems.length} 日</span>
          </div>
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
      </section>
      <section className={css.detailSection} data-testid="shadow-run-history" aria-label={selectedStrategyId === '' ? '全部策略运行记录' : '影子验证历史'}>
        <div className={css.sectionHeading}>
          <div>
            <strong>{selectedStrategyId === '' ? '全部策略运行记录' : '影子验证历史'}</strong>
            <small>交易日 × 策略粒度的运行记录，来自每日影子快照</small>
          </div>
          {selectedStrategyId !== '' && (
            <div className={`${css.segmented} ${css.strategyFilters}`} role="group" aria-label="影子运行记录视图">
              <button type="button" aria-pressed={historyView === 'strategy'} className={historyView === 'strategy' ? css.segmentActive : undefined} onClick={() => { setHistoryView('strategy') }}>当前策略历史</button>
              <button type="button" aria-pressed={historyView === 'all'} className={historyView === 'all' ? css.segmentActive : undefined} onClick={() => { setHistoryView('all') }}>全部策略运行记录</button>
            </div>
          )}
        </div>
        {historyLoading ? <BusyRows /> : (
          <div className={css.strategyEvidenceTable}>
            <table>
              <thead><tr>
                <th>验证日</th>
                <th>策略</th>
                <th>跟踪起始</th>
                <th>初始资金</th>
                <th>当前权益</th>
                <th>净值</th>
                <th>持仓数</th>
                <th>平仓数</th>
                <th>数据异常</th>
                <th></th>
              </tr></thead>
              <tbody>
                {visibleHistoryItems.map((item) => {
                  const sid = text(item.strategy_id, '')
                  const rawName = text(item.strategy_name, '')
                  const resolvedName = strategyNames[sid]?.trim() ?? rawName
                  const strategyDisplay = historyView === 'all'
                    ? (resolvedName === '' ? sid : resolvedName)
                    : (selectedStrategyName || resolvedName || selectedStrategyId)
                  const symbolErrorCount = Object.keys(asRecord(item.symbol_errors)).length
                  const strategyError = text(item.strategy_error, '')
                  const anomaly = strategyError !== ''
                    ? strategyError
                    : symbolErrorCount > 0 ? `${symbolErrorCount} 个标的行情异常` : '—'
                  return (
                    <tr key={`${text(item.date)}-${sid}`}>
                      <td>{text(item.date)}</td>
                      <td>{strategyDisplay}</td>
                      <td>{text(item.track_from, '—')}</td>
                      <td>{money(number(item.initial_capital))}</td>
                      <td>{money(number(item.equity))}</td>
                      <td>{compactMetric(item.nav)}</td>
                      <td>{number(item.open_positions)?.toFixed(0) ?? '—'}</td>
                      <td>{number(item.closed_count)?.toFixed(0) ?? '0'}</td>
                      <td>{anomaly}</td>
                      <td>
                        <button type="button" className={css.secondaryButton} onClick={onOpenReports}
                          title={`打开 ${text(item.date)} 影子验证报告`}>影子报告</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {!historyLoading && visibleHistoryItems.length === 0 && (
          <p className={css.detailFootnote}>
            {history.state.phase === 'error'
              ? '运行记录加载失败，可点击顶部刷新重试。'
              : selectedStrategyId === '' || historyView === 'all'
                ? '暂无影子运行记录；生效策略运行影子验证后逐交易日生成。'
                : '该策略尚无影子运行记录；生效并运行影子验证后逐交易日生成。'}
          </p>
        )}
      </section>
    </>}
    <div className={css.shadowFooterActions}>
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

/** 全自动自进化闭环看板：进页即展示各策略当前判定、闭环运行状态与最近自动进化记录。 */
export function EvolutionPage({ requestData, onAnalyze, onOpenStock = () => {} }: EvolutionPageProps) {
  const status = useDataResource(requestData)
  const attribution = useDataResource(requestData)
  const load = useCallback(() => {
    status.run({ operation: 'trading-core.evolution-status' })
    attribution.run({ operation: 'trading-core.evolution-attribution' })
  }, [attribution.run, status.run])
  useEffect(load, [load])

  const statusRecord = asRecord(status.state.value)
  const counts = asRecord(statusRecord.counts)
  const attributionRecord = asRecord(attribution.state.value)
  const overall = asRecord(attributionRecord.overall)
  const strategyRows = records(attributionRecord.strategies)
  const lifecycle = asRecord(statusRecord.lifecycle)
  const lifecycleGroups = ['active', 'candidate', 'mutated', 'retired', 'watch', 'rejected']
    .flatMap(key => records(lifecycle[key]))
  const unresolvedSymbolKey = [...new Set([
    ...strategyRows.flatMap(item => strings(item.symbols)),
    ...records(statusRecord.per_strategy).flatMap(item => strings(item.symbols)),
    ...lifecycleGroups.flatMap(item => strings(item.symbols)),
  ])].sort().join('|')
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
  const perStrategy = records(statusRecord.per_strategy)
  const recentApplied = records(statusRecord.recent_applied)
  const [expandedSid, setExpandedSid] = useState('')
  const [openLifecycle, setOpenLifecycle] = useState('')
  const [openDetailSid, setOpenDetailSid] = useState('')
  const lifecycleEntries = records(lifecycle[openLifecycle])
  // 全量谱系：6 组按优先级合并去重
  const fullLineageBySid = new Map<string, { entry: Record<string, unknown>; status: string }>()
  for (const group of Object.keys(LIFECYCLE_PRIORITY)) {
    for (const item of records(lifecycle[group])) {
      const sid = text(item.strategy_id, '')
      if (sid === '') continue
      const existing = fullLineageBySid.get(sid)
      const priority = LIFECYCLE_PRIORITY[group] ?? 0
      if (existing === undefined || priority > (LIFECYCLE_PRIORITY[existing.status] ?? 0)) {
        fullLineageBySid.set(sid, { entry: item, status: group })
      }
    }
  }
  // 链路图只展示生效策略：active 节点 + 沿 mutated_from 上溯的母链（保持母→子演化关系），候选/退役后代不展示
  const lineageBySid = new Map<string, { entry: Record<string, unknown>; status: string }>()
  const lineageVisible = new Set<string>()
  for (const [sid, node] of fullLineageBySid) {
    if (node.status !== 'active') continue
    let cursor = sid
    while (cursor !== '' && !lineageVisible.has(cursor)) {
      lineageVisible.add(cursor)
      cursor = text(fullLineageBySid.get(cursor)?.entry.mutated_from ?? '', '')
    }
  }
  for (const sid of lineageVisible) {
    const node = fullLineageBySid.get(sid)
    if (node !== undefined) lineageBySid.set(sid, node)
  }
  const lineageChildren = new Map<string, string[]>()
  for (const [sid, node] of lineageBySid) {
    const parent = text(node.entry.mutated_from, '')
    if (parent === '') continue
    const list = lineageChildren.get(parent)
    if (list !== undefined) list.push(sid)
    else lineageChildren.set(parent, [sid])
  }
  const lineageRoots = [...lineageBySid.keys()]
    .filter(sid => text(lineageBySid.get(sid)?.entry.mutated_from ?? '', '') === '')
  const lineageEdgeCount = [...lineageChildren.values()].reduce((sum, list) => sum + list.length, 0)
  const attrBySid = new Map<string, Record<string, unknown>>()
  for (const row of strategyRows) {
    const sid = text(row.strategy_id, '')
    if (sid !== '') attrBySid.set(sid, row)
  }
  const lastAppliedAt = text(statusRecord.last_applied_at, '')
  const closedLoopEnabled = statusRecord.closed_loop_enabled === true
  const closedLoopTime = text(statusRecord.closed_loop_time, '15:35')
  const firstError = [status.state, attribution.state].find(item => item.phase === 'error')
  const days = number(statusRecord.days_of_data) ?? 0
  const minDays = number(statusRecord.min_days) ?? 0
  const readiness = minDays <= 0 ? 0 : Math.min(100, (days / minDays) * 100)

  return (
    <div className={css.pageScroll}>
      <PageHeading title="自进化 · 全自动闭环" description="闭环每日自动执行 影子验证 → 归因 → 进化应用 → 候选验证，无需人工确认。本页实时展示各策略当前判定与最近自动进化记录。">
        <button type="button" className={css.secondaryButton} onClick={load}>刷新</button>
        <button type="button" className={css.secondaryButton} onClick={() => { onAnalyze({ kind: 'evolution' }) }}>AI 复核当前判定</button>
      </PageHeading>
      <div className={css.evolutionGuide}>闭环在每日收盘后自动运行，自动应用升级/降级/淘汰/变异并验证衍生候选。下方为全自动流程各环节的当前状态，仅作留痕与查看。</div>
      <section className={css.evolutionFlow} aria-label="自进化流程">
        <div data-state={days > 0 ? 'completed' : 'active'}><span>1</span><strong>影子验证</strong><small>自动 · {days}/{minDays || '—'} 个交易日</small></div>
        <div data-state={strategyRows.length > 0 ? 'completed' : days > 0 ? 'active' : undefined}><span>2</span><strong>归因分析</strong><small>自动 · {strategyRows.length} 条策略证据</small></div>
        <div data-state={lastAppliedAt !== '' ? 'completed' : statusRecord.ready === true ? 'active' : undefined}><span>3</span><strong>进化应用</strong><small>自动 · {lastAppliedAt !== '' ? '上次 ' + lastAppliedAt : '待首次应用'}</small></div>
        <div data-state={(number(counts.candidate) ?? 0) > 0 ? 'active' : 'completed'}><span>4</span><strong>候选验证</strong><small>自动 · {number(counts.candidate)?.toFixed(0) ?? '—'} 个待验证候选</small></div>
      </section>
      {firstError !== undefined && <DataError message={firstError.error} retry={load} />}
      {status.state.phase === 'loading' && status.state.value === undefined
        && attribution.state.phase === 'loading' && attribution.state.value === undefined && <BusyRows />}
      <section className={css.moduleGrid} aria-label="进化状态与归因">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>闭环运行状态</strong><StatusBadge value={closedLoopEnabled ? 'done' : 'waiting_data'} /></div>
          <div className={css.evolutionReadiness}>
            <div><span>数据完成度</span><strong>{Math.round(readiness)}%</strong></div>
            <progress max="100" value={readiness} aria-label="自进化数据完成度" />
            <small>{text(statusRecord.note, statusRecord.ready === true ? '数据门槛已满足；闭环会在收盘后自动应用进化。' : '继续运行影子验证以累积真实数据。')}</small>
          </div>
          <dl className={css.reportMeta}>
            <div><dt>上次自动应用</dt><dd>{lastAppliedAt === '' ? '尚未应用' : lastAppliedAt}</dd></div>
            <div><dt>下次自动运行</dt><dd>每日 {closedLoopTime}{!closedLoopEnabled && <StatusBadge value="waiting_data" />}</dd></div>
          </dl>
          <div className={css.lifecycleNav} aria-label="生命周期分组">
            {(['active', 'candidate', 'retired'] as const).map(key => (
              <button
                type="button"
                data-active={openLifecycle === key || undefined}
                aria-expanded={openLifecycle === key}
                key={key}
                onClick={() => { setOpenLifecycle(openLifecycle === key ? '' : key); setOpenDetailSid('') }}
              >
                <span>{LIFECYCLE_LABELS[key]}</span>
                <strong>{number(counts[key])?.toFixed(0) ?? '0'}</strong>
              </button>
            ))}
          </div>
          {openLifecycle !== '' && (
            <div className={css.lifecycleList}>
              {lifecycleEntries.map((item, index) => {
                const sid = text(item.strategy_id, '')
                const symbols = strings(item.symbols)
                const open = openDetailSid === sid
                const resolvedName = (code: string): string => {
                  const name = text(securityNames[code], '')
                  return name === '' || name === code ? code : `${name} · ${code}`
                }
                return (
                  <div className={css.strategyEntry} key={`lc-${sid}-${index}`}>
                    <button
                      type="button"
                      className={css.dataRow}
                      data-active={open || undefined}
                      aria-expanded={open}
                      onClick={() => { setOpenDetailSid(open ? '' : sid) }}
                    >
                      <div>
                        <strong>
                          <span className={css.strategyTag}>{strategyLabel(sid)}</span>
                          {strategyTargetLabel(item, securityNames)}
                        </strong>
                        <small>{strategyKindLabel(item.kind)} · tier {number(item.tier)?.toFixed(0) ?? '1'}</small>
                      </div>
                      <span className={css.evolutionEvidenceMeta}>
                        <small>{symbols.length === 0 ? '暂无标的' : `${symbols.length} 只标的`}</small>
                      </span>
                    </button>
                    {open && (
                      <div className={css.strategyDetail} role="region" aria-label="策略基础详情">
                        <div className={css.strategyDetailHead}>
                          <strong>{strategyTargetLabel(item, securityNames)}</strong>
                          <span>{strategyKindLabel(item.kind)} · tier {number(item.tier)?.toFixed(0) ?? '1'}</span>
                        </div>
                        <div className={css.strategyDetailSymbols}>
                          <span className={css.strategyDetailSymbolLabel}>关联标的</span>
                          {symbols.length === 0 && <small className={css.strategyDetailSymbolLabel}>暂无标的</small>}
                          {symbols.map((code, symbolIndex) => (
                            <button
                              type="button"
                              className={css.strategySymbolChip}
                              key={`${code}-${symbolIndex}`}
                              onClick={() => { onOpenStock(code) }}
                            >
                              {resolvedName(code)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {lifecycleEntries.length === 0 && <div className={css.emptyPanel}>该类目暂无策略。</div>}
            </div>
          )}
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
      </section>
      <section className={css.moduleGrid} aria-label="策略判定与自动进化记录">
        <article className={`${css.moduleCard} ${css.strategyStatusCard}`}>
          <div className={css.sectionHeading}><strong>策略现状</strong><span>{perStrategy.length} 项 · 点击展开详情</span></div>
          <div className={css.dataList}>
            {perStrategy.map((item, index) => {
              const sid = text(item.strategy_id, '')
              const symbols = strings(item.symbols)
              const decision = text(item.decision, '')
              const badge = decision === '' || decision === 'none' ? text(item.behavior, '正常运行') : decision
              const attr = attrBySid.get(sid) ?? {}
              const expanded = expandedSid === sid
              const resolvedName = (code: string): string => {
                const name = text(securityNames[code], '')
                return name === '' || name === code ? code : `${name} · ${code}`
              }
              return (
                <div className={css.strategyEntry} key={`per-strategy-${sid}-${index}`}>
                  <button
                    type="button"
                    className={css.dataRow}
                    data-active={expanded || undefined}
                    aria-expanded={expanded}
                    onClick={() => { setExpandedSid(expanded ? '' : sid) }}
                  >
                    <div>
                      <strong>
                        <span className={css.strategyTag}>{strategyLabel(sid)}</span>
                        {strategyTargetLabel(item, securityNames)}
                      </strong>
                      <small>{strategyKindLabel(item.kind)} · {text(item.reason, '')}</small>
                    </div>
                    <span className={css.evolutionEvidenceMeta}>
                      <strong><StatusBadge value={badge} /></strong>
                      <small>净值 {compactMetric(item.nav)} · 收益 {compactMetric(attr.return_pct, '%')}</small>
                    </span>
                  </button>
                  {expanded && (
                    <div className={css.strategyDetail} role="region" aria-label="策略现状详情">
                      <div className={css.strategyDetailHead}>
                        <strong>{strategyTargetLabel(item, securityNames)}</strong>
                        <span>{strategyKindLabel(item.kind)} · tier {number(item.tier)?.toFixed(0) ?? '1'}</span>
                        <span>{badge}</span>
                      </div>
                      <p className={css.strategyDetailReason}>判定依据：{text(item.reason, '')}</p>
                      <dl className={css.strategyDetailGrid}>
                        <div><dt>影子净值</dt><dd>{compactMetric(item.nav)}</dd></div>
                        <div><dt>累计收益</dt><dd>{compactMetric(attr.return_pct, '%')}</dd></div>
                        <div><dt>最大回撤</dt><dd>{compactMetric(attr.max_drawdown_pct, '%')}</dd></div>
                        <div><dt>平仓胜率</dt><dd>{compactMetric(item.closed_win_rate_pct, '%')}</dd></div>
                        <div><dt>已平仓</dt><dd>{number(item.closed_trades)?.toFixed(0) ?? '0'} 笔</dd></div>
                      </dl>
                      <div className={css.strategyDetailSymbols}>
                        <span className={css.strategyDetailSymbolLabel}>关联标的</span>
                        {symbols.length === 0 && <small className={css.strategyDetailSymbolLabel}>暂无标的</small>}
                        {symbols.map((code, symbolIndex) => (
                          <button
                            type="button"
                            className={css.strategySymbolChip}
                            key={`${code}-${symbolIndex}`}
                            onClick={() => { onOpenStock(code) }}
                          >
                            {resolvedName(code)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {perStrategy.length === 0 && status.state.phase === 'success' && <Empty>暂无生效策略；影子数据达标后自动进入闭环判定。</Empty>}
          </div>
        </article>
      </section>
      <section className={css.moduleGrid} aria-label="策略演化链路">
        <article className={`${css.moduleCard} ${css.lineageCard}`}>
          <div className={css.sectionHeading}>
            <strong>策略演化链路</strong>
            <span>仅生效 · {lineageBySid.size} 个策略 · {lineageEdgeCount} 条衍生</span>
          </div>
          {lineageRoots.length === 0 && <Empty>暂无生效中的演化链路。</Empty>}
          <div className={css.lineageTree}>
            {lineageRoots.map(rootSid => (
              <LineageNode
                key={rootSid}
                sid={rootSid}
                depth={0}
                bySid={lineageBySid}
                childrenByParent={lineageChildren}
                securityNames={securityNames}
                onOpenStock={onOpenStock}
              />
            ))}
          </div>
        </article>
      </section>
      <section className={css.moduleGrid} aria-label="策略判定与自动进化记录">
        <article className={`${css.moduleCard} ${css.evolutionEvidenceCard}`}>
          <div className={css.sectionHeading}><strong>最近自动进化</strong><span>{recentApplied.length} 条</span></div>
          <div className={css.dataList}>
            {recentApplied.map((item, index) => (
              <div className={css.dataRow} key={`applied-${text(item.applied_at)}-${index}`}>
                <div>
                  <strong>{text(item.applied_at, '')} · 自动应用 {number(item.count)?.toFixed(0) ?? '0'} 项动作</strong>
                  <small>{records(item.actions).map(action => text(action.reason, '')).join('；')}</small>
                </div>
                <span className={css.evolutionEvidenceMeta}>
                  {records(item.actions).map((action, actionIndex) => (
                    <StatusBadge key={`${text(item.applied_at)}-${actionIndex}`} value={text(action.type, '')} />
                  ))}
                </span>
              </div>
            ))}
            {recentApplied.length === 0 && status.state.phase === 'success' && <Empty>尚未有自动进化记录；闭环将在数据达标后自动应用进化。</Empty>}
          </div>
        </article>
      </section>
    </div>
  )
}

function LineageNode({
  sid, depth, bySid, childrenByParent, securityNames, onOpenStock,
}: {
  readonly sid: string
  readonly depth: number
  readonly bySid: ReadonlyMap<string, { readonly entry: Record<string, unknown>; readonly status: string }>
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>
  readonly securityNames: Readonly<Record<string, string>>
  readonly onOpenStock: (code: string) => void
}) {
  const node = bySid.get(sid)
  if (node === undefined) return null
  const muted = node.status !== 'active' // 仅生效链路上的非 active 母策略弱化显示
  const symbols = strings(node.entry.symbols)
  const primaryCode = symbols[0]
  const childSids = childrenByParent.get(sid) ?? []
  return (
    <div className={css.lineageNode} data-depth={depth} data-muted={muted || undefined}>
      <div className={css.lineageRow}>
        <span className={css.lineageConnector} aria-hidden="true" />
        <button
          type="button"
          className={css.lineageLabel}
          disabled={primaryCode === undefined}
          onClick={() => { if (primaryCode !== undefined) onOpenStock(primaryCode) }}
        >
          <span className={css.strategyTag}>{strategyLabel(sid)}</span>
          <strong>{text(node.entry.name, strategyTargetLabel(node.entry, securityNames))}</strong>
          <StatusBadge value={node.status} />
        </button>
        <small>{strategyKindLabel(node.entry.kind)} · tier {number(node.entry.tier)?.toFixed(0) ?? '1'} · {strings(node.entry.symbols).length} 只标的</small>
      </div>
      {childSids.length > 0 && (
        <div className={css.lineageChildren}>
          {childSids.map(childSid => (
            <LineageNode
              key={childSid}
              sid={childSid}
              depth={depth + 1}
              bySid={bySid}
              childrenByParent={childrenByParent}
              securityNames={securityNames}
              onOpenStock={onOpenStock}
            />
          ))}
        </div>
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

type IndustryGraphDirection = 'center' | 'up' | 'down' | 'related'

interface IndustryGraphRelationData {
  readonly direction: 'up' | 'down'
  readonly depth: number
  readonly share: number | undefined
  readonly via: string
  readonly relationType: string
  readonly note: string
}

interface IndustryGraphNodeData {
  readonly id: string
  readonly name: string
  readonly code: string
  readonly rawKey: string
  readonly label: string
  readonly direction: IndustryGraphDirection
  readonly depth: number
  readonly expandable: boolean
  readonly loaded: boolean
  readonly isRoot: boolean
  readonly share: number | undefined
  readonly via: string
  readonly relationType: string
  readonly note: string
  readonly relations: readonly IndustryGraphRelationData[]
  readonly profile: Record<string, unknown>
  readonly x: number
  readonly y: number
}

interface IndustryGraphEdgeData {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly direction: 'up' | 'down'
  readonly depth: number
  readonly share: number | undefined
  readonly via: string
  readonly relationType: string
  readonly note: string
  readonly tone?: IndustryGraphDirection
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
  targetX: number
  targetY: number
  readonly fixed: boolean
}

interface IndustryGraphViewState {
  particles: Map<string, IndustryGraphParticle>
  topologySignature: string
  pan: { readonly x: number; readonly y: number }
  zoom: number
}

interface IndustryChainSnapshot {
  readonly center: Record<string, unknown>
  readonly upLevels: readonly Record<string, unknown>[]
  readonly downLevels: readonly Record<string, unknown>[]
}

interface IndustryChainPathStep extends IndustryCompanySelection {
  readonly nodeId: string
  readonly direction?: 'up' | 'down'
  readonly via?: string
  readonly share?: number
  readonly relationType?: string
}

interface IndustryGraphConnection {
  readonly sourceId: string
  readonly sourceName: string
  readonly sourceCode: string
  readonly target: IndustryCompanySelection
  readonly direction: 'up' | 'down'
  readonly via: string
  readonly share: number | undefined
  readonly relationType: string
  readonly note: string
}

interface IndustryGraphDrillRequest {
  readonly company: IndustryCompanySelection
  readonly sourceId: string
  readonly sourceName: string
  readonly sourceCode: string
  readonly targetId: string
  readonly direction: 'up' | 'down'
  readonly via: string
  readonly share: number | undefined
  readonly relationType: string
  readonly note: string
}

interface IndustryGraphControls {
  readonly fit: () => void
  readonly zoomIn: () => void
  readonly zoomOut: () => void
}

function industryGraphIdentity(code: string, name: string, rawId = ''): string {
  const cleanCode = code.trim()
  if (cleanCode !== '') return `company:${cleanCode}`
  const cleanId = rawId.trim()
  if (cleanId !== '') return `entity:${cleanId}`
  return `entity-name:${name.trim() || 'unknown'}`
}

function industryGraphRelationKey(relation: IndustryGraphRelationData): string {
  return `${relation.direction}|${relation.depth}|${relation.via}|${relation.relationType}|${relation.note}`
}

function industryGraphData(
  root: IndustryCompanySelection,
  snapshots: readonly IndustryChainSnapshot[],
  connections: readonly IndustryGraphConnection[],
): IndustryGraphData {
  const nodes = new Map<string, IndustryGraphNodeData>()
  const edges = new Map<string, IndustryGraphEdgeData>()
  const rootId = industryGraphIdentity(root.code, root.name)
  const ensureNode = ({
    id, name, code, rawKey = '', loaded = false, isRoot = false, relation, profile = {},
  }: {
    readonly id: string
    readonly name: string
    readonly code: string
    readonly rawKey?: string
    readonly loaded?: boolean
    readonly isRoot?: boolean
    readonly relation?: IndustryGraphRelationData
    readonly profile?: Record<string, unknown>
  }): void => {
    const previous = nodes.get(id)
    const relations = relation === undefined
      ? previous?.relations ?? []
      : previous?.relations.some(item => industryGraphRelationKey(item) === industryGraphRelationKey(relation)) === true
        ? previous.relations
        : [...(previous?.relations ?? []), relation]
    const primary = relations[0]
    const resolvedName = name || previous?.name || '未命名环节'
    const resolvedCode = code || previous?.code || ''
    nodes.set(id, {
      id,
      name: resolvedName,
      code: resolvedCode,
      rawKey: rawKey || previous?.rawKey || resolvedName,
      label: resolvedCode === '' ? resolvedName : `${resolvedName}\n${resolvedCode}`,
      direction: previous?.direction ?? 'center',
      depth: previous?.depth ?? 0,
      expandable: previous?.expandable === true || resolvedCode !== '',
      loaded: previous?.loaded === true || loaded,
      isRoot: previous?.isRoot === true || isRoot,
      share: primary?.share,
      via: primary?.via ?? '',
      relationType: primary?.relationType ?? '',
      note: primary?.note ?? '',
      relations,
      profile: { ...(previous?.profile ?? {}), ...profile },
      x: previous?.x ?? 0,
      y: previous?.y ?? 0,
    })
  }
  const ensureEdge = (edge: Omit<IndustryGraphEdgeData, 'id'>): void => {
    const id = `${edge.source}->${edge.target}|${edge.via}|${edge.relationType}`
    if (!edges.has(id)) edges.set(id, { id, ...edge })
  }

  ensureNode({ id: rootId, name: root.name, code: root.code, loaded: false, isRoot: true })

  for (const snapshot of snapshots) {
    const centerCode = text(snapshot.center.code, '')
    const centerName = text(snapshot.center.name, '未命名公司')
    const centerRawId = text(snapshot.center.id, '')
    const centerId = industryGraphIdentity(centerCode, centerName, centerRawId)
    ensureNode({
      id: centerId,
      name: centerName,
      code: centerCode,
      rawKey: centerRawId,
      loaded: true,
      isRoot: centerId === rootId,
      profile: snapshot.center,
    })

    const appendLevels = (levels: readonly Record<string, unknown>[], direction: 'up' | 'down'): void => {
      const identifiers = new Map<string, string>()
      for (const value of [centerCode, centerRawId, centerName]) {
        if (value !== '') identifiers.set(value, centerId)
      }
      for (const [levelIndex, level] of levels.entries()) {
        const levelNodes = records(level.nodes)
        const rawDepth = number(level.level)
        const depth = rawDepth === undefined ? levelIndex + 1 : Math.abs(rawDepth)
        const levelIds: Array<readonly [Record<string, unknown>, string]> = []
        for (const [nodeIndex, node] of levelNodes.entries()) {
          const rawId = text(node.id, text(node.name, `node-${nodeIndex}`))
          const name = text(node.name, '未命名环节')
          const code = text(node.code, '')
          const nodeId = industryGraphIdentity(code, name, rawId)
          levelIds.push([node, nodeId])
          for (const value of [rawId, name, code]) {
            if (value !== '') identifiers.set(value, nodeId)
          }
          ensureNode({
            id: nodeId,
            name,
            code,
            rawKey: rawId,
            relation: {
              direction,
              depth,
              share: number(node.share),
              via: text(node.via, ''),
              relationType: industryRelation(node.type),
              note: text(node.note, ''),
            },
          })
        }
        for (const [node, nodeId] of levelIds) {
          const parentId = identifiers.get(text(node.parent_id, '')) ?? centerId
          ensureEdge({
            source: direction === 'up' ? nodeId : parentId,
            target: direction === 'up' ? parentId : nodeId,
            direction,
            depth,
            share: number(node.share),
            via: text(node.via, ''),
            relationType: industryRelation(node.type),
            note: text(node.note, ''),
          })
        }
      }
    }

    appendLevels(snapshot.upLevels, 'up')
    appendLevels(snapshot.downLevels, 'down')
  }

  for (const connection of connections) {
    const targetId = industryGraphIdentity(connection.target.code, connection.target.name)
    ensureNode({
      id: connection.sourceId,
      name: connection.sourceName,
      code: connection.sourceCode,
    })
    ensureNode({
      id: targetId,
      name: connection.target.name,
      code: connection.target.code,
      relation: {
        direction: connection.direction,
        depth: 1,
        share: connection.share,
        via: connection.via,
        relationType: connection.relationType,
        note: connection.note,
      },
    })
    ensureEdge({
      source: connection.direction === 'up' ? targetId : connection.sourceId,
      target: connection.direction === 'up' ? connection.sourceId : targetId,
      direction: connection.direction,
      depth: 1,
      share: connection.share,
      via: connection.via,
      relationType: connection.relationType,
      note: connection.note,
    })
  }

  const ranks = new Map<string, number>([[rootId, 0]])
  for (let pass = 0; pass < nodes.size; pass += 1) {
    let changed = false
    for (const edge of edges.values()) {
      const sourceRank = ranks.get(edge.source)
      const targetRank = ranks.get(edge.target)
      if (sourceRank !== undefined && targetRank === undefined) {
        ranks.set(edge.target, sourceRank + 1)
        changed = true
      } else if (targetRank !== undefined && sourceRank === undefined) {
        ranks.set(edge.source, targetRank - 1)
        changed = true
      }
    }
    if (!changed) break
  }
  for (const node of nodes.values()) {
    if (ranks.has(node.id)) continue
    ranks.set(node.id, node.relations[0]?.direction === 'up' ? -1 : 1)
  }

  const rankGroups = new Map<number, IndustryGraphNodeData[]>()
  for (const node of nodes.values()) {
    const rank = ranks.get(node.id) ?? 0
    const group = rankGroups.get(rank) ?? []
    group.push(node)
    rankGroups.set(rank, group)
  }
  for (const group of rankGroups.values()) {
    group.sort((left, right) => Number(right.loaded) - Number(left.loaded) || left.name.localeCompare(right.name, 'zh-CN'))
  }

  const laidOutNodes = [...nodes.values()].map((node): IndustryGraphNodeData => {
    const rank = ranks.get(node.id) ?? 0
    const group = rankGroups.get(rank) ?? [node]
    const index = Math.max(group.findIndex(item => item.id === node.id), 0)
    const primary = node.relations[0]
    const direction: IndustryGraphDirection = node.id === rootId
      ? 'center'
      : rank < 0 || (rank === 0 && primary?.direction === 'up') ? 'up' : 'down'
    return {
      ...node,
      direction,
      depth: Math.abs(rank) || primary?.depth || 0,
      share: node.id === rootId ? undefined : node.share,
      via: node.id === rootId ? '' : node.via,
      relationType: node.id === rootId ? '' : node.relationType,
      note: node.id === rootId ? '' : node.note,
      x: rank * 268,
      y: (index - (group.length - 1) / 2) * 122,
    }
  })
  return { nodes: laidOutNodes, edges: [...edges.values()] }
}

function industryGraphPerspective(graph: IndustryGraphData, focusId: string): IndustryGraphData {
  if (!graph.nodes.some(node => node.id === focusId)) return graph
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  const append = (map: Map<string, string[]>, key: string, value: string): void => {
    const current = map.get(key) ?? []
    current.push(value)
    map.set(key, current)
  }
  for (const edge of graph.edges) {
    append(outgoing, edge.source, edge.target)
    append(incoming, edge.target, edge.source)
  }
  const walk = (map: ReadonlyMap<string, readonly string[]>): Map<string, number> => {
    const distances = new Map<string, number>([[focusId, 0]])
    const queue = [focusId]
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      if (current === undefined) continue
      const distance = distances.get(current) ?? 0
      for (const next of map.get(current) ?? []) {
        if (distances.has(next)) continue
        distances.set(next, distance + 1)
        queue.push(next)
      }
    }
    distances.delete(focusId)
    return distances
  }
  const upstream = walk(incoming)
  const downstream = walk(outgoing)
  const directions = new Map<string, IndustryGraphDirection>()
  const depths = new Map<string, number>()
  for (const node of graph.nodes) {
    if (node.id === focusId) {
      directions.set(node.id, 'center')
      depths.set(node.id, 0)
      continue
    }
    const upDepth = upstream.get(node.id)
    const downDepth = downstream.get(node.id)
    if (upDepth !== undefined && (downDepth === undefined || upDepth < downDepth)) {
      directions.set(node.id, 'up')
      depths.set(node.id, upDepth)
    } else if (downDepth !== undefined && (upDepth === undefined || downDepth < upDepth)) {
      directions.set(node.id, 'down')
      depths.set(node.id, downDepth)
    } else {
      directions.set(node.id, 'related')
      depths.set(node.id, 0)
    }
  }
  const nodes = graph.nodes.map((node): IndustryGraphNodeData => ({
    ...node,
    direction: directions.get(node.id) ?? 'related',
    depth: depths.get(node.id) ?? 0,
  }))
  const directionFor = (id: string): IndustryGraphDirection => directions.get(id) ?? 'related'
  const edges = graph.edges.map((edge): IndustryGraphEdgeData => {
    const sourceDirection = directionFor(edge.source)
    const targetDirection = directionFor(edge.target)
    const upstreamEdge = (
      sourceDirection === 'up' && (targetDirection === 'up' || targetDirection === 'center')
    ) || (targetDirection === 'up' && sourceDirection === 'center')
    const downstreamEdge = (
      targetDirection === 'down' && (sourceDirection === 'down' || sourceDirection === 'center')
    ) || (sourceDirection === 'down' && targetDirection === 'center')
    const tone: IndustryGraphDirection = upstreamEdge ? 'up' : downstreamEdge ? 'down' : 'related'
    return { ...edge, tone }
  })
  return { nodes, edges }
}

function IndustryPhysicsGraph({
  graph, activeNodeId, selectedNodeId, ariaLabel, viewState, onSelect, onDrill, onReady,
}: {
  readonly graph: IndustryGraphData
  readonly activeNodeId: string
  readonly selectedNodeId: string
  readonly ariaLabel: string
  readonly viewState: { current: IndustryGraphViewState }
  readonly onSelect: (node: IndustryGraphNodeData) => void
  readonly onDrill: (node: IndustryGraphNodeData) => void
  readonly onReady: (controls: IndustryGraphControls | undefined) => void
}) {
  const particles = useRef(viewState.current.particles)
  const frame = useRef<number>()
  const activeUntil = useRef(0)
  const topologySignature = [
    graph.nodes.map(node => `${node.id}:${node.x}:${node.y}`).join('|'),
    graph.edges.map(edge => `${edge.id}:${edge.source}:${edge.target}`).join('|'),
  ].join('||')
  const topologySignatureRef = useRef(viewState.current.topologySignature)
  const activeNodeIdRef = useRef(activeNodeId)
  const physicsNodes = useRef(graph.nodes)
  const physicsEdges = useRef(graph.edges)
  physicsNodes.current = graph.nodes
  physicsEdges.current = graph.edges
  const markerId = `industry-graph-arrow-${useId().replace(/:/gu, '')}`
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
  const suppressedNodeClick = useRef<{ readonly nodeId: string; readonly until: number }>()
  const [positions, setPositions] = useState<Record<string, { readonly x: number; readonly y: number }>>(() => (
    Object.fromEntries([...viewState.current.particles].map(([id, value]) => [id, { x: value.x, y: value.y }]))
  ))
  const [pan, setPanState] = useState(viewState.current.pan)
  const [zoom, setZoomState] = useState(viewState.current.zoom)
  const setPan = useCallback((next: SetStateAction<{ readonly x: number; readonly y: number }>) => {
    setPanState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      viewState.current.pan = resolved
      return resolved
    })
  }, [viewState])
  const setZoom = useCallback((next: SetStateAction<number>) => {
    setZoomState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      viewState.current.zoom = resolved
      return resolved
    })
  }, [viewState])
  const graphNodeCount = graph.nodes.length
  const minGraphX = graphNodeCount === 0 ? 0 : Math.min(...graph.nodes.map(node => node.x))
  const maxGraphX = graphNodeCount === 0 ? 0 : Math.max(...graph.nodes.map(node => node.x))
  const minGraphY = graphNodeCount === 0 ? 0 : Math.min(...graph.nodes.map(node => node.y))
  const maxGraphY = graphNodeCount === 0 ? 0 : Math.max(...graph.nodes.map(node => node.y))

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
        if (particle.fixed || id === draggedId) continue
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
          if (!a.fixed) { a.vx -= fx; a.vy -= fy }
          if (!b.fixed) { b.vx += fx; b.vy += fy }
        }
      }
      for (const edge of physicsEdges.current) {
        const source = particles.current.get(edge.source)
        const target = particles.current.get(edge.target)
        if (source === undefined || target === undefined) continue
        const dx = target.x - source.x
        const dy = target.y - source.y
        const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const stretch = (distance - 218) * 0.0028
        const fx = dx / distance * stretch
        const fy = dy / distance * stretch
        if (!source.fixed && edge.source !== draggedId) { source.vx += fx; source.vy += fy }
        if (!target.fixed && edge.target !== draggedId) { target.vx -= fx; target.vy -= fy }
      }
      let movement = 0
      for (const [id, particle] of values) {
        if (particle.fixed) {
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
  }, [renderParticles])

  const fitGraph = useCallback(() => {
    if (graphNodeCount === 0) return
    const nextZoom = Math.min(1.08, Math.max(0.3, Math.min(
      1_070 / Math.max(maxGraphX - minGraphX + 240, 1),
      650 / Math.max(maxGraphY - minGraphY + 180, 1),
    )))
    setZoom(nextZoom)
    setPan({
      x: -((minGraphX + maxGraphX) / 2) * nextZoom,
      y: -((minGraphY + maxGraphY) / 2) * nextZoom,
    })
    runPhysics(420)
  }, [graphNodeCount, maxGraphX, maxGraphY, minGraphX, minGraphY, runPhysics])

  useLayoutEffect(() => {
    if (activeNodeIdRef.current === activeNodeId) return
    activeNodeIdRef.current = activeNodeId
    activeUntil.current = 0
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
    frame.current = undefined
    for (const particle of particles.current.values()) {
      particle.vx = 0
      particle.vy = 0
    }
  }, [activeNodeId])

  useEffect(() => {
    if (topologySignatureRef.current === topologySignature) return
    topologySignatureRef.current = topologySignature
    viewState.current.topologySignature = topologySignature
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
    frame.current = undefined
    const previous = particles.current
    const next = new Map<string, IndustryGraphParticle>()
    for (const node of physicsNodes.current) {
      const retained = previous.get(node.id)
      next.set(node.id, {
        x: retained?.x ?? node.x * 0.86,
        y: retained?.y ?? node.y * 0.82,
        vx: retained?.vx ?? 0,
        vy: retained?.vy ?? 0,
        targetX: node.x,
        targetY: node.y,
        fixed: node.isRoot,
      })
    }
    particles.current = next
    viewState.current.particles = next
    renderParticles()
    fitGraph()
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion) runPhysics(620)
  }, [fitGraph, renderParticles, runPhysics, topologySignature])

  useEffect(() => () => {
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
    frame.current = undefined
  }, [])

  useEffect(() => {
    onReady({
      fit: fitGraph,
      zoomIn: () => { setZoom(current => Math.min(2.2, current * 1.2)) },
      zoomOut: () => { setZoom(current => Math.max(0.3, current / 1.2)) },
    })
    return () => { onReady(undefined) }
  }, [fitGraph, onReady])

  const startNodeDrag = (event: ReactPointerEvent<SVGGElement>, node: IndustryGraphNodeData): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (node.isRoot) return
    event.currentTarget.setPointerCapture(event.pointerId)
    interaction.current = {
      kind: 'node', pointerId: event.pointerId, nodeId: node.id,
      clientX: event.clientX, clientY: event.clientY, panX: pan.x, panY: pan.y, moved: false,
    }
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
    const scaleX = rect.width === 0 ? 1 : 1_280 / rect.width
    const scaleY = rect.height === 0 ? 1 : 800 / rect.height
    const dx = (event.clientX - active.clientX) * scaleX / zoom
    const dy = (event.clientY - active.clientY) * scaleY / zoom
    if (active.kind === 'pan') {
      if (Math.abs(dx) + Math.abs(dy) > 3) active.moved = true
      setPan({ x: active.panX + dx * zoom, y: active.panY + dy * zoom })
      return
    }
    if (!active.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= 3) return
      active.moved = true
      runPhysics(1_200)
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
    if (active.kind === 'node' && active.moved) {
      suppressedNodeClick.current = { nodeId: active.nodeId, until: performance.now() + 300 }
      runPhysics(900)
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
      aria-label={ariaLabel}
      onPointerDown={startPan}
      onPointerMove={movePointer}
      onPointerUp={stopPointer}
      onPointerCancel={stopPointer}
      onWheel={zoomGraph}
    >
      <defs>
        {(['up', 'down', 'related'] as const).map(direction => (
          <marker
            id={`${markerId}-${direction}`}
            data-direction={direction}
            key={direction}
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path d="M0,0 L7,3.5 L0,7 Z" />
          </marker>
        ))}
      </defs>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        <g className={css.industryPhysicsEdges}>
          {graph.edges.map((edge) => {
            const source = positions[edge.source]
            const target = positions[edge.target]
            if (source === undefined || target === undefined) return null
            const direction = edge.tone ?? edge.direction
            return (
              <line
                data-direction={direction}
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                markerEnd={`url(#${markerId}-${direction})`}
              />
            )
          })}
        </g>
        <g className={css.industryPhysicsNodes}>
          {graph.nodes.map((node) => {
            const position = positions[node.id] ?? { x: node.x, y: node.y }
            const relationSummary = [node.via, node.share === undefined ? '' : `${node.share.toFixed(1)}%`].filter(Boolean).join(' · ')
            const secondaryLines = Number(node.code !== '') + Number(relationSummary !== '')
            const isFocus = node.id === activeNodeId
            const directionLabel = node.direction === 'center'
              ? '当前视角'
              : node.direction === 'up'
                ? `上游第 ${node.depth} 层`
                : node.direction === 'down'
                  ? `下游第 ${node.depth} 层`
                  : '旁支关联'
            return (
              <g
                key={node.id}
                data-graph-node
                data-direction={node.direction}
                data-expandable={node.expandable || undefined}
                data-loaded={node.loaded || undefined}
                data-current={node.id === activeNodeId || undefined}
                data-selected={node.id === selectedNodeId || undefined}
                role="button"
                tabIndex={0}
                aria-pressed={node.id === selectedNodeId}
                aria-label={`${node.name}${node.code === '' ? '' : ` ${node.code}`}，${directionLabel}`}
                transform={`translate(${position.x} ${position.y})`}
                onPointerDown={(event) => { startNodeDrag(event, node) }}
                onClick={(event) => {
                  event.stopPropagation()
                  const suppressed = suppressedNodeClick.current
                  suppressedNodeClick.current = undefined
                  if (suppressed?.nodeId === node.id && performance.now() <= suppressed.until) return
                  onSelect(node)
                }}
                onDoubleClick={(event) => { event.stopPropagation(); if (node.code !== '') onDrill(node) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(node)
                }}
              >
                <rect x={isFocus ? -98 : -91} y={isFocus ? -41 : -38} width={isFocus ? 196 : 182} height={isFocus ? 82 : 76} rx="12" />
                {(node.direction === 'up' || node.direction === 'down') && (
                  <path
                    className={css.industryPhysicsNodeAccent}
                    d={node.direction === 'up' ? 'M-84 -25 V25' : 'M84 -25 V25'}
                  />
                )}
                <text textAnchor="middle" dominantBaseline="middle">
                  <tspan x="0" dy={secondaryLines === 2 ? '-1.05em' : secondaryLines === 1 ? '-0.52em' : '0'}>{node.name}</tspan>
                  {node.code !== '' && <tspan x="0" dy="1.45em">{node.code}</tspan>}
                  {relationSummary !== '' && <tspan x="0" dy="1.4em">{relationSummary}</tspan>}
                </text>
              </g>
            )
          })}
        </g>
      </g>
    </svg>
  )
}

function IndustryGraphExplorer({
  graph, path, activeCompany, selectedNode, entityState, entityRequested, loading, compact,
  leafNotice, viewState, onNavigate, onSelect, onDrill, onOpenStock, onDismissNotice,
  onSetCenter,
}: {
  readonly graph: IndustryGraphData
  readonly path: readonly IndustryChainPathStep[]
  readonly activeCompany: IndustryCompanySelection
  readonly selectedNode: IndustryGraphNodeData
  readonly entityState: DataState
  readonly entityRequested: boolean
  readonly loading: boolean
  readonly compact: boolean
  readonly leafNotice: string
  readonly viewState: { current: IndustryGraphViewState }
  readonly onNavigate: (index: number) => void
  readonly onSelect: (node: IndustryGraphNodeData) => void
  readonly onDrill: (request: IndustryGraphDrillRequest) => void
  readonly onSetCenter: (company: IndustryCompanySelection) => void
  readonly onOpenStock: (code: string) => void
  readonly onDismissNotice: () => void
}) {
  const controls = useRef<IndustryGraphControls>()
  const navigator = useRef<HTMLElement>(null)
  const receiveControls = useCallback((value: IndustryGraphControls | undefined) => {
    controls.current = value
  }, [])
  useEffect(() => {
    if (navigator.current !== null) navigator.current.scrollTop = 0
  }, [entityState.phase, selectedNode.id])
  const loadedCenterId = industryGraphIdentity(activeCompany.code, activeCompany.name)
  const viewGraph = useMemo(
    () => industryGraphPerspective(graph, selectedNode.id),
    [graph, selectedNode.id],
  )
  const focusedNode = viewGraph.nodes.find(node => node.id === selectedNode.id) ?? selectedNode
  const profile = { ...focusedNode.profile, ...asRecord(entityState.value) }
  const metrics = records(profile.metrics)
  const related = records(profile.related)
  const asSupplier = records(profile.as_supplier)
  const asCustomer = records(profile.as_customer)
  const reportMaterials = records(profile.report_materials)
  const reportProducts = records(profile.report_products)
  const graphDirectory = [...viewGraph.nodes]
    .filter(node => node.id !== focusedNode.id)
    .sort((left, right) => left.x - right.x || left.y - right.y || left.name.localeCompare(right.name, 'zh-CN'))
  const edgeBetween = (leftId: string, rightId: string): IndustryGraphEdgeData | undefined => viewGraph.edges.find(edge => (
    (edge.source === leftId && edge.target === rightId)
      || (edge.target === leftId && edge.source === rightId)
  ))
  const resolveDrillOrigin = (node: IndustryGraphNodeData): {
    readonly sourceId: string
    readonly sourceName: string
    readonly sourceCode: string
    readonly edge: IndustryGraphEdgeData | undefined
  } | undefined => {
    if (node.id === loadedCenterId) {
      return { sourceId: loadedCenterId, sourceName: activeCompany.name, sourceCode: activeCompany.code, edge: undefined }
    }
    const directEdge = edgeBetween(loadedCenterId, node.id)
    if (directEdge !== undefined) {
      return { sourceId: loadedCenterId, sourceName: activeCompany.name, sourceCode: activeCompany.code, edge: directEdge }
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const step = path[index]
      if (step === undefined || step.nodeId === node.id) continue
      const edge = edgeBetween(step.nodeId, node.id)
      if (edge !== undefined) {
        return { sourceId: step.nodeId, sourceName: step.name, sourceCode: step.code, edge }
      }
    }
    const adjacentEdge = viewGraph.edges.find(edge => edge.source === node.id || edge.target === node.id)
    const adjacentId = adjacentEdge?.source === node.id ? adjacentEdge.target : adjacentEdge?.source
    const adjacentNode = viewGraph.nodes.find(candidate => candidate.id === adjacentId)
    if (adjacentEdge !== undefined && adjacentNode !== undefined) {
      return {
        sourceId: adjacentNode.id,
        sourceName: adjacentNode.name,
        sourceCode: adjacentNode.code,
        edge: adjacentEdge,
      }
    }
    return undefined
  }
  const selectedOrigin = resolveDrillOrigin(focusedNode)
  const selectedRelation = focusedNode.id === loadedCenterId && focusedNode.isRoot
    ? { share: undefined, via: '', relationType: '', note: '' }
    : selectedOrigin?.edge ?? {
      share: focusedNode.share,
      via: focusedNode.via,
      relationType: focusedNode.relationType,
      note: focusedNode.note,
    }
  const drillNode = (node: IndustryGraphNodeData): void => {
    if (node.code === '') return
    const pathIndex = path.findIndex(step => step.nodeId === node.id)
    if (pathIndex >= 0 && node.id !== loadedCenterId) {
      onNavigate(pathIndex)
      return
    }
    const origin = resolveDrillOrigin(node)
    if (origin === undefined) return
    const direction: 'up' | 'down' = origin.edge === undefined
      ? node.direction === 'up' ? 'up' : 'down'
      : origin.edge.target === origin.sourceId ? 'up' : 'down'
    onDrill({
      company: { code: node.code, name: node.name },
      sourceId: origin.sourceId,
      sourceName: origin.sourceName,
      sourceCode: origin.sourceCode,
      targetId: node.id,
      direction,
      via: origin.edge?.via ?? node.via,
      share: origin.edge?.share ?? node.share,
      relationType: origin.edge?.relationType ?? node.relationType,
      note: origin.edge?.note ?? node.note,
    })
  }
  const drillRelatedCompany = (row: Record<string, unknown>, direction: 'up' | 'down'): void => {
    const code = text(row.company_code, '').trim()
    const name = text(row.company_name, code)
    if (code === '') return
    onDrill({
      company: { code, name },
      sourceId: focusedNode.id,
      sourceName: focusedNode.name,
      sourceCode: focusedNode.code,
      targetId: industryGraphIdentity(code, name),
      direction,
      via: text(row.item, ''),
      share: number(row.share),
      relationType: industryRelation(row.type),
      note: text(row.note, ''),
    })
  }
  const relationLabel = '当前视角 · 上下游起点'
  const marketCap = text(profile.market_cap_display, '') || (() => {
    const value = number(profile.market_cap_cny ?? profile.market_cap)
    if (value === undefined) return '—'
    return value >= 100_000_000 ? `${(value / 100_000_000).toFixed(1)} 亿元` : `${value.toLocaleString('zh-CN')} 元`
  })()

  return (
    <div
      className={`${css.industryGraphViewport} ${compact ? css.industryGraphViewportCompact : ''}`}
      data-refreshing={loading ? '' : undefined}
    >
      <IndustryPhysicsGraph
        graph={viewGraph}
        activeNodeId={focusedNode.id}
        selectedNodeId={focusedNode.id}
        ariaLabel={compact ? '小窗可缩放、可拖动节点的产业链物理图谱' : '可缩放、可拖动节点的产业链物理图谱'}
        viewState={viewState}
        onSelect={onSelect}
        onDrill={drillNode}
        onReady={receiveControls}
      />
      <nav className={css.industryGraphBreadcrumbs} aria-label="产业链视角与已加载路径">
        <strong>当前视角</strong>
        <b className={css.industryGraphFocus}>{focusedNode.name}</b>
        <small className={css.industryGraphFocusHint}>上下游以此节点为起点</small>
        <em className={css.industryGraphTrailLabel}>已加载路径</em>
        {path.map((step, index) => (
          <span key={`${step.code}-${index}`}>
            {index > 0 && (
              <i data-direction={step.direction} aria-label={step.direction === 'up' ? '上钻' : '下钻'}>
                {step.direction === 'up' ? '← 上钻' : '下钻 →'}
              </i>
            )}
            <button
              type="button"
              aria-current={step.nodeId === focusedNode.id ? 'page' : undefined}
              title={step.via === undefined || step.via === '' ? undefined : `经由 ${step.via}`}
              onClick={() => { onNavigate(index) }}
            >{step.name || step.code}</button>
          </span>
        ))}
      </nav>
      <aside ref={navigator} className={css.industryGraphNavigator} aria-label="可钻取公司节点">
        <div className={css.industryGraphDetailHeader}>
          <span>{relationLabel}</span>
          <strong>{focusedNode.name}</strong>
          <small>{focusedNode.code || '非上市实体'} · {focusedNode.loaded ? '完整链路已载入' : '当前图谱节点'}</small>
        </div>
        <dl className={css.industryGraphDetailGrid}>
          <div><dt>传导环节</dt><dd>{selectedRelation.via || '未标注'}</dd></div>
          <div><dt>关系类型</dt><dd>{selectedRelation.relationType || '关系未标注'}</dd></div>
          <div><dt>关系权重</dt><dd>{selectedRelation.share === undefined ? '—' : `${selectedRelation.share.toFixed(1)}%`}</dd></div>
          <div><dt>关联边</dt><dd>{focusedNode.relations.length || viewGraph.edges.filter(edge => edge.source === focusedNode.id || edge.target === focusedNode.id).length || '—'}</dd></div>
        </dl>
        {selectedRelation.note !== '' && <p className={css.industryGraphDetailNote}>{selectedRelation.note}</p>}
        {entityRequested && entityState.phase === 'loading' && entityState.value === undefined && (
          <p className={css.industryGraphDetailStatus} role="status">正在补充实体档案…</p>
        )}
        {entityRequested && entityState.phase === 'error' && (
          <p className={css.industryGraphDetailStatus}>实体档案暂不可用，图谱关系仍可继续查看。</p>
        )}
        {Object.keys(profile).length > 0 && (
          <div className={css.industryGraphProfile}>
            <div><span>行业</span><strong>{text(profile.industry, '未标注')}</strong></div>
            <div><span>市值</span><strong>{marketCap}</strong></div>
            <div><span>供应 / 客户</span><strong>{industryCount(profile.supplier_count, '')} / {industryCount(profile.customer_count, '')}</strong></div>
            <div><span>全图出现</span><strong>{industryCount(profile.appearance_count, ' 次')}</strong></div>
          </div>
        )}
        {text(profile.desc, text(profile.note, '')) !== '' && <p className={css.industryGraphDetailNote}>{text(profile.desc, text(profile.note, ''))}</p>}
        {metrics.length > 0 && (
          <div className={css.industryGraphEvidence}>
            <strong>经营指标</strong>
            {metrics.slice(0, 4).map((metric, index) => (
              <span key={`${text(metric.label, '指标')}-${index}`}><small>{text(metric.label, '指标')}</small><b>{text(metric.value)}</b></span>
            ))}
          </div>
        )}
        {(reportMaterials.length > 0 || reportProducts.length > 0) && (
          <div className={css.industryGraphEvidence}>
            <strong>研报补充</strong>
            {[...reportMaterials, ...reportProducts].slice(0, 4).map((item, index) => (
              <span key={`${text(item.name, '业务')}-${index}`}><small>{index < reportMaterials.length ? '原材料' : '主营产品'}</small><b>{text(item.name, '未命名')}</b></span>
            ))}
          </div>
        )}
        <div className={css.industryGraphDetailActions}>
          {focusedNode.code !== '' && (
            <button
              type="button"
              className={css.primaryButton}
              onClick={() => { onSetCenter({ code: focusedNode.code, name: focusedNode.name }) }}
            >
              {focusedNode.id === loadedCenterId ? '刷新当前中心' : `将${focusedNode.name}设为中心`}
            </button>
          )}
          {/^[0-9]{6,8}$/u.test(focusedNode.code) && (
            <button type="button" className={css.secondaryButton} onClick={() => { onOpenStock(focusedNode.code) }}>查看个股</button>
          )}
        </div>
        {(asSupplier.length > 0 || asCustomer.length > 0 || related.length > 0) && (
          <section className={css.industryGraphRelated} aria-label="实体关联公司">
            <div><strong>实体关联公司</strong><span>{asSupplier.length + asCustomer.length + related.length}</span></div>
            {asSupplier.slice(0, 4).map((row, index) => (
              <button type="button" key={`supplier-${text(row.company_code, '')}-${index}`} onClick={() => { drillRelatedCompany(row, 'down') }}>
                <span><b>{text(row.company_name, text(row.company_code))}</b><small>下钻 · {text(row.item, '供应关系')} · {number(row.share)?.toFixed(1) ?? '—'}%</small></span><i>→</i>
              </button>
            ))}
            {asCustomer.slice(0, 4).map((row, index) => (
              <button type="button" key={`customer-${text(row.company_code, '')}-${index}`} onClick={() => { drillRelatedCompany(row, 'up') }}>
                <span><b>{text(row.company_name, text(row.company_code))}</b><small>上钻 · {text(row.item, '采购关系')} · {number(row.share)?.toFixed(1) ?? '—'}%</small></span><i>←</i>
              </button>
            ))}
            {related.slice(0, 3).map((row, index) => (
              <div key={`related-${text(row.code, text(row.name, ''))}-${index}`}>
                <span><b>{text(row.name, text(row.code))}</b><small>{text(row.relation, '研报关联')}</small></span>
              </div>
            ))}
          </section>
        )}
        <section className={css.industryGraphDirectory} aria-label="完整图谱节点目录">
          <div><strong>完整图谱</strong><span>{graph.nodes.length} 节点 · {graph.edges.length} 关系</span></div>
          {graphDirectory.map(node => (
            <button
              type="button"
              data-direction={node.direction}
              key={node.id}
              aria-label={`查看节点详情：${node.name}${node.code === '' ? '' : ` ${node.code}`}`}
              onClick={() => { onSelect(node) }}
              onDoubleClick={() => { drillNode(node) }}
            >
              <span><b>{node.name}</b><small>{node.direction === 'up' ? '上游' : node.direction === 'down' ? '下游' : '旁支'} · {node.direction === 'related' ? '关联分支' : `第 ${node.depth} 层`} · {node.via || '传导未标注'}</small></span>
              <span><b>{node.share === undefined ? '—' : `${node.share.toFixed(1)}%`}</b><small>{node.loaded ? '已展开' : node.code === '' ? '实体档案' : node.code}</small></span>
            </button>
          ))}
        </section>
      </aside>
      <div className={css.industryGraphControls} aria-label="图谱视图控制">
        <button type="button" aria-label="缩小图谱" onClick={() => { controls.current?.zoomOut() }}>−</button>
        <button type="button" onClick={() => { controls.current?.fit() }}>适应画布</button>
        <button type="button" aria-label="放大图谱" onClick={() => { controls.current?.zoomIn() }}>＋</button>
      </div>
      <div className={css.industryGraphLegend} aria-label="产业链图例">
        <span data-direction="up">上游 · 供给</span>
        <span data-direction="center">当前视角</span>
        <span data-direction="down">下游 · 需求</span>
        <span data-direction="related">推断关系 / 旁支</span>
        <small>方向：供应商 → 当前企业 → 客户；单击聚焦，双击继续展开。</small>
      </div>
      {loading && <div className={css.industryGraphLoading} role="status">正在合并新的完整上下游，已载入图谱保持可用…</div>}
      {leafNotice !== '' && (
        <div className={css.industryGraphNotice} role="status">
          <span>{leafNotice}</span>
          <button type="button" onClick={onDismissNotice} aria-label="关闭提示">×</button>
        </div>
      )}
    </div>
  )
}

/** Industry graph, company lookup and event transmission backed by two registered services. */
export function IndustryChainPage({ requestData, query, onQuery, onAnalyze, onOpenStock }: IndustryChainPageProps) {
  const dataStatus = useDataResource(requestData)
  const stats = useDataResource(requestData)
  const companies = useDataResource(requestData)
  const securityMatches = useDataResource(requestData)
  const chain = useDataResource(requestData)
  const entityDetail = useDataResource(requestData)
  const impact = useDataResource(requestData)
  const alive = useAliveRef()
  const bootstrapPoll = useRef<number>()
  const initialQuery = useRef(query.trim())
  const initialSearchPending = useRef(initialQuery.current !== '')
  const chainExpandButtonRef = useRef<HTMLButtonElement>(null)
  const chainCloseButtonRef = useRef<HTMLButtonElement>(null)
  const graphViewState = useRef<IndustryGraphViewState>({
    particles: new Map(), topologySignature: '', pan: { x: 0, y: 0 }, zoom: 1,
  })
  const [searchedKeyword, setSearchedKeyword] = useState('')
  const [searchAttempted, setSearchAttempted] = useState(false)
  const [searchValidation, setSearchValidation] = useState('')
  const [selectedCompany, setSelectedCompany] = useState<IndustryCompanySelection>()
  const [chainRoot, setChainRoot] = useState<IndustryCompanySelection>()
  const [chainPath, setChainPath] = useState<readonly IndustryChainPathStep[]>([])
  const [chainSnapshots, setChainSnapshots] = useState<Readonly<Record<string, IndustryChainSnapshot>>>({})
  const [chainConnections, setChainConnections] = useState<readonly IndustryGraphConnection[]>([])
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState('')
  const [entityRequestedKey, setEntityRequestedKey] = useState('')
  const [chainLeafNotice, setChainLeafNotice] = useState('')
  const [impactSecurityNames, setImpactSecurityNames] = useState<Record<string, string>>({})
  const [chainExpanded, setChainExpanded] = useState(false)
  const [chainDepth, setChainDepth] = useState<1 | 2 | 3>(3)
  const [pendingChainCenter, setPendingChainCenter] = useState<IndustryCompanySelection>()
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
  const loadChain = useCallback((company: IndustryCompanySelection, depth = chainDepth) => {
    setChainLeafNotice('')
    chain.run({
      operation: 'industry-chain.chain',
      input: { code: company.code, depth_up: depth, depth_down: depth, top_up: 5, top_down: 5 },
    })
  }, [chain.run, chainDepth])
  const inspectEntity = useCallback((nodeId: string, key: string) => {
    const cleanKey = key.trim()
    setSelectedGraphNodeId(nodeId)
    setEntityRequestedKey(cleanKey)
    if (cleanKey !== '') entityDetail.run({ operation: 'industry-chain.entity', input: { key: cleanKey } })
  }, [entityDetail.run])
  const startChainCompany = useCallback((company: IndustryCompanySelection) => {
    const nodeId = industryGraphIdentity(company.code, company.name)
    setPendingChainCenter(company)
    setSelectedCompany(current => current ?? company)
    inspectEntity(nodeId, company.code || company.name)
    loadChain(company)
  }, [inspectEntity, loadChain])
  const changeChainDepth = useCallback((depth: 1 | 2 | 3): void => {
    setChainDepth(depth)
    if (selectedCompany === undefined) return
    setPendingChainCenter(selectedCompany)
    loadChain(selectedCompany, depth)
  }, [loadChain, selectedCompany])
  const navigateChainPath = useCallback((index: number) => {
    const step = chainPath[index]
    if (step === undefined) return
    setSelectedCompany({ code: step.code, name: step.name })
    inspectEntity(step.nodeId, step.code || step.name)
    if (chainSnapshots[step.code] === undefined) loadChain(step)
  }, [chainPath, chainSnapshots, inspectEntity, loadChain])
  const drillChainNode = useCallback((request: IndustryGraphDrillRequest) => {
    const company = request.company
    if (company.code === '') {
      setChainLeafNotice(`${company.name} 当前没有可直接展开的公司代码，请从实体关联公司继续上下钻。`)
      return
    }
    if (request.sourceId !== request.targetId) {
      setChainConnections((current) => {
        const exists = current.some(item => (
          item.sourceId === request.sourceId
          && item.target.code === company.code
          && item.direction === request.direction
        ))
        return exists ? current : [...current, {
          sourceId: request.sourceId,
          sourceName: request.sourceName,
          sourceCode: request.sourceCode,
          target: company,
          direction: request.direction,
          via: request.via,
          share: request.share,
          relationType: request.relationType,
          note: request.note,
        }]
      })
    }
    setChainPath((current) => {
      const sourceIndex = current.findIndex(item => item.nodeId === request.sourceId)
      const activeIndex = current.findIndex(item => item.code === selectedCompany?.code)
      const baseIndex = sourceIndex >= 0 ? sourceIndex : activeIndex
      const base = baseIndex >= 0 ? current.slice(0, baseIndex + 1) : current
      const existing = base.findIndex(item => item.code === company.code)
      const step: IndustryChainPathStep = {
        ...company,
        nodeId: request.targetId,
        direction: request.direction,
        via: request.via,
        relationType: request.relationType,
        ...(request.share === undefined ? {} : { share: request.share }),
      }
      return existing >= 0 ? base.slice(0, existing + 1) : [...base, step]
    })
    setSelectedCompany(company)
    inspectEntity(request.targetId, company.code)
    loadChain(company)
  }, [inspectEntity, loadChain, selectedCompany?.code])
  const selectGraphNode = useCallback((node: IndustryGraphNodeData) => {
    inspectEntity(node.id, node.code || node.rawKey || node.name)
  }, [inspectEntity])

  useEffect(loadDataStatus, [loadDataStatus])
  useEffect(loadImpact, [loadImpact])
  useEffect(() => {
    if (chain.state.phase === 'error') {
      setPendingChainCenter(undefined)
      return
    }
    if (chain.state.phase !== 'success') return
    const value = asRecord(chain.state.value)
    const snapshotCenter = asRecord(value.center)
    const code = text(snapshotCenter.code, selectedCompany?.code ?? '').trim()
    if (code === '') return
    const snapshot: IndustryChainSnapshot = {
      center: snapshotCenter,
      upLevels: records(value.up_levels),
      downLevels: records(value.down_levels),
    }
    if (pendingChainCenter !== undefined && code === pendingChainCenter.code) {
      const nodeId = industryGraphIdentity(pendingChainCenter.code, pendingChainCenter.name)
      setChainRoot(pendingChainCenter)
      setSelectedCompany(pendingChainCenter)
      setChainPath([{ ...pendingChainCenter, nodeId }])
      setChainSnapshots({ [code]: snapshot })
      setChainConnections([])
      setSelectedGraphNodeId(nodeId)
      setPendingChainCenter(undefined)
      return
    }
    setChainSnapshots(current => ({ ...current, [code]: snapshot }))
  }, [chain.state.phase, chain.state.value, pendingChainCenter, selectedCompany?.code])

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
    .filter((item) => {
      const code = text(item.code, '').trim()
      return code !== '' && !companyCodes.has(code)
    })
  const chainValue = asRecord(chain.state.value)
  const responseCenter = asRecord(chainValue.center)
  const responseCode = text(responseCenter.code, '').trim()
  const responseSnapshot: IndustryChainSnapshot | undefined = responseCode === ''
    ? undefined
    : { center: responseCenter, upLevels: records(chainValue.up_levels), downLevels: records(chainValue.down_levels) }
  const activeSnapshot = selectedCompany === undefined
    ? undefined
    : chainSnapshots[selectedCompany.code]
      ?? (responseCode === selectedCompany.code ? responseSnapshot : undefined)
  const center = activeSnapshot?.center ?? {}
  const graphRoot = chainRoot ?? selectedCompany ?? { code: '', name: '未选择公司' }
  const graphSnapshots = useMemo(() => Object.values(chainSnapshots), [chainSnapshots])
  const completeIndustryGraph = useMemo(
    () => industryGraphData(graphRoot, graphSnapshots, chainConnections),
    [chainConnections, graphRoot.code, graphRoot.name, graphSnapshots],
  )
  const rootGraphNodeId = industryGraphIdentity(graphRoot.code, graphRoot.name)
  const selectedGraphNode = completeIndustryGraph.nodes.find(node => node.id === selectedGraphNodeId)
    ?? completeIndustryGraph.nodes.find(node => node.id === rootGraphNodeId)
    ?? completeIndustryGraph.nodes[0]
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

  const expandedChainDialog = chainExpanded && selectedCompany !== undefined && selectedGraphNode !== undefined && (
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
            <span>完整产业链图谱</span>
            <h2 id="industry-graph-dialog-title">
              {selectedGraphNode.name || '未命名节点'} · {selectedGraphNode.code || '实体视角'}
            </h2>
            <p id="industry-graph-dialog-hint">
              当前以“{selectedGraphNode.name}”为上下游起点；已载入 {completeIndustryGraph.nodes.length} 个节点、
              {completeIndustryGraph.edges.length} 条关系，钻取后继续合并。
            </p>
          </div>
          <div className={css.moduleToolbar}>
            <button ref={chainCloseButtonRef} type="button" className={css.secondaryButton} onClick={closeExpandedChain}>关闭</button>
          </div>
        </header>
        <IndustryGraphExplorer
          graph={completeIndustryGraph}
          path={chainPath}
          activeCompany={selectedCompany}
          selectedNode={selectedGraphNode}
          entityState={entityDetail.state}
          entityRequested={entityRequestedKey !== ''}
          loading={chain.state.phase === 'loading'}
          compact={false}
          leafNotice={chainLeafNotice}
          viewState={graphViewState}
          onNavigate={navigateChainPath}
          onSelect={selectGraphNode}
          onDrill={drillChainNode}
          onSetCenter={startChainCompany}
          onOpenStock={onOpenStock}
          onDismissNotice={() => { setChainLeafNotice('') }}
        />
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
                        startChainCompany(selection)
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
              <div>
                <h2 id="industry-chain-title">完整上下游图谱</h2>
                <small>默认读取上下游各 3 层；聚焦节点不会重新请求，设为中心才重新加载图谱</small>
                {selectedCompany !== undefined && <strong>中心企业：{selectedCompany.name || selectedCompany.code}</strong>}
              </div>
              {selectedCompany !== undefined && (
                <div className={css.industryChainActions}>
                  <div className={css.segmented} role="group" aria-label="产业链展示层级">
                    {([1, 2, 3] as const).map(depth => (
                      <button
                        type="button"
                        key={depth}
                        aria-label={`显示 ${depth} 层上下游`}
                        aria-pressed={chainDepth === depth}
                        className={chainDepth === depth ? css.segmentActive : undefined}
                        onClick={() => { changeChainDepth(depth) }}
                      >{depth} 层</button>
                    ))}
                  </div>
                  <span>{completeIndustryGraph.nodes.length} 节点 · {completeIndustryGraph.edges.length} 关系</span>
                  {selectedGraphNode !== undefined && (
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
            {selectedCompany !== undefined && selectedGraphNode !== undefined && !chainExpanded && (
              <IndustryGraphExplorer
                graph={completeIndustryGraph}
                path={chainPath}
                activeCompany={selectedCompany}
                selectedNode={selectedGraphNode}
                entityState={entityDetail.state}
                entityRequested={entityRequestedKey !== ''}
                loading={chain.state.phase === 'loading'}
                compact
                leafNotice={chainLeafNotice}
                viewState={graphViewState}
                onNavigate={navigateChainPath}
                onSelect={selectGraphNode}
                onDrill={drillChainNode}
                onSetCenter={startChainCompany}
                onOpenStock={onOpenStock}
                onDismissNotice={() => { setChainLeafNotice('') }}
              />
            )}
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
