import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { asRecord, records, text } from './data.ts'
import type { EvolutionRequestData } from './evolution-types.ts'
import { evolutionParticipationLabel, formatEvolutionTimestamp } from './evolution-types.ts'
import { strategyEvolutionLabel, strategyKindLabel } from './strategy-display.ts'
import css from './EvolutionHistory.module.css'

type Row = Record<string, unknown>
const labels: Record<string, string> = { promote: '模拟表现达标', mutate: '新方案待验证', demote: '降级观察', retire: '已停止使用' }
const explanations: Record<string, string> = {
  promote: '模拟表现达到本轮门槛，系统已记录达标结果。',
  mutate: '基于原策略生成独立候选，等待验证；原策略保留。',
  demote: '本轮表现触发观察门槛，策略转入观察状态。',
  retire: '退出当前运行；具体原因见本次判定依据。',
}
const params: Record<string, string> = { n: '观察周期', k: '波动带倍数', fast: '短均线周期', slow: '长均线周期', oversold: '超卖阈值', overbought: '超买阈值' }
function sid(action: Row): string { return text(action.sid, text(action.strategy_id, '')) }
function value(raw: unknown): string { return raw === undefined || raw === null ? '未记录' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw) }
function summary(action: Row): string {
  const kind = text(action.type, '')
  const parameters = Object.entries(asRecord(action.params)).slice(0, 3).map(([key, item]) => `${params[key] ?? key} ${value(item)}`).join(' · ')
  return kind === 'mutate' && parameters ? `${parameters} · 待独立验证` : explanations[kind] ?? text(action.reason, '查看记录详情')
}
function state(raw: unknown): string {
  return ({ tier1: '尚未记录达标', tier2: '模拟表现达标', active: '运行中', watch: '观察中', retired: '已停止使用', candidate: '候选待验证' } as Record<string, string>)[text(raw, '')] ?? value(raw)
}

