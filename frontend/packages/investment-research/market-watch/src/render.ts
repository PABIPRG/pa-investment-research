// market-watch 渲染器：纯函数 Markdown，供工具 output.render / presentationMeta 复用。

type Num = number | null | undefined

interface AlertRenderItem {
  id?: string
  name?: string
  ticker?: string
  combine?: string
  conditions?: unknown
  cooldown_min?: number
  daily_cap?: number
  enabled?: boolean
}

interface ScanRow {
  name?: string
  code?: string
  price?: Num
  pct_change?: Num
  volume_ratio?: Num
  turnover?: Num
  amount_yi?: Num
}

interface ScanRenderValue {
  kind?: string
  trade_date?: string
  as_of?: string
  limit_up?: ScanRow[]
  limit_down?: ScanRow[]
  items?: ScanRow[]
}

interface OverviewRow extends ScanRow {
  fund_flow_yi?: Num
  hit?: Array<{ name: string }>
  near?: Array<{ name: string }>
}

interface TechSignalRenderValue {
  name?: string
  code?: string
  bars?: number
  signals?: string[]
  indicators?: {
    support_resistance?: { support?: Num; resistance?: Num }
    pattern?: { pattern?: string }
  }
}

interface NewsRenderValue {
  trade_date?: string
  digest?: unknown
  items?: {
    global?: string[]
    stocks?: Record<string, string[] | undefined>
  }
}

interface BriefRenderValue {
  period?: string
  trade_date?: string
  llm_used?: boolean
  content?: string
}

function fmt(v: Num, suffix = ''): string {
  if (v === null || v === undefined) return '-'
  return `${v}${suffix}`
}

function pct(v: Num): string {
  if (v === null || v === undefined) return '-'
  return `${v > 0 ? '+' : ''}${v}%`
}

function yi(v: Num): string {
  if (v === null || v === undefined) return '-'
  return `${v}亿`
}

// ---- 自选 ---------------------------------------------------------------

/**
 * Render the current watchlist or the action needed when it is empty.
 * @param value - Adapter response containing watchlist entries.
 * @returns Chinese Markdown for model output and result presentation.
 */
export function renderWatchlist(value: { items?: Array<{ code: string; name: string }>; count?: number }): string {
  const items = value.items ?? []
  if (!items.length) return '**自选列表为空**，用 `watch_add` 添加。'
  const rows = items.map((w, i) => `${i + 1}. ${w.name}（${w.code}）`).join('\n')
  return `**自选股（${items.length}）**\n\n${rows}`
}

// ---- 规则 ---------------------------------------------------------------

/**
 * Render alert conditions, scope, state, and delivery guards.
 * @param value - Adapter response containing alert-rule records.
 * @returns Chinese Markdown, including the empty-state instruction.
 */
export function renderAlerts(value: { items?: Array<Record<string, unknown>>; count?: number }): string {
  const items = (value.items ?? []) as AlertRenderItem[]
  if (!items.length) return '**暂无盯盘规则**，用 `add_alert` 创建。'
  return items
    .map((r) => {
      const conds = Array.isArray(r.conditions)
        ? (r.conditions as Array<{ field: string; operator: string; value: number }>)
          .map(c => `${c.field} ${c.operator} ${c.value}`)
          .join(r.combine === 'and' ? ' 且 ' : ' 或 ')
        : '-'
      const scope = r.ticker ? `@${r.ticker}` : '全部自选'
      const guards: string[] = []
      if (r.cooldown_min) guards.push(`冷却${r.cooldown_min}min`)
      if (r.daily_cap) guards.push(`日限${r.daily_cap}次`)
      return `- [${String(r.id)}] ${String(r.name)}（${scope}）：${conds}${r.enabled === false ? ' ⏸' : ''}${guards.length ? ` （${guards.join('，')}）` : ''}`
    })
    .join('\n')
}

// ---- 扫描 ---------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  gainers: '涨幅榜',
  volume_ratio: '量比异动',
  limit: '涨跌停',
  turnover: '换手异动',
  amount: '成交额榜',
}

/**
 * Render a limit-mover or ranked market scan without dropping snapshot metadata.
 * @param value - Adapter scan response selected by `kind`.
 * @returns Chinese Markdown for the ranked rows and snapshot time.
 */
export function renderScan(value: Record<string, unknown>): string {
  const data = value as ScanRenderValue
  const kind = KIND_LABEL[data.kind ?? ''] ?? String(data.kind)
  const lines = [`**${kind}** · 交易日 ${data.trade_date ?? '-'}`]
  if (data.kind === 'limit') {
    const up = data.limit_up ?? []
    const down = data.limit_down ?? []
    if (up.length) lines.push(`\n📈 涨停 ${up.length} 只：`)
    lines.push(...up.map(r => `- ${String(r.name)}（${String(r.code)}）${fmt(r.price)} ${pct(r.pct_change)}`))
    if (down.length) lines.push(`\n📉 跌停 ${down.length} 只：`)
    lines.push(...down.map(r => `- ${String(r.name)}（${String(r.code)}）${fmt(r.price)} ${pct(r.pct_change)}`))
    if (!up.length && !down.length) lines.push('\n今日无涨跌停')
  } else {
    const items = data.items ?? []
    lines.push(
      ...items.map((r, i) => {
        const parts = [`${i + 1}. ${String(r.name)}（${String(r.code)}）`, fmt(r.price), pct(r.pct_change)]
        if (r.volume_ratio !== null && r.volume_ratio !== undefined) parts.push(`量比 ${r.volume_ratio}`)
        if (r.turnover !== null && r.turnover !== undefined) parts.push(`换手 ${r.turnover}%`)
        if (r.amount_yi !== null && r.amount_yi !== undefined) parts.push(`成交 ${yi(r.amount_yi)}`)
        return parts.join('  ')
      }),
    )
  }
  lines.push(`\n> 快照 ${data.as_of ?? '-'}`)
  return lines.join('\n')
}

