import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { asRecord, records, text } from './data.ts'
import css from './InvestmentShell.module.css'

interface DetailDialogProps {
  readonly title: string
  readonly description?: string
  readonly eyebrow?: string
  readonly onClose: () => void
  readonly children: ReactNode
  readonly actions?: ReactNode
  readonly wide?: boolean
  readonly closeDisabled?: boolean
}

/** Shared, keyboard-safe modal shell for product details and evidence. */
export function DetailDialog({
  title, description, eyebrow, onClose, children, actions, wide = false, closeDisabled = false,
}: DetailDialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const closeDisabledRef = useRef(closeDisabled)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => { closeDisabledRef.current = closeDisabled }, [closeDisabled])
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!closeDisabledRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable === undefined || focusable.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (dialogRef.current?.contains(document.activeElement) !== true) {
        event.preventDefault()
        if (event.shiftKey) last?.focus(); else first?.focus()
      } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      window.requestAnimationFrame(() => { previousFocus?.focus() })
    }
  }, [])

  const dialog = (
    <div
      className={css.detailBackdrop}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose() }}
    >
      <section
        ref={dialogRef}
        className={`${css.detailDialog} ${wide ? css.detailDialogWide : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className={css.detailDialogHeader}>
          <div>
            {eyebrow !== undefined && <span>{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
            {description !== undefined && <p>{description}</p>}
          </div>
          <button ref={closeRef} type="button" aria-label={`关闭${title}`} disabled={closeDisabled} onClick={onClose}>×</button>
        </header>
        <div className={css.detailDialogBody}>{children}</div>
        {actions !== undefined && <footer className={css.detailDialogActions}>{actions}</footer>}
      </section>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap(item => typeof item === 'string' && item.trim() !== '' ? [item.trim()] : [])
    : []
}

function scalar(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
  return typeof value === 'string' && value.trim() !== '' ? value : '—'
}

export function riskSource(source: string): { label: string; explanation: string } {
  const map: Record<string, { label: string; explanation: string }> = {
    portfolio: { label: '组合风险引擎', explanation: '依据当前已保存持仓及组合风险预算计算。' },
    profile: { label: '投资画像预算', explanation: '依据当前投资画像对应的波动、集中度等预算口径生成。' },
    strategy: { label: '策略验证引擎', explanation: '依据策略回测或影子验证的生命周期证据生成。' },
    shadow: { label: '影子验证账户', explanation: '依据纸面账户的持仓、净值与运行结果生成，不涉及真实交易。' },
    event: { label: '关联事件引擎', explanation: '依据事件与持仓、自选或生效策略的关联关系生成。' },
  }
  return map[source] ?? { label: source === '' ? '风险预警服务' : source, explanation: '由后端风险预警服务返回，页面未补造指标。' }
}

export function riskSuggestions(item: Record<string, unknown>): string[] {
  const severity = text(item.severity, '低')
  const source = text(item.source, '')
  const codes = strings(item.codes)
  const result: string[] = []
  if (severity === '高') result.push('优先核对风险暴露与数据时点，确认是否需要立即降低集中度或暂停新增暴露。')
  else if (severity === '中') result.push('列入当日复核清单，结合最新行情与基本面确认风险是否持续。')
  else result.push('保持观察，在风险指标或关联事件变化后重新评估。')
  if (source === 'profile') result.push('确认当前投资画像与风险预算是否仍符合你的真实目标；画像不匹配时先调整预算口径。')
  if (source === 'strategy' || source === 'shadow') result.push('回看策略假设、样本外证据和影子验证结果，避免只依据单次信号决策。')
  if (codes.length > 0) result.push(`逐一复核关联标的 ${codes.join('、')} 的仓位、流动性和最新事件。`)
  return result
}

function riskImpacts(item: Record<string, unknown>): string[] {
  const source = text(item.source, '')
  const codes = strings(item.codes)
  const strategyId = text(item.strategy_id, '')
  const result: string[] = []
  if (codes.length > 0) result.push(`关联范围包含 ${codes.join('、')}；应结合实际仓位判断对组合的贡献度。`)
  if (strategyId !== '') result.push(`关联策略 ${strategyId} 的验证结论或生命周期动作需要复核。`)
  if (source === 'portfolio' || source === 'profile') result.push('该预警会影响当前组合风险预算判断，但页面不会据此自动调整持仓。')
  if (source === 'event') result.push('事件数据可能影响相关标的与策略判断，需结合事件时点和来源继续核验。')
  return result.length === 0 ? ['后端未返回明确影响对象，当前仅作为风险复核提醒。'] : result
}

export function RiskDetailDialog({
  item, onClose, onAnalyze,
}: { item: Record<string, unknown>; onClose: () => void; onAnalyze?: () => void }) {
  const severity = text(item.severity, '低')
  const title = text(item.title, text(item.label, '风险提醒'))
  const detail = text(item.detail, '')
  const source = riskSource(text(item.source, ''))
  const codes = strings(item.codes)
  const strategyId = text(item.strategy_id, '')
  const indicator = text(item.indicator, '')
  const suggestions = riskSuggestions(item)
  const impacts = riskImpacts(item)
  const degraded = item.degraded === true
  const tags = [severity === '' ? '' : `${severity}风险`, source.label, degraded ? '部分数据降级' : '', ...codes, strategyId]
    .filter(value => value !== '')

  return (
    <DetailDialog
      title={title}
      description="查看触发原因、风险口径与可执行的复核建议"
      eyebrow="风险详情"
      onClose={onClose}
      actions={<>
        <button type="button" className={css.secondaryButton} onClick={onClose}>关闭</button>
        {onAnalyze !== undefined && <button type="button" className={css.primaryButton} onClick={onAnalyze}>带入智能分析</button>}
      </>}
    >
      <div data-testid="risk-detail-dialog" className={css.detailTags} aria-label="风险标签">
        {tags.map((tag, index) => <span key={`${tag}-${index}`} data-severity={index === 0 ? severity : undefined}>{tag}</span>)}
      </div>
      <dl className={css.detailMetaGrid}>
        <div><dt>严重度</dt><dd>{severity}</dd></div>
        <div><dt>数据时间</dt><dd>{text(item.ts, text(item.as_of, '—'))}</dd></div>
        <div><dt>风险来源</dt><dd>{source.label}</dd></div>
        <div><dt>关联策略</dt><dd>{strategyId || '—'}</dd></div>
      </dl>
      {degraded && (
        <div className={css.dashboardDegraded} role="status">
          {text(item.degraded_reason, '部分关联数据暂未更新；当前详情仍展示已成功返回的组合或画像事实，请注意数据时点。')}
        </div>
      )}
      <section className={css.detailSection} data-field="risk-reason">
        <h3>触发原因</h3>
        <p>{detail || (indicator === '' ? '后端未返回进一步原因，请结合数据来源与指标复核。' : `指标 ${indicator} 触发风险预算检查。`)}</p>
        <div className={css.detailEvidenceRow}>
          <span>当前值 <strong>{scalar(item.value)}</strong></span>
          <span>预算上限 <strong>{scalar(item.limit)}</strong></span>
        </div>
        {(item.value === undefined || item.limit === undefined) && <p className={css.detailFootnote}>缺失值显示为“—”；这表示数据不足，不代表未触发风险。</p>}
      </section>
      <section className={css.detailSection} data-field="risk-impact">
        <h3>影响范围</h3>
        <ul className={css.detailList}>{impacts.map(impact => <li key={impact}>{impact}</li>)}</ul>
      </section>
      <section className={css.detailSection} data-field="risk-detail">
        <h3>数据来源与口径</h3>
        <p><strong>{source.label}</strong>：{source.explanation}</p>
        <p className={css.detailFootnote}>页面仅展示后端已返回的事实字段；建议为研究流程提示，不是收益承诺或交易指令。</p>
      </section>
      <section className={css.detailSection} data-field="risk-advice">
        <h3>建议动作</h3>
        <ol className={css.detailList}>{suggestions.map(suggestion => <li key={suggestion}>{suggestion}</li>)}</ol>
      </section>
    </DetailDialog>
  )
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

function markdownLine(value: unknown, fallback = '—'): string {
  return text(value, fallback).replaceAll('\n', ' ').replaceAll('|', '\\|')
}

export function eventReportMarkdown(item: Record<string, unknown>): string {
  const risk = asRecord(item.risk)
  const matched = asRecord(item.matched)
  const tickers = tickerLabels(item.tickers)
  const reasons = strings(item.reasons)
  const strategies = records(matched.strategies).map((strategy) => {
    const id = text(strategy.id, '')
    const name = text(strategy.name, id)
    return id !== '' && name !== id ? `${name}（${id}）` : name
  }).filter(value => value !== '')
  const reasonLines = reasons.length > 0 ? reasons.map(reason => `- ${reason}`).join('\n') : '- 后端未返回进一步关联原因'
  const tickerLines = tickers.length > 0 ? tickers.map(ticker => `- ${ticker}`).join('\n') : '- 暂无明确关联标的'
  const strategyLines = strategies.length > 0 ? strategies.map(strategy => `- ${strategy}`).join('\n') : '- 暂无匹配策略'
  return [
    `# ${markdownLine(item.title, '事件研究详情')}`,
    '',
    `> ${markdownLine(item.summary, '暂无事件摘要')}`,
    '',
    '## 快速结论',
    '',
    `- 关联范围：${markdownLine(item.bucket, '事件')}`,
    `- 事件方向：${markdownLine(item.direction)}`,
    `- 风险等级：${markdownLine(risk.level)}`,
    `- 风险说明：${markdownLine(risk.note, '后端未返回额外风险说明')}`,
    '',
    '## 关联原因',
    '',
    reasonLines,
    '',
    '## 关联标的',
    '',
    tickerLines,
    '',
    '## 匹配策略',
    '',
    strategyLines,
    '',
    '## 数据来源',
    '',
    `- 来源：${markdownLine(item.source, '来源未知')}`,
    `- 事件时间：${markdownLine(item.time)}`,
    `- 事件标识：${markdownLine(item.event_id, markdownLine(item.source_event_id, '暂未返回稳定事件标识'))}`,
    `- 卡片标识：${markdownLine(item.card_id)}`,
    '',
    '> 本文档由系统将真实事件卡字段整理为 Markdown 投研摘要；未返回的字段不会由页面补造，内容不构成投资建议。',
  ].join('\n')
}

