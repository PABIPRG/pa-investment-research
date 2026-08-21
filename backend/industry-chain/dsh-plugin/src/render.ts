// industry-chain 渲染器：纯函数 Markdown，供工具 output.render 复用。
// 与适配器返回字段对齐（company_profile / graph_single / graph_chain / search）。

type Num = number | null | undefined

function shareTxt(v: unknown): string {
  return typeof v === 'number' && v ? `${v}%` : '-'
}

function viaTxt(v: unknown): string {
  if (Array.isArray(v) && v.length) return ` ⇠ ${(v as string[]).join(' / ')}`
  return typeof v === 'string' && v ? ` ⇠ ${v}` : ''
}

// ---- 公司搜索 ------------------------------------------------------------

export function renderSearch(value: { items?: Array<Record<string, unknown>>; count?: number }): string {
  const items = value.items ?? []
  if (!items.length) return '**未找到匹配公司**，换关键词试试（名称/代码/行业模糊匹配）。'
  const rows = items.map((c, i) => {
    const star = c.is_subject ? ' ⭐' : ''
    const ind = c.industry ? ` · ${c.industry}` : ''
    return `${i + 1}. ${c.name}（${c.code}）${ind}${star}`
  })
  return `**公司搜索（${items.length}）**\n\n${rows.join('\n')}`
}

// ---- 公司档案 ------------------------------------------------------------

export function renderProfile(v: Record<string, unknown>): string {
  const lines = [`**${v.name ?? '-'}（${v.code ?? '-'}）**`]
  if (v.industry) lines.push(`行业：${v.industry}`)
  if (v.market_cap_display) lines.push(`市值：${v.market_cap_display}`)
  if (typeof v.stock_price === 'number') lines.push(`股价：${v.stock_price}`)
  if (v.is_subject) lines.push('研报覆盖公司 ⭐')
  lines.push(`上下游：供应商 ${v.supplier_count ?? 0} · 客户 ${v.customer_count ?? 0} · 原材料 ${v.material_count ?? 0} · 产品 ${v.product_count ?? 0}`)
  if (v.desc) lines.push('', String(v.desc))
  return lines.join('\n')
}

// ---- 单公司 5 列产业链 ---------------------------------------------------

export function renderGraph(value: {
  company?: Record<string, unknown>
  materials?: Array<Record<string, unknown>>
  suppliers?: Array<Record<string, unknown>>
  products?: Array<Record<string, unknown>>
  customers?: Array<Record<string, unknown>>
}): string {
  const name = value.company?.name ?? '-'
  const lines = [`**${name} 产业链**（供应商 → 原材料 → 核心公司 → 主营产品 → 下游客户）`]
  const cols: Array<[string, Array<Record<string, unknown>> | undefined]> = [
    ['⬆️ 供应商', value.suppliers],
    ['原材料', value.materials],
    ['主营产品', value.products],
    ['⬇️ 下游客户', value.customers],
  ]
  for (const [title, rows] of cols) {
    const list = rows ?? []
    if (!list.length) continue
    lines.push('', `### ${title}（${list.length}）`)
    lines.push(
      ...list.slice(0, 15).map((r) => {
        const share = shareTxt(r.share)
        return `- ${r.name ?? '-'}${share !== '-' ? `（${share}）` : ''}${viaTxt(r.vias)}`
      }),
    )
    if (list.length > 15) lines.push(`- …等共 ${list.length} 项`)
  }
  return lines.join('\n')
}

// ---- 产业链多层展开 ------------------------------------------------------

type Level = { level?: number; nodes?: Array<Record<string, unknown>> }

export function renderExpand(value: {
  center?: Record<string, unknown>
  up_levels?: Level[]
  down_levels?: Level[]
}): string {
  const name = value.center?.name ?? '-'
  const lines = [`**${name} 产业链展开**`]
  const up = value.up_levels ?? []
  const down = value.down_levels ?? []

  const renderLevel = (l: Level): string[] =>
    (l.nodes ?? []).map((n) => {
      const share = shareTxt(n.share)
      return `- ${n.name ?? '-'}${share !== '-' ? `（${share}）` : ''}${viaTxt(n.via)}`
    })

  if (down.length) {
    for (const l of down) {
      const rows = renderLevel(l)
      if (rows.length) lines.push('', `⬇️ 下游 第${Math.abs(l.level ?? 0)}层`, ...rows)
    }
  }
  lines.push('', `**${name}（中心）**`)
  if (up.length) {
    for (const l of up) {
      const rows = renderLevel(l)
      if (rows.length) lines.push('', `⬆️ 上游 第${Math.abs(l.level ?? 0)}层`, ...rows)
    }
  }
  if (!up.length && !down.length) lines.push('图谱中暂无上下游数据')
  return lines.join('\n')
}
