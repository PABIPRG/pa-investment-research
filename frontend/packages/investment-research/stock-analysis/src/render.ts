// S4：Signal schema → Markdown 渲染
// 把适配器返回的统一 Signal + 分步报告渲染为决策摘要卡 + 折叠报告。
// 纯函数（dsh 要求在 live streaming 与 replay 中都只依赖入参）。

/** Decision fields returned by the stock-analysis adapter. */
export interface Signal {
  signal_type?: string
  ticker?: string
  company_name?: string
  action?: string
  target_price?: number | null
  confidence?: number | null
  risk_score?: number | null
  reasoning?: string
  model_info?: string
  risk_profile?: string
  calibration?: boolean
  calibration_note?: string
}

/** Stock-analysis signal plus its lossless staged reports and metrics. */
export interface AnalyzeResult {
  signal: Signal
  reports?: Record<string, string>
  performance_metrics?: Record<string, unknown>
}

const ACTION_EMOJI: Record<string, string> = {
  买入: '🟢 买入',
  持有: '🟡 持有',
  卖出: '🔴 卖出',
}

const RISK_PROFILE_LABEL: Record<string, string> = {
  conservative: '保守型',
  balanced: '稳健型',
  aggressive: '进取型',
}

/**
 * Resolve a known risk-profile key while preserving an unknown adapter value.
 * @param profile - Adapter profile key or display value.
 * @returns Chinese label, preserved unknown value, or an empty string when omitted.
 */
export function profileLabel(profile?: string): string {
  return profile ? (RISK_PROFILE_LABEL[profile] ?? profile) : ''
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  return n == null ? '—' : numericValue(n).toFixed(digits)
}

function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${(numericValue(n) * 100).toFixed(0)}%`
}

function numericValue(value: unknown): number {
  return Number(value)
}

/**
 * Render the decision summary used at the top of model and UI output.
 * @param s - Adapter decision signal.
 * @returns Chinese Markdown with price, confidence, risk, and available annotations.
 */
export function renderSignalCard(s: Signal): string {
  const action = ACTION_EMOJI[s.action ?? ''] ?? s.action ?? '—'
  const lines = [
    `## ${action} · ${s.company_name ?? s.ticker ?? ''}`,
    '',
    '| 目标价 | 置信度 | 风险分 |',
    '|---|---|---|',
    `| ¥${fmtNum(s.target_price)} | ${pct(s.confidence)} | ${pct(s.risk_score)} |`,
  ]
  if (s.risk_profile) {
    lines.push('', `**风险画像：${profileLabel(s.risk_profile)}**`)
  }
  if (s.reasoning) {
    lines.push('', '**理由：** ' + s.reasoning)
  }
  if (s.calibration && s.calibration_note) {
    lines.push('', `*⚠️ 风险偏好护栏已校准：${s.calibration_note}*`)
  }
  if (s.model_info) {
    lines.push('', `*模型：${s.model_info}*`)
  }
  return lines.join('\n')
}

/**
 * Render the complete model-visible stock-analysis report in its stable stage order.
 * @param r - Decision signal and optional staged Markdown reports.
 * @returns Chinese Markdown containing the summary and every non-empty known report.
 */
export function renderFullReport(r: AnalyzeResult): string {
  const parts: string[] = [renderSignalCard(r.signal)]
  const reports = r.reports ?? {}
  const order = [
    ['market', '📊 市场分析'],
    ['fundamentals', '💼 基本面分析'],
    ['news', '📰 新闻分析'],
    ['sentiment', '💬 情绪分析'],
    ['debate', '🤝 多空辩论'],
    ['trader', '📈 交易员计划'],
    ['risk', '🛡 风险评估'],
  ] as const
  for (const [key, label] of order) {
    const text = reports[key]
    if (text && text.trim()) {
      parts.push('', '---', '', `## ${label}`, '', text.trim())
    }
  }
  return parts.join('\n')
}

/**
 * Render the compact UI result card without duplicating staged reports.
 * @param r - Stock-analysis result.
 * @returns The same decision summary used by the full report.
 */
export function renderResultCard(r: AnalyzeResult): string {
  return renderSignalCard(r.signal)
}

// ---- 功能3 持仓分析 / 功能4 简报渲染 ------------------------------------

/** One portfolio risk-budget excess reported by the adapter. */
export interface RiskBreach {
  indicator?: string
  label?: string
  value?: number
  limit?: number
  excess?: number
}

/** Portfolio totals, risk measures, breaches, and per-position analysis. */
export interface HoldingsSignal {
  signal_type?: string
  mode?: string
  risk_profile?: string
  total_market_value?: number
  total_cost?: number
  floating_pnl?: number
  floating_pnl_pct?: number
  weighted_risk_score?: number
  portfolio_annualized_vol?: number
  concentration_hhi?: number
  n_positions?: number
  sector_exposure?: Array<{ industry: string; weight: number }>
  risk_breaches?: RiskBreach[]
  rebalance_suggestions?: string[]
  per_stock?: Record<
    string,
    {
      name?: string
      weight?: number
      last_price?: number
      market_value?: number
      floating_pnl?: number
      annualized_vol?: number
      max_drawdown?: number
      beta?: number | null
      industry?: string
      risk_score?: number | null
      risk_level?: string
      action?: string | null
      reasoning?: string | null
    }
  >
}

/** One opportunity listed in a generated market brief. */
export interface BriefOpportunity {
  kind?: string
  title?: string
  ticker?: string
  risk_level?: string
}

