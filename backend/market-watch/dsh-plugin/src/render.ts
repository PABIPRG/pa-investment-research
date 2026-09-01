// market-watch 渲染器：纯函数 Markdown，供工具 output.render 复用。
// 与适配器返回字段对齐（flash / events / event-alerts / overview / scan / tech-signal / brief）。

type Row = Record<string, unknown>

function pct(v: unknown): string {
  return typeof v === 'number' ? `${v >= 0 ? '' : ''}${v.toFixed(2)}%` : '-'
}

function moneyYi(v: unknown): string {
  return typeof v === 'number' ? `${v.toFixed(2)}亿` : '-'
}

// ---- 实时快讯 ------------------------------------------------------------

export function renderFlash(value: { items?: Array<Row>; sources?: string[] }): string {
  const items = value.items ?? []
  const sources = value.sources ?? []
  if (!items.length) return '**暂无快讯**'
  const lines = items.map((it, i) => {
    const t = it.title ?? it.content ?? ''
    const time = it.time ? ` · ${it.time}` : ''
    const tag = it.tag ? `【${it.tag}】` : ''
    return `${i + 1}. ${tag}${t}${time}`
  })
  return `**实时快讯（${items.length}）**${sources.length ? ` ｜ 来源 ${sources.join('/')}` : ''}\n\n${lines.join('\n')}`
}

// ---- 结构化投资事件 ------------------------------------------------------

export function renderEvents(value: { items?: Array<Row>; count?: number }): string {
  const items = value.items ?? []
  if (!items.length) return '**暂无结构化事件**'
  const lines = items.map((e, i) => {
    const dir = e.direction ? `（${e.direction}）` : ''
    const ty = e.type ? `[${e.type}]` : ''
    const tks = (e.tickers as Array<Row> | undefined) ?? []
    const codes = tks.map((t) => `${t.name ?? ''}${t.code ? `(${t.code})` : ''}`).join(' / ')
    const sum = e.summary ?? e.title ?? ''
    const ind = (e.industries as string[] | undefined)?.length ? ` ｜ 行业 ${(e.industries as string[]).join('/')}` : ''
    return `${i + 1}. ${ty}${dir} ${sum}${codes ? `\n   → ${codes}${ind}` : ''}`
  })
  return `**结构化投资事件（${items.length}${value.count != null ? `/${value.count}` : ''}）**\n\n${lines.join('\n')}`
}

// ---- 事件预警中心 --------------------------------------------------------

export function renderEventAlerts(value: { items?: Array<Row>; watch?: string[]; hold?: string[] }): string {
  const items = value.items ?? []
  const watch = value.watch ?? []
  const hold = value.hold ?? []
  const lines: string[] = []
  if (!items.length) {
    lines.push('**当前无命中自选/持仓的事件预警**')
  } else {
    items.forEach((it, i) => {
      const t = it.title ?? it.summary ?? ''
      const codes = Array.isArray(it.codes) ? `（${(it.codes as unknown[]).join(',')}）` : ''
      lines.push(`${i + 1}. ${t}${codes}`)
    })
  }
  if (hold.length || watch.length) {
    lines.push(`\n关注中：自选 ${watch.join('/')} ｜ 持仓 ${hold.join('/')}`)
  }
  return lines.join('\n')
}

// ---- 盯盘面板 ------------------------------------------------------------

export function renderOverview(value: { items?: Array<Row>; trade_date?: string }): string {
  const items = value.items ?? []
  if (!items.length) return `**盯盘面板（${value.trade_date ?? ''}）**\n\n暂无自选行情。`
  const lines = items.map((it, i) => {
    const name = `${it.name ?? ''}（${it.code ?? ''}）`
    const chg = typeof it.pct_change === 'number' ? `${it.pct_change >= 0 ? '+' : ''}${it.pct_change.toFixed(2)}%` : '-'
    const amt = moneyYi(it.amount_yi)
    const hit = (it.hit as Array<Row> | undefined) ?? []
    const hitTxt = hit.length ? ` ⚠️命中：${hit.map((h) => h.name).join('、')}` : ''
    const nearTxt = (it.near as unknown[] | undefined)?.length ? '（逼近）' : ''
    return `${i + 1}. ${name} ${chg} 成交${amt}${hitTxt}${nearTxt}`
  })
  return `**盯盘面板（${value.trade_date ?? ''}）**\n\n${lines.join('\n')}`
}

// ---- 盘中异动扫描 --------------------------------------------------------

