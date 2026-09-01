import { useCallback, useEffect, useMemo, useState } from 'react'
import { asRecord, number, records, text } from './data.ts'
import type { EvolutionDashboardProps, EvolutionLifecycleGroup } from './evolution-types.ts'
import css from './InvestmentShell.module.css'

const GROUPS: readonly EvolutionLifecycleGroup[] = [
  'active', 'candidate', 'mutated', 'retired', 'watch', 'rejected',
]

const GROUP_LABELS: Readonly<Record<string, string>> = {
  active: '生效', candidate: '候选', mutated: '变体', retired: '退役', watch: '观察', rejected: '拒绝',
}

const DECISION_LABELS: Readonly<Record<string, string>> = {
  promote: '升级', demote: '降级观察', retire: '退役', mutate: '生成变体', none: '带内运行',
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
}

function strategyId(value: Record<string, unknown>): string {
  return text(value.strategy_id, text(value.sid, text(value.id, '')))
}

function strategyName(value: Record<string, unknown>): string {
  return text(value.name, strategyId(value) || '未命名策略')
}

function metric(value: unknown, suffix = ''): string {
  const resolved = number(value)
  return resolved === undefined ? '—' : `${resolved.toFixed(2)}${suffix}`
}

interface LineageNodeProps {
  readonly sid: string
  readonly entries: ReadonlyMap<string, Record<string, unknown>>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly onOpenStrategy: EvolutionDashboardProps['onOpenStrategy']
  readonly returnGroup: EvolutionLifecycleGroup
}

