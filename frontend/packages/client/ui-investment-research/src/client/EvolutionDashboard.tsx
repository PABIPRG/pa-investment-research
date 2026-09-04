import { useCallback, useEffect, useMemo, useState } from 'react'
import { asRecord, number, records, text } from './data.ts'
import type { EvolutionDashboardProps, EvolutionLifecycleGroup } from './evolution-types.ts'
import {
  evolutionSemanticLabels,
  formatEvolutionTimestamp,
} from './evolution-types.ts'
import { useSecurityNames } from './security-names.ts'
import { strategyEvolutionLabel, strategyTickers } from './strategy-display.ts'
import css from './InvestmentShell.module.css'

// 变异是来源标记（source/mutated_from）而非独立分组：策略按真实状态落桶。mutated 保留为防御性兜底。
const GROUPS: readonly EvolutionLifecycleGroup[] = [
  'active', 'watch', 'candidate', 'retired', 'rejected',
]

const GROUP_LABELS: Readonly<Record<string, string>> = {
  active: '正常运行', candidate: '候选', retired: '已淘汰', watch: '观察中', rejected: '已拒绝',
}

const DECISION_LABELS: Readonly<Record<string, string>> = {
  promote: '已升级', demote: '观察中', retire: '已淘汰', mutate: '生成变体', none: '正常运行',
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
}

function strategyId(value: Record<string, unknown>): string {
  return text(value.strategy_id, text(value.sid, text(value.id, '')))
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
  readonly labelFor: (entry: Record<string, unknown>) => string
}