type ScanRenderValue = {
  items?: Array<Row>
  limit_up?: Array<Row>
  limit_down?: Array<Row>
  kind?: string
  trade_date?: string
  source?: string
  stale?: boolean
  complete?: boolean
  warnings?: string[]
}

function renderScanRows(items: Array<Row>): string {
  return items.map((it, i) => {
    const name = `${it.name ?? ''}（${it.code ?? ''}）`
    const chg = pct(it.pct_change)
    const amt = moneyYi(it.amount_yi)
    return `${i + 1}. ${name} ${chg} 成交${amt}`
  }).join('\n')
}

export function renderScan(value: ScanRenderValue): string {
  const kindMap: Record<string, string> = {
    gainers: '涨幅榜', volume_ratio: '量比榜', limit: '涨跌停', turnover: '换手榜', amount: '成交额榜',
  }
  const label = kindMap[String(value.kind ?? '')] ?? String(value.kind ?? '')
  const meta = [
    value.source ? `来源 ${value.source}` : '',
    value.stale === true ? '缓存数据' : '',
    value.complete === false ? '结果不完整' : '',
  ].filter(Boolean).join(' ｜ ')
  const warning = value.warnings?.length ? `提示：${value.warnings.join('；')}` : ''
  const sections = [`**${label}（${value.trade_date ?? ''}）**`]
  if (meta) sections.push(meta)

  if (value.kind === 'limit') {
    const up = value.limit_up ?? []
    const down = value.limit_down ?? []
    sections.push(`**涨停（${up.length}）**\n${up.length ? renderScanRows(up) : '暂无数据。'}`)
    sections.push(`**跌停（${down.length}）**\n${down.length ? renderScanRows(down) : '暂无数据。'}`)
  } else {
    const items = value.items ?? []
    sections.push(items.length ? renderScanRows(items) : '暂无数据。')
  }

  if (warning) sections.push(warning)
  return sections.join('\n\n')
}

// ---- 个股技术信号 --------------------------------------------------------

export function renderTechSignal(v: Record<string, unknown>): string {
  if (v.status === 'preparing') {
    const message = typeof v.message === 'string' && v.message.trim()
      ? v.message.trim()
      : 'K 线数据正在后台准备，请稍后重试。'
    const retryAfter = typeof v.retry_after_ms === 'number' && v.retry_after_ms > 0
      ? `建议约 ${Math.max(1, Math.ceil(v.retry_after_ms / 1000))} 秒后重试。`
      : '请稍后重试。'
    return `**技术信号正在准备**\n\n${message}\n\n${retryAfter}`
  }

  if (v.status === 'unavailable') {
    const message = typeof v.message === 'string' && v.message.trim()
      ? v.message.trim()
      : '技术数据暂时不可用。'
    const retryHint = v.retryable === true ? '\n\n当前状态可以重试。' : ''
    return `**技术信号暂不可用**\n\n${message}${retryHint}`
  }

  const name = `${v.name ?? ''}（${v.code ?? ''}）`
  const last = v.last as Row | undefined
  const close = last ? last.close : null
  const ind = v.indicators as Row | undefined
  const lines = [`**${name}**`]
  if (typeof close === 'number') lines.push(`现价 ${close.toFixed(2)}`)
  if (ind) {
    const ma = ind.ma as Row | undefined
    if (ma?.trend) lines.push(`均线：${ma.trend}`)
    const rsi = ind.rsi as Row | undefined
    if (rsi) lines.push(`RSI14 ${rsi.rsi14}（${rsi.state}）`)
    const kdj = ind.kdj as Row | undefined
    if (kdj) lines.push(`KDJ K${kdj.k} D${kdj.d} J${kdj.j}${kdj.cross ? ` 交叉:${kdj.cross}` : ''}`)
    const boll = ind.boll as Row | undefined
    if (boll) lines.push(`BOLL 上${boll.upper} 中${boll.mid} 下${boll.lower}（${boll.state}）`)
  }
  if (v.signals) lines.push('', `信号：${JSON.stringify(v.signals)}`)
  return lines.join('\n')
}

// ---- 最近简报 ------------------------------------------------------------

export function renderBrief(v: Record<string, unknown>): string {
  const period = v.period === 'pre' ? '盘前' : v.period === 'post' ? '盘后' : v.period
  const content = typeof v.content === 'string' ? v.content : JSON.stringify(v)
  return `**${period}简报（${v.trade_date ?? ''}）**\n\n${content}`
}
