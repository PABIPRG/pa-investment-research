import { useCallback, useEffect, useMemo, useState } from 'react'
import { asRecord, number, records, text } from './data.ts'
import type { StrategyEvolutionDiagnosticsProps } from './evolution-types.ts'
import {
  evolutionSemanticLabels,
  evolutionSemanticSummary,
  formatEvolutionTimestamp,
} from './evolution-types.ts'
import css from './InvestmentShell.module.css'

// 变异是来源标记（source/mutated_from）而非独立分组；mutated 保留为防御性兜底。
const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  active: '正常运行', candidate: '候选', mutated: '变异来源', retired: '已淘汰', watch: '观察中', rejected: '已拒绝',
}

const LIFECYCLE_PRIORITY = ['retired', 'rejected', 'watch', 'candidate', 'active'] as const

const DECISION_LABELS: Readonly<Record<string, string>> = {
  promote: '升级', demote: '降级观察', retire: '已淘汰/已退役', mutate: '生成变体', none: '正常运行',
}

function strategyId(value: Record<string, unknown>): string {
  return text(value.strategy_id, text(value.sid, text(value.id, '')))
}

function metric(value: unknown, suffix = ''): string {
  const resolved = number(value)
  return resolved === undefined ? '—' : `${resolved.toFixed(2)}${suffix}`
}

