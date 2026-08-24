// trading-core 渲染器：纯函数 Markdown，供工具 output.render 复用。
// 任务型工具的 value 是 TaskEnvelope（{task_id,status,result?,error?,note?}），
// result 是适配器统一载荷 {signal, reports, performance_metrics}（或 task 特有结构）。

import type { TaskEnvelope } from './client.ts'

type Row = Record<string, unknown>

// ---- 任务信封通用包装 ------------------------------------------------------

function envelopeTitle(env: TaskEnvelope, label: string): string {
  if (env.status !== 'done') {
    return `**${label} · ${env.status}**（task_id=${env.task_id}）${env.error ? `\n\n❌ ${env.error}` : ''}${env.note ? `\n\n${env.note}` : ''}`
  }
  return `**${label}**`
}

function signalOf(env: TaskEnvelope): Row | undefined {
  const result = env.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const sig = (result as Row).signal
    return sig && typeof sig === 'object' ? (sig as Row) : undefined
  }
  return undefined
}

function reportsOf(env: TaskEnvelope): Row {
  const result = env.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const rep = (result as Row).reports
    return rep && typeof rep === 'object' ? (rep as Row) : {}
  }
  return {}
}

function resultOf(env: TaskEnvelope): Row | undefined {
  if (env.result && typeof env.result === 'object' && !Array.isArray(env.result)) {
    return env.result as Row
  }
  return undefined
}

function pct(v: unknown): string {
  return typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : `${v ?? '-'}`
}

// ---- 任务型渲染 -----------------------------------------------------------

export function renderAnalyzeStock(env: TaskEnvelope): string {
  const lines = [envelopeTitle(env, '个股分析')]
  if (env.status !== 'done') return lines.join('\n')
  const s = signalOf(env)
  if (s) {
    lines.push(`**${s.company_name ?? s.ticker ?? ''}**：${s.action ?? '-'}`)
    if (s.target_price != null) lines.push(`目标价 ${s.target_price}`)
    if (s.confidence != null) lines.push(`置信度 ${pct(s.confidence)}`)
    if (s.risk_score != null) lines.push(`风险分 ${s.risk_score}`)
    if (s.reasoning) lines.push(`\n${s.reasoning}`)
  }
  const rep = reportsOf(env)
  for (const [name, md] of Object.entries(rep)) {
    if (typeof md === 'string' && md.trim()) lines.push('', `📄 ${name}`, '', md)
  }
  return lines.join('\n')
}

export function renderAnalyzeHoldings(env: TaskEnvelope): string {
  const lines = [envelopeTitle(env, '持仓分析')]
  if (env.status !== 'done') return lines.join('\n')
  const s = signalOf(env)
  if (s) {
    if (s.total_market_value != null) lines.push(`总市值 ${s.total_market_value}`)
    if (s.floating_pnl != null) lines.push(`浮动盈亏 ${s.floating_pnl}`)
    if (s.weighted_risk_score != null) lines.push(`加权风险分 ${s.weighted_risk_score}`)
    if (s.concentration_hhi != null) lines.push(`集中度 HHI ${s.concentration_hhi}`)
    if (s.top_sector) lines.push(`第一大板块 ${s.top_sector}`)
    if (s.n_positions != null) lines.push(`持仓 ${s.n_positions} 只`)
  }
  const rep = reportsOf(env)
  for (const [name, md] of Object.entries(rep)) {
    if (typeof md === 'string' && md.trim()) lines.push('', `📄 ${name}`, '', md)
  }
  return lines.join('\n')
}

export function renderMarketBrief(env: TaskEnvelope): string {
  const lines = [envelopeTitle(env, '市场简报')]
  if (env.status !== 'done') return lines.join('\n')
  const s = signalOf(env)
  if (s?.summary && typeof s.summary === 'string') lines.push('', s.summary)
  if (Array.isArray(s?.opportunities)) {
    lines.push('', '**机会点**')
    ;(s.opportunities as Row[]).forEach((o, i) => lines.push(`${i + 1}. ${o.title ?? JSON.stringify(o)}`))
  }
  const rep = reportsOf(env)
  for (const [name, md] of Object.entries(rep)) {
    if (typeof md === 'string' && md.trim()) lines.push('', `📄 ${name}`, '', md)
  }
  return lines.join('\n')
}