function LineageNode({ sid, entries, children, onOpenStrategy, returnGroup }: LineageNodeProps) {
  const entry = entries.get(sid)
  if (entry === undefined) return null
  return (
    <div className={css.lineageNode}>
      <button type="button" className={css.lineageLabel} onClick={() => { onOpenStrategy(sid, returnGroup) }}>
        <strong>{strategyName(entry)}</strong>
        <span>{GROUP_LABELS[text(entry.lifecycle_group, '')] ?? text(entry.lifecycle_group, '')}</span>
      </button>
      {(children.get(sid) ?? []).length > 0 && (
        <div className={css.lineageChildren}>
          {(children.get(sid) ?? []).map(child => (
            <LineageNode key={child} sid={child} entries={entries} children={children} onOpenStrategy={onOpenStrategy} returnGroup={returnGroup} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 全局只读自进化观测看板。所有进化写入均由统一自动闭环负责。 */
export function EvolutionDashboard({
  requestData,
  onAnalyze,
  onOpenStrategy,
  onOpenStock = () => {},
  initialLifecycleGroup = '',
}: EvolutionDashboardProps) {
  const [status, setStatus] = useState<unknown>()
  const [attribution, setAttribution] = useState<unknown>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [openGroup, setOpenGroup] = useState<EvolutionLifecycleGroup>(initialLifecycleGroup)

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    void Promise.all([
      requestData({ operation: 'trading-core.evolution-status' }),
      requestData({ operation: 'trading-core.evolution-attribution' }),
    ]).then(([nextStatus, nextAttribution]) => {
      setStatus(nextStatus)
      setAttribution(nextAttribution)
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setLoading(false) })
  }, [requestData])

  useEffect(load, [load])

  const statusRecord = asRecord(status)
  const attributionRecord = asRecord(attribution)
  const lifecycle = asRecord(statusRecord.lifecycle)
  const counts = asRecord(statusRecord.counts)
  const perStrategy = records(statusRecord.per_strategy)
  const attributionByStrategy = new Map(records(attributionRecord.strategies).map(entry => [strategyId(entry), entry]))
  const recentApplied = records(statusRecord.recent_applied)
  const overall = asRecord(attributionRecord.overall)
  const closedLoopEnabled = statusRecord.closed_loop_enabled === true
  const closedLoopTime = text(statusRecord.closed_loop_time, '15:35')
  const lifecycleEntries = openGroup === '' ? [] : records(lifecycle[openGroup])

  const lineage = useMemo(() => {
    const entries = new Map<string, Record<string, unknown>>()
    for (const group of GROUPS) {
      for (const raw of records(lifecycle[group])) {
        const sid = strategyId(raw)
        if (sid !== '') entries.set(sid, { ...raw, lifecycle_group: group })
      }
    }
    const visible = new Set<string>()
    for (const raw of records(lifecycle.active)) {
      let sid = strategyId(raw)
      while (sid !== '' && !visible.has(sid)) {
        visible.add(sid)
        sid = text(entries.get(sid)?.mutated_from, '')
      }
    }
    const children = new Map<string, string[]>()
    for (const sid of visible) {
      const parent = text(entries.get(sid)?.mutated_from, '')
      if (parent === '' || !visible.has(parent)) continue
      children.set(parent, [...(children.get(parent) ?? []), sid])
    }
    const roots = [...visible].filter(sid => {
      const parent = text(entries.get(sid)?.mutated_from, '')
      return parent === '' || !visible.has(parent)
    })
    return { entries, children, roots }
  }, [lifecycle])

  return (
    <div className={css.pageScroll}>
      <div className={css.pageHeader}>
        <div>
          <h1>{closedLoopEnabled ? '自进化 · 自动闭环' : '自进化 · 闭环看板'}</h1>
          <p>{closedLoopEnabled
            ? '系统按计划统一执行影子验证、归因、进化应用与候选验证；正在每日自动运行。'
            : '自动闭环未启用；当前仅展示已有证据、判定与执行历史。'}</p>
        </div>
        <div>
          <button type="button" className={css.secondaryButton} onClick={load}>刷新</button>
          <button type="button" className={css.secondaryButton} onClick={() => { onAnalyze({ kind: 'evolution' }) }}>AI 解释当前判定</button>
        </div>
      </div>
      {error !== '' && <div className={css.errorCard} role="alert"><strong>真实数据暂不可用</strong><p>{error}</p><button type="button" onClick={load}>重试</button></div>}
      {loading && status === undefined && <div className={css.loadingSkeleton} aria-label="正在读取进化状态"><span /><span /><span /></div>}

      <section className={css.moduleGrid} aria-label="闭环状态与生命周期">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>闭环运行状态</strong><span>{closedLoopEnabled ? `每日 ${closedLoopTime}` : '未启用'}</span></div>
          <dl className={css.reportMeta}>
            <div><dt>上次自动应用</dt><dd>{text(statusRecord.last_applied_at, '尚未应用')}</dd></div>
            <div><dt>数据完成度</dt><dd>{number(statusRecord.days_of_data)?.toFixed(0) ?? '—'} / {number(statusRecord.min_days)?.toFixed(0) ?? '—'} 日</dd></div>
          </dl>
          <div className={css.lifecycleNav} aria-label="生命周期分组">
            {GROUPS.map(group => (
              <button
                type="button"
                key={group}
                data-active={openGroup === group || undefined}
                aria-expanded={openGroup === group}
                onClick={() => { setOpenGroup(openGroup === group ? '' : group) }}
              >
                <span>{GROUP_LABELS[group]}</span><strong>{number(counts[group])?.toFixed(0) ?? '0'}</strong>
              </button>
            ))}
          </div>
          {openGroup !== '' && <div className={css.lifecycleList}>
            {lifecycleEntries.map((entry, index) => {
              const sid = strategyId(entry)
              return <button type="button" className={css.dataRow} key={`${sid}-${index}`} onClick={() => { if (sid !== '') onOpenStrategy(sid, openGroup) }}><strong>{strategyName(entry)}</strong><span>{GROUP_LABELS[openGroup]}</span></button>
            })}
            {lifecycleEntries.length === 0 && <div className={css.emptyPanel}>该类目暂无策略。</div>}
          </div>}
        </article>
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>整体影子归因</strong><span>{number(attributionRecord.days_of_data)?.toFixed(0) ?? '0'} 日</span></div>
          <dl className={css.reportMeta}>
            <div><dt>累计收益</dt><dd>{metric(overall.return_pct, '%')}</dd></div>
            <div><dt>最大回撤</dt><dd>{metric(overall.max_drawdown_pct, '%')}</dd></div>
            <div><dt>当前净值</dt><dd>{metric(overall.end_nav)}</dd></div>
          </dl>
        </article>
      </section>

      <section className={css.moduleGrid} aria-label="策略现状">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>策略现状</strong><span>{perStrategy.length} 项</span></div>
          <div className={css.dataList}>
            {perStrategy.map((entry, index) => {
              const sid = strategyId(entry)
              const reason = text(entry.reason, '暂无判定依据')
              const strategyAttribution = attributionByStrategy.get(sid) ?? {}
              const symbols = strings(entry.symbols).length > 0 ? strings(entry.symbols) : strings(strategyAttribution.symbols)
              return <div className={css.strategyEntry} key={`${sid}-${index}`}>
                <button type="button" className={css.dataRow} aria-label={`${strategyName(entry)} · ${reason}`} onClick={() => { if (sid !== '') onOpenStrategy(sid, openGroup) }}><div><strong>{strategyName(entry)}</strong><small>{reason}</small></div><span>{DECISION_LABELS[text(entry.decision, '')] ?? text(entry.behavior, '带内运行')}</span></button>
                <div className={css.strategyDetail}>
                  <dl className={css.strategyDetailGrid}>
                    <div><dt>影子净值</dt><dd>{metric(entry.nav)}</dd></div>
                    <div><dt>累计收益</dt><dd>{metric(strategyAttribution.return_pct, '%')}</dd></div>
                    <div><dt>最大回撤</dt><dd>{metric(strategyAttribution.max_drawdown_pct, '%')}</dd></div>
                    <div><dt>成交数</dt><dd>{number(strategyAttribution.closed_trades)?.toFixed(0) ?? number(entry.closed_trades)?.toFixed(0) ?? '—'}</dd></div>
                    <div><dt>平仓胜率</dt><dd>{metric(strategyAttribution.closed_win_rate_pct ?? entry.closed_win_rate_pct, '%')}</dd></div>
                  </dl>
                  <div className={css.strategyDetailSymbols}>{symbols.map(code => <button type="button" className={css.strategySymbolChip} key={code} onClick={() => { onOpenStock(code) }}>{code}</button>)}</div>
                </div>
              </div>
            })}
            {perStrategy.length === 0 && !loading && <div className={css.emptyPanel}>暂无策略判定。</div>}
          </div>
        </article>
      </section>

      <section className={css.moduleGrid} aria-label="策略演化链路">
        <article className={`${css.moduleCard} ${css.lineageCard}`}>
          <div className={css.sectionHeading}><strong>策略演化链路</strong><span>仅生效策略及母链</span></div>
          <div className={css.lineageTree}>{lineage.roots.map(sid => <LineageNode key={sid} sid={sid} entries={lineage.entries} children={lineage.children} onOpenStrategy={onOpenStrategy} returnGroup={openGroup} />)}</div>
          {lineage.roots.length === 0 && !loading && <div className={css.emptyPanel}>暂无生效中的演化链路。</div>}
        </article>
      </section>

      <section className={css.moduleGrid} aria-label="最近自动进化">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>最近自动进化</strong><span>{recentApplied.length} 条</span></div>
          <div className={css.dataList}>
            {recentApplied.flatMap((round, roundIndex) => records(round.actions).map((action, actionIndex) => {
              const sid = strategyId(action)
              const label = `${text(round.applied_at, '')} · 自动应用 ${number(round.count)?.toFixed(0) ?? '0'} 项动作`
              return <button type="button" className={css.dataRow} key={`${roundIndex}-${actionIndex}`} aria-label={label} onClick={() => { if (sid !== '') onOpenStrategy(sid, openGroup) }}><div><strong>{label}</strong><small>{text(action.reason, '')}</small></div><span>{DECISION_LABELS[text(action.type, '')] ?? text(action.type, '')}</span></button>
            }))}
            {recentApplied.length === 0 && !loading && <div className={css.emptyPanel}>尚未有自动进化记录。</div>}
          </div>
        </article>
      </section>
    </div>
  )
}