/** 策略研究第 4 步：固定单策略、只读重新评估，由统一闭环执行所有动作。 */
export function StrategyEvolutionDiagnostics({
  requestData,
  strategyId: selectedStrategyId,
  strategyLabel,
  strategyStatus,
  archived = false,
  onAnalyze,
  onBack,
  onOpenStock = () => {},
}: StrategyEvolutionDiagnosticsProps) {
  const [status, setStatus] = useState<unknown>()
  const [attribution, setAttribution] = useState<unknown>()
  const [strategyDetail, setStrategyDetail] = useState<unknown>()
  const [strategyFactsUnavailable, setStrategyFactsUnavailable] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    setStrategyFactsUnavailable(false)
    const input = { strategy_id: selectedStrategyId }
    void Promise.all([
      requestData({ operation: 'trading-core.evolution-status', input }),
      requestData({ operation: 'trading-core.evolution-attribution', input }),
      requestData({ operation: 'trading-core.strategy-detail', input }).catch(() => {
        setStrategyFactsUnavailable(true)
        return undefined
      }),
    ]).then(([nextStatus, nextAttribution, nextStrategyDetail]) => {
      setStatus(nextStatus)
      setAttribution(nextAttribution)
      setStrategyDetail(nextStrategyDetail)
    }).catch(() => {
      setError('投研服务暂时不可用，请稍后重试。')
    }).finally(() => { setLoading(false) })
  }, [requestData, selectedStrategyId])

  useEffect(load, [load])

  const statusRecord = asRecord(status)
  const attributionRecord = asRecord(attribution)
  const lifecycle = asRecord(statusRecord.lifecycle)
  const scopedDecision = records(statusRecord.per_strategy).find(item => strategyId(item) === selectedStrategyId) ?? {}
  const scopedAttribution = records(attributionRecord.strategies).find(item => strategyId(item) === selectedStrategyId) ?? {}
  const relationEntries = useMemo(() => {
    const entries = new Map<string, Record<string, unknown>>()
    for (const group of LIFECYCLE_PRIORITY) {
      for (const raw of records(lifecycle[group])) {
        const sid = strategyId(raw)
        if (sid === '') continue
        if (!entries.has(sid)) {
          entries.set(sid, { ...raw, lifecycle_group: group })
        }
      }
    }
    return entries
  }, [lifecycle])
  const lifecycleGroup = useMemo(() => {
    for (const group of LIFECYCLE_PRIORITY) {
      const values = lifecycle[group]
      if (records(values).some(item => strategyId(item) === selectedStrategyId)) return group
    }
    return strategyStatus
  }, [lifecycle, selectedStrategyId, strategyStatus])
  const lifecycleEntry = relationEntries.get(selectedStrategyId) ?? {}
  const mergedFacts = { ...lifecycleEntry, ...asRecord(strategyDetail), ...scopedDecision }
  const labels = evolutionSemanticLabels(mergedFacts, lifecycleGroup)
  const semanticSummary = evolutionSemanticSummary(labels)
  const hasScopedEvidence = strategyId(scopedDecision) !== ''
    || strategyId(scopedAttribution) !== ''
    || strategyId(lifecycleEntry) !== ''
  const symbols = Array.isArray(lifecycleEntry.symbols)
    ? lifecycleEntry.symbols.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
  const history = records(statusRecord.recent_applied).flatMap(round => records(round.actions)
    .filter(action => strategyId(action) === selectedStrategyId || text(action.parent, '') === selectedStrategyId)
    .map(action => ({ round, action })))
  const canReevaluate = lifecycleGroup === 'active' && hasScopedEvidence && !archived

  return (
    <section className={css.evolutionDiagnostics} aria-label="单策略进化诊断">
      <div className={css.pageHeader}>
        <div><h2>{strategyLabel} · 进化诊断</h2><p>查看当前策略判定并按最新证据重新评估；动作由统一闭环执行。</p></div>
        <div>
          <button type="button" className={css.secondaryButton} onClick={onBack}>返回自进化看板</button>
          {canReevaluate && <button type="button" className={css.secondaryButton} disabled={loading} onClick={load}>重新评估</button>}
          <button type="button" className={css.secondaryButton} onClick={() => { onAnalyze({ kind: 'evolution', strategyId: selectedStrategyId, semanticSummary }) }}>AI 解释当前判定</button>
        </div>
      </div>
      {loading && status === undefined && <div className={css.loadingSkeleton} aria-label="正在读取策略诊断"><span /><span /><span /></div>}
      {error !== '' && <div className={css.errorCard} role="alert"><strong>策略诊断暂不可用</strong><p>{error}</p></div>}
      {strategyFactsUnavailable && <div className={css.noticeCard} role="status">策略验证、来源和任务字段暂不可用；当前判定与影子证据仍可查看。</div>}
      {!loading && error === '' && !hasScopedEvidence && <div className={css.emptyPanel}>目标策略证据暂不可读取，未使用其他策略或全局数据替代。</div>}
      {hasScopedEvidence && <>
      <section className={css.moduleGrid} aria-label="诊断摘要">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>当前判定</strong><span>{labels.participation}</span></div>
          <dl className={css.reportMeta}>
            <div><dt>预计动作</dt><dd>{DECISION_LABELS[text(scopedDecision.decision, 'none')] ?? text(scopedDecision.behavior, '正常运行')}</dd></div>
            <div><dt>证据时点</dt><dd>{formatEvolutionTimestamp(statusRecord.as_of, '未返回')}</dd></div>
            <div><dt>下次自动运行</dt><dd>{statusRecord.closed_loop_enabled === true ? formatEvolutionTimestamp(statusRecord.next_scheduled_run_at, `每日 ${text(statusRecord.closed_loop_time, '15:35')}（服务本地时间）`) : '自动闭环未启用'}</dd></div>
          </dl>
          <div className={css.evolutionFacts} aria-label="策略五维状态">
            <span>{`参与状态：${labels.participation}`}</span>
            <span>{`验证结果：${labels.verification}`}</span>
            <span>{`置信等级：${labels.confidence}`}</span>
            <span>{`来源：${labels.source}`}</span>
            <span>{`任务状态：${labels.task}`}</span>
          </div>
          {labels.source === '变异来源' && <p className={css.evolutionMutationSource}>变异来源：{text(mergedFacts.mutated_from, text(asRecord(mergedFacts.evolve).mutated_from, '未返回母策略'))}</p>}
          <p>阈值理由：{text(scopedDecision.reason, '后端尚未返回判定理由。')}</p>
        </article>
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>影子证据</strong><span>只读</span></div>
          <dl className={css.reportMeta}>
            <div><dt>影子净值</dt><dd>{metric(scopedDecision.nav)}</dd></div>
            <div><dt>累计收益</dt><dd>{metric(scopedAttribution.return_pct, '%')}</dd></div>
            <div><dt>最大回撤</dt><dd>{metric(scopedAttribution.max_drawdown_pct, '%')}</dd></div>
            <div><dt>平仓胜率</dt><dd>{metric(scopedDecision.closed_win_rate_pct, '%')}</dd></div>
          </dl>
        </article>
      </section>
      <section className={css.moduleGrid} aria-label="策略关系与历史">
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>母子链</strong><span>{text(lifecycleEntry.mutated_from, '') === '' ? '根策略' : '衍生策略'}</span></div>
          <p>母策略：{text(lifecycleEntry.mutated_from, '无')}</p>
          <div className={css.dataList}>{[...relationEntries.values()].filter(entry => {
            const sid = strategyId(entry)
            return sid === selectedStrategyId
              || text(entry.mutated_from, '') === selectedStrategyId
              || text(lifecycleEntry.mutated_from, '') === sid
          }).map(entry => {
            const sid = strategyId(entry)
            const relation = sid === selectedStrategyId
              ? '当前策略'
              : text(entry.mutated_from, '') === selectedStrategyId ? '子策略' : '母策略'
            const group = text(entry.lifecycle_group, '')
            return <div className={css.dataRow} key={sid}><div><strong>{text(entry.name, sid)}</strong><small>{sid}</small></div><span>{relation} · {LIFECYCLE_LABELS[group] ?? group}</span></div>
          })}</div>
          <div className={css.strategyDetailSymbols}>{symbols.map(code => <button type="button" className={css.strategySymbolChip} key={code} onClick={() => { onOpenStock(code) }}>{code}</button>)}</div>
        </article>
        <article className={css.moduleCard}>
          <div className={css.sectionHeading}><strong>最近自动应用</strong><span>{history.length} 条</span></div>
          <div className={css.dataList}>{history.map(({ round, action }, index) => <div className={css.dataRow} key={`${text(round.applied_at)}-${index}`}><div><strong>{text(round.applied_at, '时间未返回')}</strong><small>{text(action.reason, '')}</small></div><span>{DECISION_LABELS[text(action.type, '')] ?? text(action.type, '')}</span></div>)}</div>
          {history.length === 0 && !loading && <div className={css.emptyPanel}>该策略暂无自动应用历史。</div>}
        </article>
      </section>
      </>}
    </section>
  )
}