export function renderBacktest(env: TaskEnvelope): string {
  const lines = [envelopeTitle(env, '历史决策回测')]
  if (env.status !== 'done') return lines.join('\n')
  const r = resultOf(env)
  if (r) {
    if (r.summary) lines.push('', `**summary**\n\n${JSON.stringify(r.summary, null, 1)}`)
    if (r.n_results != null) lines.push(`\n回测决策 ${r.n_results} 条`)
    if (r.params) lines.push(`\n参数：${JSON.stringify(r.params)}`)
  }
  return lines.join('\n')
}

export function renderStrategyRun(env: TaskEnvelope): string {
  const lines = [envelopeTitle(env, '策略回测')]
  if (env.status !== 'done') return lines.join('\n')
  const r = resultOf(env)
  if (r) {
    lines.push(`策略 ${r.strategy_id} → **${r.status ?? '-'}**`)
    const bt = r.backtest as Row | undefined
    if (bt) {
      if (bt.in_sample) lines.push(`样本内：${JSON.stringify(bt.in_sample)}`)
      if (bt.out_of_sample) lines.push(`样本外：${JSON.stringify(bt.out_of_sample)}`)
      if (bt.reason) lines.push(`\n${bt.reason}`)
    }
    if (r.symbol_errors) lines.push(`\n逐股错误：${JSON.stringify(r.symbol_errors)}`)
  }
  return lines.join('\n')
}

export function renderShadowRun(env: TaskEnvelope): string {
  const lines = [envelopeTitle(env, '影子验证')]
  if (env.status !== 'done') return lines.join('\n')
  const r = resultOf(env)
  if (r) {
    if (r.skipped) return `${lines[0]}\n\n跳过：${r.reason ?? ''}（交易日 ${r.trade_date ?? ''}）`
    lines.push(`交易日 ${r.trade_date ?? ''} ｜ 组合净值 ${r.overall_nav ?? '-'}`)
    const strategies = r.strategies as Row | undefined
    if (strategies) {
      for (const [sid, snap] of Object.entries(strategies)) {
        const s = snap as Row
        lines.push(`- ${s.name ?? sid}（${s.kind ?? ''}）nav=${s.nav ?? '-'} 权益=${s.equity ?? '-'} 平仓=${s.closed_count ?? 0}`)
      }
    }
    if (r.strategy_errors) lines.push(`\n错误：${JSON.stringify(r.strategy_errors)}`)
  }
  return lines.join('\n')
}

export function renderTaskStatus(v: Row): string {
  return `task ${v.task_id ?? '-'} ｜ ${v.task_type ?? '?'} ｜ **${v.status ?? '?'}**${v.error ? `\n\n❌ ${v.error}` : ''}`
}

// ---- 同步渲染 -------------------------------------------------------------

export function renderWatchlist(v: Row): string {
  const tks = (v.tickers as string[] | undefined) ?? []
  return tks.length ? `**自选（${tks.length}）**\n\n${tks.map((t) => `- ${t}`).join('\n')}` : '**自选列表为空**'
}

export function renderHoldings(v: Row): string {
  const items = (v.items as Row[] | undefined) ?? []
  if (!items.length) return '**暂无持仓**'
  const lines = items.map((h, i) => {
    const qty = h.quantity ?? '-'
    const cost = h.cost_price ?? '-'
    return `${i + 1}. ${h.name ?? h.ticker}（${h.ticker ?? ''}）${qty}股 @ ${cost}`
  })
  return `**持仓（${items.length}）**\n\n${lines.join('\n')}`
}

export function renderStrategies(v: Row): string {
  const items = (v.items as Row[] | undefined) ?? []
  if (!items.length) return '**暂无策略**'
  const lines = items.map((s, i) => {
    const ev = s.evolve as Row | undefined
    const life = ev?.state ? ` ｜ 进化:${ev.state}` : ''
    return `${i + 1}. ${s.name ?? s.id ?? ''}（${s.kind ?? ''}）→ ${s.status ?? ''} ｜ ${s.direction ?? '-'}${life}`
  })
  return `**策略池（${items.length}${v.count != null ? `/${v.count}` : ''}）**\n\n${lines.join('\n')}`
}

