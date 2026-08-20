// market-watch 渲染器：纯函数 Markdown，供工具 output.render / presentationMeta 复用。

type Num = number | null | undefined

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

export function renderWatchlist(value: { items?: Array<{ code: string; name: string }>; count?: number }): string {
  const items = value.items ?? []
  if (!items.length) return '**自选列表为空**，用 `watch_add` 添加。'
  const rows = items.map((w, i) => `${i + 1}. ${w.name}（${w.code}）`).join('\n')
  return `**自选股（${items.length}）**\n\n${rows}`
}

// ---- 规则 ---------------------------------------------------------------

export function renderAlerts(value: { items?: Array<Record<string, unknown>>; count?: number }): string {
  const items = value.items ?? []
  if (!items.length) return '**暂无盯盘规则**，用 `add_alert` 创建。'
  return items
    .map((r) => {
      const conds = Array.isArray(r.conditions)
        ? (r.conditions as Array<{ field: string; operator: string; value: number }>)
            .map((c) => `${c.field} ${c.operator} ${c.value}`)
            .join(r.combine === 'and' ? ' 且 ' : ' 或 ')
        : '-'
      const scope = r.ticker ? `@${r.ticker}` : '全部自选'
      const guards = []
      if (r.cooldown_min) guards.push(`冷却${r.cooldown_min}min`)
      if (r.daily_cap) guards.push(`日限${r.daily_cap}次`)
      return `- [${r.id}] ${r.name}（${scope}）：${conds}${r.enabled === false ? ' ⏸' : ''}${guards.length ? ` （${guards.join('，')}）` : ''}`
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

export function renderScan(value: Record<string, unknown>): string {
  const kind = KIND_LABEL[(value.kind as string) ?? ''] ?? value.kind
  const lines = [`**${kind}** · 交易日 ${value.trade_date ?? '-'}`]
  if (value.kind === 'limit') {
    const up = (value.limit_up as Array<Record<string, unknown>>) ?? []
    const down = (value.limit_down as Array<Record<string, unknown>>) ?? []
    if (up.length) lines.push(`\n📈 涨停 ${up.length} 只：`)
    lines.push(...up.map((r) => `- ${r.name}（${r.code}）${fmt(r.price as Num)} ${pct(r.pct_change as Num)}`))
    if (down.length) lines.push(`\n📉 跌停 ${down.length} 只：`)
    lines.push(...down.map((r) => `- ${r.name}（${r.code}）${fmt(r.price as Num)} ${pct(r.pct_change as Num)}`))
    if (!up.length && !down.length) lines.push('\n今日无涨跌停')
  } else {
    const items = (value.items as Array<Record<string, unknown>>) ?? []
    lines.push(
      ...items.map((r, i) => {
        const parts = [`${i + 1}. ${r.name}（${r.code}）`, `${fmt(r.price as Num)}`, pct(r.pct_change as Num)]
        if (r.volume_ratio !== null && r.volume_ratio !== undefined) parts.push(`量比 ${r.volume_ratio}`)
        if (r.turnover !== null && r.turnover !== undefined) parts.push(`换手 ${r.turnover}%`)
        if (r.amount_yi !== null && r.amount_yi !== undefined) parts.push(`成交 ${yi(r.amount_yi as Num)}`)
        return parts.join('  ')
      }),
    )
  }
  lines.push(`\n> 快照 ${value.as_of ?? '-'}`)
  return lines.join('\n')
}

// ---- 盯盘面板 ------------------------------------------------------------

export function renderOverview(value: { items?: Array<Record<string, unknown>>; trade_date?: string }): string {
  const items = value.items ?? []
  if (!items.length) return '**盯盘面板为空**，先 `watch_add` 添加自选。'
  const lines = [`**盯盘面板** · 交易日 ${value.trade_date ?? '-'}`, '']
  for (const r of items) {
    const hit = (r.hit as Array<{ name: string }>) ?? []
    const near = (r.near as Array<{ name: string }>) ?? []
    const marks = []
    if (hit.length) marks.push(`🔥命中:${hit.map((h) => h.name).join(',')}`)
    if (near.length) marks.push(`⚠️逼近:${near.map((n) => n.name).join(',')}`)
    const fund = r.fund_flow_yi !== null && r.fund_flow_yi !== undefined ? ` 主力${yi(r.fund_flow_yi as Num)}` : ''
    lines.push(
      `${r.name}（${r.code}）${fmt(r.price as Num)} ${pct(r.pct_change as Num)}` +
        ` 量比${fmt(r.volume_ratio as Num)} 换手${fmt(r.turnover as Num, '%')} 成交${yi(r.amount_yi as Num)}` +
        `${fund}${marks.length ? '  ' + marks.join(' ') : ''}`,
    )
  }
  return lines.join('\n')
}

// ---- 技术信号 ------------------------------------------------------------

export function renderTechSignal(value: Record<string, unknown>): string {
  const signals = (value.signals as string[]) ?? []
  const ind = (value.indicators as Record<string, Record<string, unknown>>) ?? {}
  const lines = [`**技术信号** · ${value.name ?? ''}（${value.code ?? ''}）· ${value.bars ?? '-'} 根K线`, '']
  lines.push(...signals.map((s) => `- ${s}`))
  const sr = (ind.support_resistance as Record<string, unknown>) ?? {}
  const pat = (ind.pattern as Record<string, unknown>) ?? {}
  const extra = []
  if (sr.support !== null && sr.support !== undefined) extra.push(`支撑/压力 ${sr.support}/${sr.resistance}`)
  if (pat.pattern) extra.push(`形态 ${pat.pattern}`)
  if (extra.length) lines.push('', ...extra.map((s) => `- ${s}`))
  if (!signals.length && !extra.length) lines.push('数据不足，无可用信号')
  return lines.join('\n')
}

// ---- 新闻 / 简报 ---------------------------------------------------------

export function renderNews(value: Record<string, unknown>): string {
  const lines = [`**新闻速递** · 交易日 ${value.trade_date ?? '-'}`, '']
  const items = (value.items as Record<string, unknown>) ?? {}
  const globals = (items.global as string[]) ?? []
  if (globals.length) {
    lines.push('## 市场要闻')
    lines.push(...globals.map((t, i) => `${i + 1}. ${t}`))
  }
  const stocks = (items.stocks as Record<string, string[]>) ?? {}
  for (const [code, titles] of Object.entries(stocks)) {
    lines.push(`## ${code}`)
    lines.push(...(titles ?? []).map((t) => `- ${t}`))
  }
  if (typeof value.digest === 'string' && value.digest) lines.push('', value.digest as string)
  if (!globals.length && !Object.keys(stocks).length) lines.push('本次无新闻返回（数据源暂不可用）')
  return lines.join('\n')
}

export function renderBrief(value: Record<string, unknown>): string {
  const period = value.period === 'post' ? '盘后复盘' : '盘前关注'
  return `**${period}** · ${value.trade_date ?? '-'}${value.llm_used ? '（LLM 生成）' : '（数据模板）'}\n\n${value.content ?? ''}`
}
