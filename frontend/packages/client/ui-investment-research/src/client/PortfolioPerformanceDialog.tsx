import { useId, useState } from 'react'
import { HelpPopover, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import { asRecord, compactMoney, money, number, productErrorText, records, text } from './data.ts'
import { PortfolioPerformanceChart } from './PortfolioPerformanceChart.tsx'
import { privateFunds, useFundsPrivacy } from './funds-privacy.tsx'
import type { WorkbenchPositionDetail } from './WorkbenchOverviewDialog.tsx'
import css from './InvestmentShell.module.css'

export type PerformancePeriod = 'since_inception' | '7d' | '15d' | '30d' | '6m' | '1y' | 'custom'
export type PerformanceMethod = 'twr' | 'xirr' | 'cost'

export interface PortfolioPerformanceContentProps {
  readonly value: unknown
  readonly loaded: boolean
  readonly busy: boolean
  readonly error: string
  readonly positions: readonly WorkbenchPositionDetail[]
  readonly period: PerformancePeriod
  readonly method: PerformanceMethod
  readonly customStart: string
  readonly customEnd: string
  readonly customError: string
  readonly onPeriodChange: (period: PerformancePeriod) => void
  readonly onMethodChange: (method: PerformanceMethod) => void
  readonly onCustomStartChange: (value: string) => void
  readonly onCustomEndChange: (value: string) => void
  readonly onApplyCustom: () => void
  readonly onHistoryStartSave: (effectiveDate: string | null) => Promise<void>
  readonly onRetry: () => void
}

const PERIODS: readonly { value: PerformancePeriod; label: string }[] = [
  { value: 'since_inception', label: '持仓以来' },
  { value: '7d', label: '7日' },
  { value: '15d', label: '15日' },
  { value: '30d', label: '30日' },
  { value: '6m', label: '半年' },
  { value: '1y', label: '一年' },
]

const METHODS: readonly { value: PerformanceMethod; label: string; help: string }[] = [
  { value: 'twr', label: '时间加权收益率（TWR）', help: '剔除增减持资金流影响，适合衡量组合本身的投资表现。' },
  { value: 'xirr', label: '金额加权收益率（XIRR，估算）', help: '考虑资金进入时点并年化，适合观察个人资金的实际使用效率。' },
  { value: 'cost', label: '成本收益率', help: '当前盈亏 ÷ 当前持仓成本，直观但不适合跨期比较。' },
]

export function signedPercent(value: number | undefined): string {
  if (value === undefined) return '—'
  const normalized = Object.is(value, -0) ? 0 : value
  return `${normalized > 0 ? '+' : ''}${(normalized * 100).toFixed(2)}%`
}

function signedMoney(value: number | undefined): string {
  if (value === undefined) return '—'
  const normalized = Object.is(value, -0) ? 0 : value
  if (normalized === 0) return compactMoney(0)
  const absolute = Math.abs(normalized)
  const formatted = absolute < 1_000 ? money(absolute) : compactMoney(absolute)
  return `${normalized > 0 ? '+' : '-'}${formatted}`
}

export function tone(value: number | undefined): 'positive' | 'negative' | undefined {
  if (value === undefined || value === 0) return undefined
  return value > 0 ? 'positive' : 'negative'
}

function qualityLabel(value: unknown): string {
  const quality = text(value, '')
  if (quality === 'complete' || quality === 'exact') return '完整'
  if (quality === 'partial') return '部分数据'
  if (quality === 'estimated') return '估算'
  if (quality === 'unavailable') return '不可用'
  return '待确认'
}

function resolvedReturn(value: Record<string, unknown>, method: PerformanceMethod): number | undefined {
  const summary = asRecord(value.summary)
  const returns = asRecord(value.returns)
  if (method === 'cost') return number(summary.cost_return)
  return number(asRecord(returns[method]).value)
}

function unavailableMessage(method: PerformanceMethod, selectedReturn: number | undefined): string {
  if (selectedReturn !== undefined) return ''
  if (method === 'twr') return '当前区间至少需要两个估值日，无法计算时间加权收益率。'
  if (method === 'xirr') return '当前区间缺少可用的资金流时点，无法计算金额加权收益率。'
  return '当前持仓成本或行情不完整，无法计算成本收益率。'
}

function liveCostSummary(positions: readonly WorkbenchPositionDetail[]): {
  cost: number
  value: number
  profitLoss: number
  costReturn: number
} | undefined {
  if (positions.length === 0) return undefined
  let cost = 0
  let value = 0
  for (const position of positions) {
    if (position.quantity === undefined || position.costPrice === undefined || position.currentPrice === undefined) return undefined
    cost += position.quantity * position.costPrice
    value += position.quantity * position.currentPrice
  }
  if (cost <= 0) return undefined
  const profitLoss = value - cost
  return { cost, value, profitLoss, costReturn: profitLoss / cost }
}

/** Portfolio performance details keep range selection and return methodology explicit. */
export function PortfolioPerformanceContent({
  value: rawValue, loaded, busy, error, positions, period, method,
  customStart, customEnd, customError, onPeriodChange, onMethodChange,
  onCustomStartChange, onCustomEndChange, onApplyCustom, onHistoryStartSave, onRetry,
}: PortfolioPerformanceContentProps) {
  const { hidden: fundsHidden } = useFundsPrivacy()
  const customDatesId = useId()
  const [historyEditorOpen, setHistoryEditorOpen] = useState(false)
  const [historyDraft, setHistoryDraft] = useState('')
  const [historySaving, setHistorySaving] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const value = asRecord(rawValue)
  const summary = asRecord(value.summary)
  const series = records(value.series)
  const contributions = records(value.contributions)
  const isCostMethod = method === 'cost'
  const liveCost = liveCostSummary(positions)
  const selectedReturn = isCostMethod ? liveCost?.costReturn : resolvedReturn(value, method)
  const profitLoss = number(summary.profit_loss)
  const openingValue = number(summary.start_value)
  const endingValue = number(summary.end_value)
  const nameByCode = new Map(positions.map(item => [item.code, item.name]))
  const chartPointCount = series.reduce((count, item) => number(item.value) === undefined ? count : count + 1, 0)
  const availableSince = text(value.available_since, '')
  const historyStartOrigin = text(value.history_start_origin, 'system_record')
  const historyStartOriginal = text(value.history_start_original, '')
  const selectedMethod = METHODS.find(item => item.value === method) ?? METHODS[0]!
  const methodNotice = unavailableMessage(method, selectedReturn)
  const hasIntervalContributions = !isCostMethod && contributions.some(item => number(item.profit_loss) !== undefined)
  const errorMessage = error === '数据服务暂不可用，请稍后重试。'
    ? '历史行情暂不可用，请稍后重试。'
    : productErrorText(error, '历史行情暂不可用，请稍后重试。')

  const saveHistoryStart = async (effectiveDate: string | null): Promise<void> => {
    if (historySaving) return
    if (effectiveDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      setHistoryError('请选择有效的首次持仓日期。')
      return
    }
    setHistorySaving(true)
    setHistoryError('')
    try {
      await onHistoryStartSave(effectiveDate)
      setHistoryEditorOpen(false)
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistorySaving(false)
    }
  }

  return (
    <section className={css.workbenchOverviewSection} aria-label="历史收益与贡献">
      <div className={css.performanceSectionHead}><div><h3>历史收益与贡献</h3><p>按时间区间和收益口径核对组合表现；总资产与收益均不含现金。</p></div></div>
      <div className={css.performanceControls}>
        <div className={css.performancePeriods} role="group" aria-label="收益时间区间">
          <Select className={css.performanceSelect} aria-label="预设时间区间" value={period} displayLabel={period === 'custom' ? '自定义时间段' : undefined} options={PERIODS} disabled={busy && !loaded} onValueChange={onPeriodChange} />
          <button type="button" aria-pressed={period === 'custom'} aria-expanded={period === 'custom'} aria-controls={customDatesId} disabled={busy && !loaded} onClick={() => { onPeriodChange('custom') }}>自定义时间段</button>
        </div>
        {period === 'custom' && (
          <div id={customDatesId} className={css.performanceCustomDates}>
            <label>开始日期<input type="date" value={customStart} onChange={event => { onCustomStartChange(event.currentTarget.value) }} /></label>
            <label>结束日期<input type="date" value={customEnd} onChange={event => { onCustomEndChange(event.currentTarget.value) }} /></label>
            <button type="button" className={css.secondaryButton} disabled={busy} onClick={onApplyCustom}>应用日期</button>
          </div>
        )}
        {customError !== '' && <div className={css.performanceInlineError} role="alert">{customError}</div>}
        <fieldset className={css.performanceMethods}>
          <legend>收益口径</legend>
          {METHODS.map(item => (
            <div key={item.value} className={css.performanceMethodOption}>
            <label>
              <input
                type="radio"
                name="portfolio-performance-method"
                value={item.value}
                aria-label={item.label}
                checked={method === item.value}
                onChange={() => { onMethodChange(item.value) }}
              />
              <strong>{item.value === 'twr' ? 'TWR 收益率' : item.value === 'xirr' ? 'XIRR（估算）' : item.label}</strong>
            </label>
            <MethodHelp label={item.label} explanation={item.help} />
            </div>
          ))}
        </fieldset>
        <div className={css.performanceMethodCompact}>
          <div className={css.performanceMethodCompactField}><span>收益口径</span><Select className={css.performanceSelect} aria-label="收益口径" value={method} options={METHODS} onValueChange={onMethodChange} /></div>
          <MethodHelp label={selectedMethod.label} explanation={selectedMethod.help} accessibleLabel="当前收益口径说明" />
        </div>
      </div>

      <div className={css.performanceContent} role="region" aria-label="组合收益内容">
      {error !== '' && (
        <div className={css.performanceError} role="alert" data-retained={loaded || undefined}>
          <div><strong>组合收益暂不可用</strong><p>{errorMessage}</p></div>
          <button type="button" onClick={onRetry}>重试</button>
        </div>
      )}
      {!loaded && error === '' && <div className={css.detailLoadState} role="status">正在加载组合收益…</div>}
      {loaded && value.quality === 'unavailable' && (
        <div className={css.workbenchOverviewEmpty}>暂无可计算的组合收益。请先保存持仓，后续变更将用于建立可追溯的收益记录。</div>
      )}
      {loaded && value.quality !== 'unavailable' && (
        <>
          {methodNotice !== '' && <p className={css.performanceNotice} role="status">{methodNotice}</p>}
          <dl className={css.performanceMetricGrid}>
            <div><dt>{selectedMethod.label}</dt><dd data-tone={tone(selectedReturn)}>{signedPercent(selectedReturn)}</dd></div>
            {!isCostMethod && <>
              <div><dt>区间盈亏</dt><dd data-tone={tone(profitLoss)}>{privateFunds(signedMoney(profitLoss), fundsHidden)}</dd></div>
              <div><dt>期初总资产</dt><dd>{privateFunds(openingValue === undefined ? '—' : compactMoney(openingValue), fundsHidden)}</dd></div>
              <div><dt>期末总资产</dt><dd>{privateFunds(endingValue === undefined ? '—' : compactMoney(endingValue), fundsHidden)}</dd></div>
            </>}
          </dl>
          {isCostMethod && <p className={css.performanceHistoryNote}>当前成本、市值与盈亏见上方持仓汇总；以下保留历史曲线与标的贡献。</p>}
          <div className={css.performanceHistoryBlock}>
            <p className={css.performanceHistoryNote}>
              <span>
                {availableSince === '' ? '历史记录起点未知' : `历史记录始于 ${availableSince}`}
                {historyStartOrigin === 'user_corrected' && <b>人工校正</b>}
              </span>
              <span>{text(value.start_date, '—')} 至 {text(value.end_date, '—')}</span>
            </p>
            <div className={css.performanceHistoryActions}>
              <small>{historyStartOrigin === 'user_corrected'
                ? `系统原始记录 ${historyStartOriginal || '未知'}；更早区间按首份持仓估算。`
                : '日期会随投研备份迁移；校正不会改写原始快照。'}</small>
              <button
                type="button"
                className={css.secondaryButton}
                disabled={historySaving}
                onClick={() => {
                  setHistoryDraft(availableSince)
                  setHistoryError('')
                  setHistoryEditorOpen(open => !open)
                }}
              >校正历史起点</button>
            </div>
            {historyEditorOpen && (
              <form className={css.performanceHistoryEditor} onSubmit={(event) => {
                event.preventDefault()
                void saveHistoryStart(historyDraft)
              }}>
                <label>首次持仓日期<input type="date" value={historyDraft} disabled={historySaving} onChange={event => { setHistoryDraft(event.currentTarget.value); setHistoryError('') }} /></label>
                <div>
                  {historyStartOrigin === 'user_corrected' && <button type="button" className={css.secondaryButton} disabled={historySaving} onClick={() => { void saveHistoryStart(null) }}>恢复系统记录</button>}
                  <button type="button" className={css.secondaryButton} disabled={historySaving} onClick={() => { setHistoryEditorOpen(false); setHistoryError('') }}>取消</button>
                  <button type="submit" className={css.primaryButton} disabled={historySaving || historyDraft === ''}>{historySaving ? '正在保存…' : '保存校正'}</button>
                </div>
                <p>若选择早于首份系统快照的日期，该区间会按首份持仓结构估算。</p>
                {historyError !== '' && <strong role="alert">{historyError}</strong>}
              </form>
            )}
          </div>

          <section className={css.performanceSection} aria-labelledby="portfolio-performance-chart-title">
            <div className={css.performanceSectionHead}>
              <div><h3 id="portfolio-performance-chart-title">组合收益曲线</h3><p>按估值日展示不含现金的持仓总市值。</p></div>
              {busy && <span role="status">更新中…</span>}
            </div>
            {chartPointCount < 2 ? (
              <div className={css.performanceChartEmpty}>当前区间的有效估值点不足，暂不能绘制曲线。</div>
            ) : (
              <PortfolioPerformanceChart
                series={series}
                fundsHidden={fundsHidden}
                ariaLabel={`组合收益曲线，${text(value.start_date, '起始日未知')}至${text(value.end_date, '结束日未知')}${fundsHidden ? '' : `，区间盈亏${signedMoney(profitLoss)}`}`}
              />
            )}
            {series.length > 0 && (
              <details className={css.performanceValuationDetails}>
                <summary>查看估值明细（{series.length} 个估值日）</summary>
                <div>
                  <table>
                    <thead><tr><th>日期</th><th>总资产</th><th>累计盈亏</th></tr></thead>
                    <tbody>{series.map((item, index) => (
                      <tr key={`${text(item.date, '')}-${index}`}>
                        <th scope="row">{text(item.date, '—')}</th>
                        <td>{privateFunds(number(item.value) === undefined ? '—' : compactMoney(number(item.value) ?? 0), fundsHidden)}</td>
                        <td data-tone={tone(number(item.profit_loss))}>{privateFunds(signedMoney(number(item.profit_loss)), fundsHidden)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </details>
            )}
          </section>

          {hasIntervalContributions && <details className={css.performanceValuationDetails}>
            <summary>查看区间盈亏贡献（{contributions.length} 项）</summary>
          <section className={css.performanceSection} aria-labelledby="portfolio-contributions-title">
            <div className={css.performanceSectionHead}>
              <div><h3 id="portfolio-contributions-title">标的区间盈亏贡献</h3><p>所选区间的历史数据，包含区间内已卖出的标的；不等同于当前持仓。</p></div>
            </div>
              <div className={css.performanceContributionTable}>
                <table aria-label="标的区间盈亏贡献明细">
                  <thead><tr><th>标的</th><th>期末成本价</th><th>期末价</th><th>较成本</th><th>区间盈亏</th></tr></thead>
                  <tbody>{contributions.map((item, index) => {
                    const ticker = text(item.ticker, '')
                    const costPrice = number(item.cost_price)
                    const currentPrice = number(item.end_price)
                    const priceReturn = number(item.price_return)
                    const contribution = number(item.profit_loss)
                    return (
                      <tr key={`${ticker}-${index}`}>
                        <th scope="row"><strong>{nameByCode.get(ticker) ?? (ticker || '未知标的')}</strong><small>{ticker || '—'}</small></th>
                        <td>{privateFunds(costPrice === undefined ? '—' : money(costPrice), fundsHidden)}</td>
                        <td>{currentPrice === undefined ? '—' : money(currentPrice)}</td>
                        <td data-tone={tone(priceReturn)}>{signedPercent(priceReturn)}</td>
                        <td data-tone={tone(contribution)}>{privateFunds(signedMoney(contribution), fundsHidden)}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
          </section>
          </details>}
        </>
      )}
      </div>
    </section>
  )
}

function MethodHelp({ label, explanation, accessibleLabel }: { label: string; explanation: string; accessibleLabel?: string }) {
  return <HelpPopover label={accessibleLabel ?? `${label}说明`} className={css.performanceMethodHelp}>{explanation}</HelpPopover>
}

export function PortfolioPerformanceNotes({ value: rawValue, loaded, method }: Pick<PortfolioPerformanceContentProps, 'value' | 'loaded' | 'method'>) {
  const { hidden: fundsHidden } = useFundsPrivacy()
  const value = asRecord(rawValue)
  const summary = asRecord(value.summary)
  const selectedMethod = METHODS.find(item => item.value === method) ?? METHODS[0]!
  const limitations = Array.isArray(value.limitations)
    ? value.limitations.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  if (!loaded || value.quality === 'unavailable') return null
  return <section className={`${css.performanceSection} ${css.performanceNotes}`} aria-labelledby="portfolio-method-note-title">
            <div className={css.performanceSectionHead}><div><h3 id="portfolio-method-note-title">口径与数据质量</h3><p>{selectedMethod.help}</p></div></div>
            <dl className={css.performanceQualityFacts}>
              <div><dt>数据质量</dt><dd>{qualityLabel(value.quality)}</dd></div>
              <div><dt>行情覆盖</dt><dd>{number(value.coverage_ratio) === undefined ? '—' : `${((number(value.coverage_ratio) ?? 0) * 100).toFixed(0)}%`}</dd></div>
              <div><dt>净流入估算</dt><dd>{privateFunds(signedMoney(number(summary.net_flow)), fundsHidden)}</dd></div>
            </dl>
            {limitations.length > 0 && <ul className={css.performanceLimitations}>{limitations.map(item => <li key={item}>{item}</li>)}</ul>}
          </section>
}