/** Generated market-brief metadata, Markdown summary, and opportunities. */
export interface BriefSignal {
  signal_type?: string
  period?: string
  trade_date?: string
  summary?: string
  risk_profile?: string
  opportunities?: BriefOpportunity[]
}

const BREACH_LABELS: Record<string, string> = {
  single_stock_weight: '单股权重',
  portfolio_vol: '组合波动率',
  hhi: '集中度 HHI',
  beta: '组合 β',
}

/**
 * Render the portfolio overview used by the holdings-analysis UI card.
 * @param s - Holdings signal returned by the adapter.
 * @returns Chinese Markdown with totals, risk-budget breaches, suggestions, and sector exposure.
 */
export function renderHoldingsCard(s: HoldingsSignal): string {
  const lines = [
    `## 🧺 持仓组合概览（${s.mode === 'deep' ? '深度逐股分析' : '快速定量'} · ${s.n_positions ?? 0} 只）`,
    '',
    '| 总市值 | 总成本 | 浮动盈亏 | 加权风险 | 组合波动 | 集中度 HHI |',
    '|---|---|---|---|---|---|',
    `| ¥${fmtNum(s.total_market_value, 0)} | ¥${fmtNum(s.total_cost, 0)} | ` +
      `¥${fmtNum(s.floating_pnl, 0)}（${pct(s.floating_pnl_pct)}） | ` +
      `${fmtNum(s.weighted_risk_score)} | ${pct(s.portfolio_annualized_vol)} | ${fmtNum(s.concentration_hhi, 3)} |`,
  ]
  if (s.risk_profile) {
    lines.push('', `**风险画像：${profileLabel(s.risk_profile)}**`)
  }
  const breaches = s.risk_breaches ?? []
  if (breaches.length) {
    lines.push('', '**🚨 风险预算超限：**')
    for (const b of breaches) {
      const name = BREACH_LABELS[b.indicator ?? ''] ?? (b.indicator ?? '')
      const who = b.label ? `（${b.label}）` : ''
      const isRatio = b.indicator === 'beta' || b.indicator === 'hhi'
      const val = isRatio ? fmtNum(b.value, 2) : pct(b.value)
      const lim = isRatio ? fmtNum(b.limit, 2) : `${((b.limit ?? 0) * 100).toFixed(0)}%`
      lines.push(`- ${name}${who} ${val} 超预算 ${lim}`)
    }
  }
  if ((s.rebalance_suggestions ?? []).length) {
    lines.push('', '**调仓建议：**')
    for (const g of s.rebalance_suggestions ?? []) lines.push('- ' + g)
  }
  const sectors = s.sector_exposure ?? []
  if (sectors.length) {
    lines.push('', '**行业暴露：** ' + sectors.map(x => `${x.industry} ${(x.weight * 100).toFixed(1)}%`).join(' · '))
  }
  return lines.join('\n')
}

/**
 * Render the holdings report, preferring adapter-authored portfolio Markdown.
 * @param r - Holdings signal and optional staged reports.
 * @returns Adapter Markdown when present, otherwise a deterministic portfolio table.
 */
export function renderHoldingsReport(r: { signal: HoldingsSignal; reports?: Record<string, string> }): string {
  const md = r.reports?.portfolio
  if (md && md.trim()) return md.trim()
  const s = r.signal
  const parts = [renderHoldingsCard(s)]
  const per = s.per_stock ?? {}
  parts.push('', '| 代码 | 名称 | 权重 | 现价 | 浮盈 | 波动 | 回撤 | β | 行业 | 风险等级 | 风险分 | 信号 |', '|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [t, p] of Object.entries(per)) {
    parts.push(
      `| ${t} | ${p.name ?? ''} | ${(p.weight ?? 0) * 100}% | ¥${fmtNum(p.last_price)} | ` +
        `¥${fmtNum(p.floating_pnl, 0)} | ${pct(p.annualized_vol)} | ${pct(p.max_drawdown)} | ` +
        `${p.beta == null ? '—' : p.beta.toFixed(2)} | ${p.industry ?? ''} | ` +
        `${p.risk_level ?? '—'} | ${p.risk_score == null ? '—' : p.risk_score.toFixed(2)} | ${p.action ?? '—'} |`,
    )
  }
  return parts.join('\n')
}

/**
 * Render the compact UI heading for a generated market brief.
 * @param s - Brief metadata and opportunities.
 * @returns Chinese Markdown heading with period, date, risk profile, and opportunity count.
 */
export function renderBriefCard(s: BriefSignal): string {
  const label = s.period === 'pre_market' ? '盘前' : s.period === 'post_market' ? '盘后' : '盘中'
  const pf = s.risk_profile ? ` · ${profileLabel(s.risk_profile)}` : ''
  return `## 📊 A股${label}简报 · ${s.trade_date ?? ''}${pf}（${s.opportunities?.length ?? 0} 个机会点）`
}

/**
 * Render the complete brief, preferring the adapter-authored Markdown summary.
 * @param r - Brief signal and optional reports.
 * @returns Adapter Markdown when present, otherwise a deterministic opportunity list.
 */
export function renderBrief(r: { signal: BriefSignal; reports?: Record<string, string> }): string {
  const md = r.signal.summary
  if (md && md.trim()) return md.trim()
  const s = r.signal
  const parts = [renderBriefCard(s), '']
  for (const o of s.opportunities ?? []) {
    parts.push(`- ${o.risk_level ? `[${o.risk_level}] ` : ''}${o.title ?? ''}`)
  }
  return parts.join('\n')
}