export function EventReportDialog({
  item, requestData, onClose, onAnalyze,
}: {
  item: Record<string, unknown>
  requestData: (request: InvestmentDataRequest) => Promise<unknown>
  onClose: () => void
  onAnalyze?: () => void
}) {
  const risk = asRecord(item.risk)
  const reportId = text(item.report_id, '')
  const persistent = reportId !== ''
  const [reloadVersion, setReloadVersion] = useState(0)
  const [reportState, setReportState] = useState<{
    phase: 'idle' | 'loading' | 'success' | 'error'
    title: string
    markdown: string
    error: string
  }>({ phase: 'idle', title: '', markdown: '', error: '' })
  useEffect(() => {
    if (!persistent) {
      setReportState({ phase: 'idle', title: '', markdown: '', error: '' })
      return
    }
    let active = true
    setReportState({ phase: 'loading', title: '', markdown: '', error: '' })
    void requestData({ operation: 'trading-core.report', input: { report_id: reportId } })
      .then((value) => {
        if (!active) return
        const report = asRecord(value)
        const sections = records(report.sections)
          .map(section => ({ title: text(section.title, text(section.key, '报告正文')), content: text(section.content, '') }))
          .filter(section => section.content !== '')
        if (sections.length === 0) throw new Error('持久报告未返回可展示正文')
        const title = text(report.title, text(item.title, '事件投研报告'))
        const markdown = [`# ${title}`, '', ...sections.flatMap(section => [`## ${section.title}`, '', section.content, ''])].join('\n')
        setReportState({ phase: 'success', title, markdown, error: '' })
      })
      .catch((reason: unknown) => {
        if (!active) return
        setReportState({
          phase: 'error', title: '', markdown: '',
          error: reason instanceof Error && reason.message !== '' ? reason.message : '持久报告读取失败，请稍后重试。',
        })
      })
    return () => { active = false }
  }, [item, persistent, reloadVersion, reportId, requestData])
  const tags = [
    text(item.direction, ''),
    text(risk.level, '') === '' ? '' : `${text(risk.level)}风险`,
    text(item.source, ''),
    ...tickerLabels(item.tickers),
  ].filter(value => value !== '')
  return (
    <DetailDialog
      title={reportState.title || text(item.title, persistent ? '事件投研报告' : '事件研究详情')}
      description={persistent ? `持久投研报告 · ${reportId}` : '由事件原始字段即时整理的 Markdown 研究文档'}
      eyebrow={persistent ? '投研报告' : '事件研究详情'}
      wide
      onClose={onClose}
      actions={<>
        <button type="button" className={css.secondaryButton} onClick={onClose}>关闭</button>
        {onAnalyze !== undefined && <button type="button" className={css.primaryButton} onClick={onAnalyze}>带入智能分析</button>}
      </>}
    >
      <div data-testid="markdown-report" className={css.detailTags} aria-label="事件标签">
        {tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}
      </div>
      {!persistent && <div data-testid="markdown-body" className={css.eventMarkdown}><MarkdownText text={eventReportMarkdown(item)} /></div>}
      {persistent && reportState.phase === 'loading' && <div className={css.detailLoadState} role="status">正在读取持久投研报告…</div>}
      {persistent && reportState.phase === 'error' && (
        <div className={css.confirmPanel} role="alert">
          <strong>持久投研报告暂不可用</strong>
          <p>{reportState.error}</p>
          <button type="button" className={css.secondaryButton} onClick={() => { setReloadVersion(value => value + 1) }}>重新读取</button>
        </div>
      )}
      {persistent && reportState.phase === 'success' && <div data-testid="markdown-body" className={css.eventMarkdown}><MarkdownText text={reportState.markdown} /></div>}
    </DetailDialog>
  )
}

export function eventPrimaryTicker(item: Record<string, unknown>): { code: string; name: string } | undefined {
  const tickers = Array.isArray(item.tickers) ? item.tickers as unknown[] : []
  const first = tickers[0]
  if (typeof first === 'string') return first.trim() === '' ? undefined : { code: first.trim(), name: '' }
  const ticker = asRecord(first)
  const code = text(ticker.code, '').trim()
  return code === '' ? undefined : { code, name: text(ticker.name, '') }
}

export function riskIntentTarget(item: Record<string, unknown>): { code?: string; strategyId?: string } {
  const code = strings(item.codes)[0]
  const strategyId = text(item.strategy_id, '')
  return {
    ...(code === undefined ? {} : { code }),
    ...(strategyId === '' ? {} : { strategyId }),
  }
}