/** 限高历史时间线；动作来自分页记录，当前策略信息来自既有详情入口。 */
export function EvolutionHistory({ requestData, strategies, securityNames, refreshKey, onOpenStrategy }: {
  requestData: EvolutionRequestData
  strategies: readonly Row[]
  securityNames: Readonly<Record<string, string>>
  refreshKey: unknown
  onOpenStrategy: (strategyId: string) => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [total, setTotal] = useState<number>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [changed, setChanged] = useState(false)
  const [selected, setSelected] = useState<Row>()
  const [view, setView] = useState('')
  const [detail, setDetail] = useState<Row>()
  const [detailError, setDetailError] = useState(false)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const generation = useRef(0)
  const busy = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const load = useCallback(async (next?: string) => {
    if (busy.current) return
    busy.current = true
    const current = generation.current
    setLoading(true); setError(''); setChanged(false)
    try {
      const page = asRecord(await requestData({ operation: 'trading-core.evolution-history', input: { limit: 20, ...(next ? { cursor: next } : {}) } }))
      if (current !== generation.current) return
      if (!Array.isArray(page.items) || typeof page.total !== 'number') throw new Error('Invalid history response')
      const incoming = records(page.items)
      setRows(old => next ? [...old, ...incoming.filter(item => !old.some(previous => previous.action_id === item.action_id))] : incoming)
      setCursor(text(page.next_cursor, '') || undefined)
      setTotal(page.total)
    } catch (reason) {
      if (current !== generation.current) return
      const conflict = String(reason).includes('409')
      setChanged(conflict)
      setError(conflict ? '历史记录已更新，请刷新后继续查看。' : '历史动作暂时无法读取，已显示的记录仍可查看。')
    } finally {
      if (current === generation.current) { busy.current = false; setLoading(false) }
    }
  }, [requestData])
  const restart = useCallback(() => {
    generation.current += 1; busy.current = false
    setCursor(undefined)
    if (scroll.current) scroll.current.scrollTop = 0
    void load()
  }, [load])
  useEffect(() => { restart(); return () => { generation.current += 1; busy.current = false } }, [restart, refreshKey])
  const action = asRecord(selected?.action)
  const type = text(action.type, '')
  const target = view || sid(action)
  useEffect(() => {
    let live = true
    setDetail(undefined); setDetailError(false)
    if (!selected || !target) return
    void requestData({ operation: 'trading-core.strategy-detail', input: { strategy_id: target } }).then(result => {
      if (live) setDetail(asRecord(result))
    }).catch(() => { if (live) setDetailError(true) })
    return () => { live = false }
  }, [requestData, selected, target, detailAttempt])
  const identity = (id: string, fallback: Row = {}) => {
    const record = strategies.find(item => text(item.id, text(item.strategy_id, '')) === id)
    return strategyEvolutionLabel(record ?? fallback, securityNames)
  }
  const participation = text(asRecord(detail?.evolve).state, text(detail?.status, ''))
  const participationTone = participation === 'active' ? 'success' : participation === 'watch' ? 'warning' : ['retired', 'rejected'].includes(participation) ? 'error' : 'neutral'
  const parent = text(action.parent, '')
  const parentRecord = strategies.find(item => text(item.id, text(item.strategy_id, '')) === parent)
  const groups: { id: string; at: unknown; rows: Row[] }[] = []
  for (const row of rows) {
    const previous = groups.at(-1)
    if (previous && previous.id === row.round_id) previous.rows.push(row)
    else groups.push({ id: text(row.round_id, ''), at: row.applied_at, rows: [row] })
  }
  const close = () => { setSelected(undefined); setView('') }
  return <section className={css.history} aria-label="历史进化动作">
    <div className={css.heading}><div><h2>历史进化动作</h2><p>按执行时间倒序 · 点击动作查看变化与依据</p></div><span>{total === undefined ? '—' : `${rows.length} / ${total} 项动作`}</span></div>
    <div ref={scroll} className={css.timeline} role="region" aria-label="历史动作时间线，可滚动" tabIndex={0} onScroll={event => {
      const node = event.currentTarget
      if (cursor && !error && node.scrollHeight - node.scrollTop - node.clientHeight < 100) void load(cursor)
    }}>
      {groups.map(group => <div className={css.round} key={group.id}>
        <time>{formatEvolutionTimestamp(group.at)}</time>
        <div className={css.actions}>{group.rows.map(row => {
          const item = asRecord(row.action); const kind = text(item.type, '')
          return <button type="button" className={css.row} key={text(row.action_id)} onClick={() => { setSelected(row); setView('') }}>
            <span className={css.badge} data-tone={kind}>{labels[kind] ?? '进化动作'}</span>
            <span><strong>{identity(sid(item), item)}</strong><small>{summary(item)}</small></span><span aria-hidden="true">→</span>
          </button>
        })}</div>
      </div>)}
      {loading && <p role="status">正在读取历史动作…</p>}
      {error && <div className={css.notice} role="alert">{error}<button type="button" disabled={loading} onClick={() => { if (changed) restart(); else void load(cursor) }}>{changed ? '刷新历史' : '重试'}</button></div>}
      {!loading && !error && rows.length === 0 && <p className={css.empty}>尚无已执行的进化动作。</p>}
      {cursor && !error && <button type="button" className={css.more} disabled={loading} onClick={() => { void load(cursor) }}>继续加载较早动作</button>}
      {!cursor && rows.length > 0 && !loading && !error && <p className={css.end}>已显示全部历史动作</p>}
    </div>
    <Modal open={selected !== undefined} onClose={close} title={view ? '关联策略详情' : '进化动作详情'} closeLabel="关闭动作详情" className={css.drawer} contentClassName={css.drawerContent} footer={selected && (view || sid(action)) ? <div className={css.footerActions}>{view ? <Button variant="outline" className={css.defaultButton} onClick={() => { setView('') }}>← 返回本次动作</Button> : <Button variant="primary" className={css.primaryButton} onClick={() => { const strategyId = sid(action); close(); onOpenStrategy(strategyId) }}>查看策略详情</Button>}</div> : undefined}>
      {selected && <>
        <p>{formatEvolutionTimestamp(selected.applied_at)} · 已执行</p>
        <h2>{identity(target, detail ?? action)}</h2>
        {!view && <><span className={css.badge} data-tone={type}>{labels[type] ?? '进化动作'}</span><p>{explanations[type]}</p></>}
        <div className={css.currentState}><span>当前策略状态</span><strong className={css.stateBadge} data-tone={detail && !detailError ? participationTone : 'neutral'}>{detailError ? '暂不可读取' : detail ? evolutionParticipationLabel(participation) : '正在读取…'}</strong></div>
        {detailError && <button type="button" onClick={() => { setDetailAttempt(attempt => attempt + 1) }}>重试读取策略</button>}
        {view ? <>
          <h3>策略规则<span className={css.ruleKind}>{detail ? strategyKindLabel(detail.kind) : '—'}</span></h3>
          <p>{detail ? text(detail.description, text(detail.hypothesis, '当前记录未提供规则说明。')) : '详情暂不可用时，仍可返回历史动作。'}</p>
          <table className={css.comparison}><tbody>{Object.entries(asRecord(detail?.params)).map(([key, item]) => <tr key={key}><th>{params[key] ?? key}</th><td>{value(item)}</td></tr>)}</tbody></table>
          <p className={css.caption}>当前参数，不代表动作执行时的历史值。</p>
        </> : <>
          <h3>这次做了什么</h3>
          <table className={css.comparison}><thead><tr><th>变化项</th><th>执行前</th><th>执行后</th></tr></thead><tbody>
            {type === 'mutate' ? <>
              {Object.entries(asRecord(action.params)).map(([key, item]) => <tr key={key}><th>{params[key] ?? key}</th><td>未记录</td><td>{value(item)}</td></tr>)}
              <tr><th>原策略</th><td>保留</td><td>新增独立候选</td></tr>
            </> : <tr><th>{type === 'promote' ? '达标记录' : '参与状态'}</th><td>{state(action.from)}</td><td>{state(action.to)}</td></tr>}
          </tbody></table>
          {type === 'mutate' && <p>历史未保存原参数，不以原策略当前参数替代。</p>}
          <h3>判定依据</h3>{type === 'mutate' ? <><p>原策略触发衍生候选生成规则，新方案需独立验证。</p>{text(action.attribution_note, '') && <p>{text(action.attribution_note)}</p>}<details><summary>查看原始判定记录</summary><p className={css.reason}>{text(action.reason, '未记录')}</p></details></> : <p className={css.reason}>{text(action.reason, '本次记录未保存判定依据。')}</p>}
          {parent && <><h3>原策略与来源</h3><span className={css.source}><button type="button" className={css.link} onClick={() => { setView(parent) }}>{identity(parent)} ↗</button><span className={css.peek} role="tooltip">{parentRecord ? `${strategyKindLabel(parentRecord.kind)} · ${evolutionParticipationLabel(text(asRecord(parentRecord.evolve).state, text(parentRecord.status, '')))}` : '原策略摘要暂不可用，点击尝试读取详情。'}</span></span></>}
        </>}
      </>}
    </Modal>
  </section>
}