function LineageNode({ sid, entries, children, onOpenStrategy, returnGroup, labelFor }: LineageNodeProps) {
  const entry = entries.get(sid)
  if (entry === undefined) return null
  return (
    <div className={css.lineageNode}>
      <button type="button" className={css.lineageLabel} onClick={() => { onOpenStrategy(sid, returnGroup) }}>
        <strong>{labelFor(entry)}</strong>
        <span>{GROUP_LABELS[text(entry.lifecycle_group, '')] ?? text(entry.lifecycle_group, '')}</span>
      </button>
      {(children.get(sid) ?? []).length > 0 && (
        <div className={css.lineageChildren}>
          {(children.get(sid) ?? []).map(child => (
            <LineageNode
              key={child}
              sid={child}
              entries={entries}
              children={children}
              onOpenStrategy={onOpenStrategy}
              returnGroup={returnGroup}
              labelFor={labelFor}
            />
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
  const [strategies, setStrategies] = useState<unknown>()
  const [strategyFactsUnavailable, setStrategyFactsUnavailable] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [openGroup, setOpenGroup] = useState<EvolutionLifecycleGroup>(initialLifecycleGroup)

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    setStrategyFactsUnavailable(false)
    void Promise.all([
      requestData({ operation: 'trading-core.evolution-status' }),
      requestData({ operation: 'trading-core.evolution-attribution' }),
      requestData({ operation: 'trading-core.strategies', input: { limit: 500 } }).catch(() => {
        setStrategyFactsUnavailable(true)
        return { items: [] }
      }),
    ]).then(([nextStatus, nextAttribution, nextStrategies]) => {
      setStatus(nextStatus)
      setAttribution(nextAttribution)
      setStrategies(nextStrategies)
    }).catch(() => {
      setError('投研服务暂时不可用，请稍后重试。')
    }).finally(() => { setLoading(false) })
  }, [requestData])

  useEffect(load, [load])

  const statusRecord = asRecord(status)
  const attributionRecord = asRecord(attribution)
  const strategyRecords = records(asRecord(strategies).items)
  const strategyById = new Map(strategyRecords.map(entry => [strategyId(entry), entry]))
  const lifecycle = asRecord(statusRecord.lifecycle)
  const counts = asRecord(statusRecord.counts)
  const evolutionCounts = asRecord(statusRecord.evolution_counts)
  const perStrategy = records(statusRecord.per_strategy)
  const attributionByStrategy = new Map(records(attributionRecord.strategies).map(entry => [strategyId(entry), entry]))
  const recentApplied = records(statusRecord.recent_applied)
  const overall = asRecord(attributionRecord.overall)
  const closedLoopEnabled = statusRecord.closed_loop_enabled === true
  const closedLoopTime = text(statusRecord.closed_loop_time, '15:35')
  const lifecycleEntries = openGroup === '' ? [] : records(lifecycle[openGroup])
  const mutationEntries = records(lifecycle.mutated)
  const lifecycleByStrategy = new Map<string, { entry: Record<string, unknown>; status: string }>()
  for (const group of ['candidate', 'active', 'watch', 'retired', 'rejected'] as const) {
    for (const entry of records(lifecycle[group])) {
      const sid = strategyId(entry)
      if (sid !== '') lifecycleByStrategy.set(sid, { entry, status: group })
    }
  }
  const mutationByStrategy = new Map(mutationEntries.map(entry => [strategyId(entry), entry]))
  const statusSummary = Object.keys(evolutionCounts).length > 0 ? evolutionCounts : counts
  const strategyCodes = [...new Set([
    ...strategyRecords, ...perStrategy,
    ...GROUPS.flatMap(group => records(lifecycle[group])),
  ].flatMap(entry => strategyTickers(entry).map(ticker => ticker.code)))]
  const securityNames = useSecurityNames(requestData, strategyCodes)
  const strategyLabel = useCallback((entry: Record<string, unknown>): string => {
    const sid = strategyId(entry)
    return strategyEvolutionLabel({ ...strategyById.get(sid), ...entry }, securityNames)
  }, [securityNames, strategyById])

  const lineage = useMemo(() => {
    const entries = new Map<string, Record<string, unknown>>()
    for (const group of GROUPS) {
      for (const raw of records(lifecycle[group])) {
        const sid = strategyId(raw)
        if (sid !== '') entries.set(sid, { ...raw, lifecycle_group: group })
      }
    }
    for (const raw of records(lifecycle.mutated)) {
      const sid = strategyId(raw)
      if (sid !== '' && !entries.has(sid)) entries.set(sid, { ...raw, lifecycle_group: 'mutated' })
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
    const roots = [...visible].filter((sid) => {
      const parent = text(entries.get(sid)?.mutated_from, '')
      return parent === '' || !visible.has(parent)
    })
    return { entries, children, roots }
  }, [lifecycle])

  return (
    <div className={`${css.pageScroll} ${css.evolutionDashboard}`}>
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
      {strategyFactsUnavailable && <div className={css.noticeCard} role="status">策略验证、来源和任务字段暂不可用；闭环状态与影子证据仍可查看。</div>}
      {loading && status === undefined && <div className={css.loadingSkeleton} aria-label="正在读取进化状态"><span /><span /><span /></div>}

      <section className={`${css.moduleCard} ${css.evolutionLineageOverview}`} aria-label="演化关系">
        <div className={css.sectionHeading}>
          <div>
            <strong>策略演化链路</strong>
            <small>优先展示自动进化产生的策略衍生及其母链</small>
          </div>
          <span>{mutationEntries.length > 0 ? `${mutationEntries.length} 个变体` : '尚无变体'}</span>
        </div>
        {mutationEntries.length === 0
          ? <div className={css.evolutionLead} data-state="empty"><strong>尚未发生自动进化</strong><span>当影子数据和诊断证据达标后，这里会展示母策略与衍生策略的关系。</span></div>
          : <div className={css.evolutionLead} data-state="evolved"><strong>已记录 {mutationEntries.length} 个衍生变体</strong><span>仅展示当前正常运行的策略及其母链，点击节点可进入诊断。</span></div>}
        <div className={css.lineageTree}>{lineage.roots.map(sid => (
          <LineageNode
            key={sid}
            sid={sid}
            entries={lineage.entries}
            children={lineage.children}
            onOpenStrategy={onOpenStrategy}
            returnGroup={openGroup}
            labelFor={strategyLabel}
          />
        ))}</div>
        {lineage.roots.length === 0 && mutationEntries.length > 0 && !loading && <div className={css.emptyPanel}>已有变体记录，但当前没有处于正常运行状态的演化链路。</div>}
      </section>

      <section className={css.evolutionOverviewGrid} aria-label="运行概览">
        <article className={`${css.moduleCard} ${css.evolutionRuntimeCard}`} role="region" aria-label="运行状态摘要">
          <div className={css.sectionHeading}><strong>闭环运行状态</strong><span>{closedLoopEnabled ? `每日 ${closedLoopTime}` : '未启用'}</span></div>
          <dl className={css.evolutionRuntimeMeta}>
            <div><dt>最近自动运行</dt><dd>{formatEvolutionTimestamp(statusRecord.recent_run_at, '尚无运行记录')}</dd></div>
            <div><dt>下次计划运行</dt><dd>{closedLoopEnabled ? formatEvolutionTimestamp(statusRecord.next_scheduled_run_at, `每日 ${closedLoopTime}（服务本地时间）`) : '自动闭环未启用'}</dd></div>
            <div><dt>上次自动应用</dt><dd>{formatEvolutionTimestamp(statusRecord.last_applied_at, '尚未应用')}</dd></div>
            <div><dt>数据完成度</dt><dd>{number(statusRecord.days_of_data)?.toFixed(0) ?? '—'} / {number(statusRecord.min_days)?.toFixed(0) ?? '—'} 日</dd></div>
          </dl>
        </article>
        <article className={`${css.moduleCard} ${css.evolutionAttributionCard}`} aria-label="整体影子归因">
          <div className={css.sectionHeading}><strong>整体影子归因</strong><span>{number(attributionRecord.days_of_data)?.toFixed(0) ?? '0'} 日</span></div>
          <dl className={css.evolutionRuntimeMeta}>
            <div><dt>累计收益</dt><dd>{metric(overall.return_pct, '%')}</dd></div>
            <div><dt>最大回撤</dt><dd>{metric(overall.max_drawdown_pct, '%')}</dd></div>
            <div><dt>当前净值</dt><dd>{metric(overall.end_nav)}</dd></div>
          </dl>
        </article>
      </section>

      <section className={`${css.moduleCard} ${css.evolutionDistribution}`} aria-label="策略状态分布">
        <div className={css.sectionHeading}>
          <div><strong>策略状态分布</strong><small>选择状态查看对应策略，明细区限高滚动</small></div>
          <span>{perStrategy.length} 项当前判定</span>
        </div>
          <dl className={css.evolutionStatusSummary} data-testid="evolution-status-summary">
            <div><dt>正常运行</dt><dd>{number(statusSummary.normal)?.toFixed(0) ?? '—'}</dd></div>
            <div><dt>观察中</dt><dd>{number(statusSummary.watch)?.toFixed(0) ?? '—'}</dd></div>
            <div><dt>已升级</dt><dd>{number(statusSummary.promote)?.toFixed(0) ?? '—'}</dd></div>
            <div><dt>已淘汰</dt><dd>{number(statusSummary.retire)?.toFixed(0) ?? '—'}</dd></div>
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
          {openGroup !== '' && <div className={`${css.lifecycleList} ${css.evolutionLifecycleList}`} role="region" aria-label={`${GROUP_LABELS[openGroup]}策略列表`} tabIndex={0}>
            {lifecycleEntries.map((entry, index) => {
              const sid = strategyId(entry)
              const isVariant = text(entry.source, '') === 'evolution' || text(entry.mutated_from, '') !== ''
              return <button type="button" className={css.dataRow} key={`${sid}-${index}`} onClick={() => { if (sid !== '') onOpenStrategy(sid, openGroup) }}><div><strong>{strategyLabel(entry)}</strong></div><span>{GROUP_LABELS[openGroup]}{isVariant ? ' · 变异' : ''}</span></button>
            })}
            {lifecycleEntries.length === 0 && <div className={css.emptyPanel}>该类目暂无策略。</div>}
          </div>}
      </section>

      <section className={css.moduleGrid} aria-label="策略现状与诊断">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><div><strong>策略现状与诊断</strong><small>诊断承接回测与影子验证证据，点击策略进入完整诊断</small></div><span>{perStrategy.length} 项</span></div>
          <div className={css.dataList}>
            {perStrategy.map((entry, index) => {
              const sid = strategyId(entry)
              const reason = text(entry.reason, '暂无判定依据')
              const strategyAttribution = attributionByStrategy.get(sid) ?? {}
              const symbols = strings(entry.symbols).length > 0 ? strings(entry.symbols) : strings(strategyAttribution.symbols)
              const lifecycleState = lifecycleByStrategy.get(sid)
              const mutationEntry = mutationByStrategy.get(sid)
              const strategyFacts = strategyById.get(sid) ?? {}
              const mergedFacts = { ...lifecycleState?.entry, ...strategyFacts, ...entry }
              const mutationSource = text(mergedFacts.mutated_from, text(mutationEntry?.mutated_from, text(asRecord(mergedFacts.evolve).mutated_from, '')))
              const labels = evolutionSemanticLabels(mergedFacts, lifecycleState?.status ?? '')
              const displayLabel = strategyLabel(mergedFacts)
              return <div className={css.strategyEntry} key={`${sid}-${index}`}>
                <button type="button" className={css.dataRow} aria-label={`${displayLabel} · ${reason}`} onClick={() => { if (sid !== '') onOpenStrategy(sid, openGroup) }}>
                  <div><strong>{displayLabel}</strong><small>{reason}</small></div>
                  <span className={css.evolutionStatusStack}>
                    <strong>{labels.participation}</strong>
                    <small>{labels.confidence}</small>
                  </span>
                </button>
                <div className={css.strategyDetail}>
                  {mutationSource !== '' && <span className={css.evolutionMutationSource}>变异来源：{mutationSource}</span>}
                  <dl className={css.evolutionFacts} aria-label={`${displayLabel}五维状态`}>
                    <div><dt>参与状态</dt><dd>{labels.participation}</dd></div>
                    <div><dt>验证结果</dt><dd>{labels.verification}</dd></div>
                    <div><dt>置信等级</dt><dd>{labels.confidence}</dd></div>
                    <div><dt>来源</dt><dd>{labels.source}</dd></div>
                    <div><dt>任务状态</dt><dd>{labels.task}</dd></div>
                  </dl>
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

      <section className={css.moduleGrid} aria-label="历史进化动作">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><div><strong>历史进化动作</strong><small>按自动闭环执行轮次保留可追溯记录</small></div><span>{recentApplied.length} 条</span></div>
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