export function renderShadowStatus(v: Row): string {
  return `影子状态：交易日 ${v.trade_date ?? '-'} ｜ ${v.strategy_count ?? 0} 个策略 ｜ 组合净值 ${v.overall_nav ?? '-'}（ran_at ${v.ran_at ?? ''}）`
}

const SEV: Record<string, string> = { 高: '🔴', 中: '🟡', 低: '⚪' }

export function renderRiskAlerts(v: Row): string {
  const items = (v.items as Row[] | undefined) ?? []
  const head = `**风险预警（${v.count ?? items.length}）** ｜ 画像 ${v.profile_label ?? v.profile ?? ''}${typeof v.effect === 'string' ? ` ｜ ${v.effect}` : ''}`
  if (!items.length) return `${head}\n\n当前无风险预警。`
  const lines = items.map((it) => {
    const sev = String(it.severity ?? '低')
    const src = it.source ? `[${it.source}]` : ''
    return `${SEV[sev] ?? '·'} ${src} ${it.title ?? ''}（${sev}）${it.detail ? `\n   ${it.detail}` : ''}`
  })
  return `${head}\n\n${lines.join('\n')}`
}

export function renderNewsCards(v: Row): string {
  const cards = (v.cards as Row[] | undefined) ?? []
  const head = `**个性化卡片（${cards.length}）** ｜ 画像 ${v.profile_label ?? v.profile ?? ''} ｜ 有效进取度 ${v.effective_aggression ?? '-'}`
  if (!cards.length) return `${head}\n\n暂无卡片。`
  const lines = cards.map((c, i) => {
    const bucket = c.bucket ? `[${c.bucket}]` : ''
    return `${i + 1}. ${bucket} ${c.title ?? ''}${c.reason ? `\n   ${c.reason}` : ''}`
  })
  return `${head}\n\n${lines.join('\n')}`
}

export function renderPersonalizedProfile(v: Row): string {
  const b = (v.behavior as Row | undefined) ?? {}
  const lines = [
    `**行为画像** ｜ 问卷 ${v.base_profile ?? '-'}（${v.profile_label ?? ''}）`,
    `有效进取度：${v.effective_aggression ?? '-'}（基线 ${v.base_aggression ?? '-'}）`,
    `行为窗口：${b.window_hours ?? '-'}h，views=${b.views ?? 0} clicks=${b.clicks ?? 0}`,
    `关注标的：${(b.focus_tickers as string[] | undefined)?.join(' / ') || '-'}`,
  ]
  if (b.direction_skew != null) lines.push(`方向偏斜（利空点击占 ${pct(b.direction_skew)}）`)
  const notes = (v.notes as string[] | undefined) ?? []
  if (notes.length) lines.push('', notes.map((n) => `- ${n}`).join('\n'))
  return lines.join('\n')
}

export function renderEvolutionStatus(v: Row): string {
  const ready = v.ready ? '就绪' : '数据不足'
  return `**自进化状态** ｜ ${ready}（${v.days_of_data ?? 0}/${v.min_days ?? '-'} 交易日）\n\n${v.note ?? ''}${v.counts ? `\n\n${JSON.stringify(v.counts)}` : ''}`
}

export function renderEvolutionAttribution(v: Row): string {
  const lines = [`**进化归因** ｜ 数据 ${v.days_of_data ?? 0} 日（≥${v.min_days ?? '-'}）`]
  if (v.data_note) lines.push(String(v.data_note))
  if (v.overall) lines.push(`\n整体：${JSON.stringify(v.overall)}`)
  if (v.strategies) lines.push(`\n分策略：${JSON.stringify(v.strategies)}`)
  return lines.join('\n')
}

export function renderLatestBrief(v: Row): string {
  return `**${v.period ?? 'latest'} 简报（${v.trade_date ?? ''}）**${v.dsh_pushed ? ' 已推送' : ''}\n\n${typeof v.summary === 'string' ? v.summary : JSON.stringify(v)}`
}

export function renderRiskProfile(v: Row): string {
  return `风险偏好：**${v.risk_profile ?? '-'}**（${v.label ?? ''}）`
}

export function renderSaved(v: Row): string {
  return `✅ 已保存 ${v.saved ?? 0} 条`
}