// ---- 盯盘面板 ------------------------------------------------------------

/**
 * Render the watchlist quote panel with triggered and approaching rules.
 * @param value - Adapter overview response for the configured watchlist.
 * @returns Chinese Markdown, including an instruction when no rows exist.
 */
export function renderOverview(value: { items?: Array<Record<string, unknown>>; trade_date?: string }): string {
  const items = (value.items ?? []) as OverviewRow[]
  if (!items.length) return '**盯盘面板为空**，先 `watch_add` 添加自选。'
  const lines = [`**盯盘面板** · 交易日 ${value.trade_date ?? '-'}`, '']
  for (const r of items) {
    const hit = r.hit ?? []
    const near = r.near ?? []
    const marks: string[] = []
    if (hit.length) marks.push(`🔥命中:${hit.map(h => h.name).join(',')}`)
    if (near.length) marks.push(`⚠️逼近:${near.map(n => n.name).join(',')}`)
    const fund = r.fund_flow_yi !== null && r.fund_flow_yi !== undefined ? ` 主力${yi(r.fund_flow_yi)}` : ''
    lines.push(
      `${String(r.name)}（${String(r.code)}）${fmt(r.price)} ${pct(r.pct_change)}` +
        ` 量比${fmt(r.volume_ratio)} 换手${fmt(r.turnover, '%')} 成交${yi(r.amount_yi)}` +
        `${fund}${marks.length ? '  ' + marks.join(' ') : ''}`,
    )
  }
  return lines.join('\n')
}

// ---- 技术信号 ------------------------------------------------------------

/**
 * Render technical indicators and signals, retaining the no-signal explanation.
 * @param value - Adapter response for one ticker's technical analysis.
 * @returns Chinese Markdown for the signal list and support/resistance details.
 */
export function renderTechSignal(value: Record<string, unknown>): string {
  const data = value as TechSignalRenderValue
  const signals = data.signals ?? []
  const ind = data.indicators ?? {}
  const lines = [`**技术信号** · ${data.name ?? ''}（${data.code ?? ''}）· ${data.bars ?? '-'} 根K线`, '']
  lines.push(...signals.map(s => `- ${s}`))
  const sr = ind.support_resistance ?? {}
  const pat = ind.pattern ?? {}
  const extra: string[] = []
  if (sr.support !== null && sr.support !== undefined) extra.push(`支撑/压力 ${sr.support}/${sr.resistance}`)
  if (pat.pattern) extra.push(`形态 ${pat.pattern}`)
  if (extra.length) lines.push('', ...extra.map(s => `- ${s}`))
  if (!signals.length && !extra.length) lines.push('数据不足，无可用信号')
  return lines.join('\n')
}

// ---- 新闻 / 简报 ---------------------------------------------------------

/**
 * Render market and per-stock headlines plus the optional generated digest.
 * @param value - Adapter news response grouped by global and ticker headlines.
 * @returns Chinese Markdown with an explicit fallback when all sources are empty.
 */
export function renderNews(value: Record<string, unknown>): string {
  const data = value as NewsRenderValue
  const lines = [`**新闻速递** · 交易日 ${data.trade_date ?? '-'}`, '']
  const items = data.items ?? {}
  const globals = items.global ?? []
  if (globals.length) {
    lines.push('## 市场要闻')
    lines.push(...globals.map((t, i) => `${i + 1}. ${t}`))
  }
  const stocks = items.stocks ?? {}
  for (const [code, titles] of Object.entries(stocks)) {
    lines.push(`## ${code}`)
    lines.push(...(titles ?? []).map(t => `- ${t}`))
  }
  if (typeof data.digest === 'string' && data.digest) lines.push('', data.digest)
  if (!globals.length && !Object.keys(stocks).length) lines.push('本次无新闻返回（数据源暂不可用）')
  return lines.join('\n')
}

/**
 * Render a pre-market or post-market brief and identify its generation mode.
 * @param value - Adapter brief response.
 * @returns Chinese Markdown containing the full brief content.
 */
export function renderBrief(value: Record<string, unknown>): string {
  const data = value as BriefRenderValue
  const period = data.period === 'post' ? '盘后复盘' : '盘前关注'
  return `**${period}** · ${data.trade_date ?? '-'}${data.llm_used ? '（LLM 生成）' : '（数据模板）'}\n\n${data.content ?? ''}`
}
