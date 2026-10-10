import { useEffect, useMemo, useState } from 'react'
import { Button, DatePicker, HelpPopover, IconFullscreenOutline16, IconRefreshOutline16, Modal, ProgressBar, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import brandIcon from '../../../official-site/app-icon.png'
import { availableDate, loadBundle, PublicApiError, type PublicBundle, type PublicCalendar, type PublicActivityDetail } from './api.ts'
import { EquityChart } from './EquityChart.tsx'
import { startRefreshTask } from './refresh.ts'
import css from './App.module.css'

const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })
const categoryLabels = { research: '研究', operation: '操作', system: '系统' } as const
const categoryOptions = [{ value: 'all', label: '全部' }, { value: 'research', label: '研究' }, { value: 'operation', label: '操作' }, { value: 'system', label: '系统' }]
const statusOptions = [{ value: 'all', label: '全部' }, { value: 'completed', label: '完成' }, { value: 'failed', label: '失败 / 已回滚' }]

function todayInShanghai(now: Date): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
function money(value: string | null | undefined): string { return value == null ? '—' : currency.format(Number(value)) }
function percent(value: string | null | undefined): string { return value == null ? '—' : `${(Number(value) * 100).toFixed(2)}%` }
function profitClass(value: string | null | undefined): string | undefined {
  return value == null || Number(value) === 0 ? undefined : Number(value) > 0 ? css.positive : css.negative
}
function localTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
function StatusNotice({ loading, error, hasData, label, retry }: {
  loading: boolean
  error: boolean
  hasData: boolean
  label: string
  retry: () => void
}) {
  if (loading && !hasData && !error) return <p role="status">正在读取{label}…</p>
  if (!error) return null
  return <div className={css.partial} role="status"><span>{hasData ? `${label}刷新失败，当前显示上次结果，可能已过期。` : `${label}暂时无法读取。`}</span><Button variant="outline" disabled={loading} onClick={retry}>重试{label}</Button></div>
}

function RefreshIndicator({ loading, label }: { loading: boolean; label: string }) {
  return <span className={css.refreshIndicator} data-refresh-indicator={label} data-loading={loading} role="status" aria-live="off" aria-label={loading ? `${label}正在读取，已有内容保留` : undefined} aria-hidden={!loading} title={`${label}正在读取`}><IconRefreshOutline16 /></span>
}

function PerformanceHelp({ limitations, label }: { limitations: string[]; label: string }) {
  return <span className={css.formulaHelp}><span>收益说明</span><HelpPopover label={label} openOnHover>
    <p>历史收益为估算值，不含现金；缺失数据不补零。</p>
    {limitations.map((limit, index) => <p key={index}>{limit}</p>)}
  </HelpPopover></span>
}

export function App() {
  const [now, setNow] = useState(() => new Date())
  const today = todayInShanghai(now)
  const [batchDay, setBatchDay] = useState(today)
  const [requestedDate, setRequestedDate] = useState<string | null>(null)
  const [calendarMonth, setCalendarMonth] = useState(today.slice(0, 7))
  const [filters, setFilters] = useState({ category: 'all', status: 'all' })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [playing, setPlaying] = useState(false)
  const [state, setState] = useState<{ data: PublicBundle | null; loading: boolean; error: boolean }>(
    { data: null, loading: true, error: false },
  )
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [holdingsOpen, setHoldingsOpen] = useState(false)
  const [activitiesOpen, setActivitiesOpen] = useState(false)
  const [activityDetail, setActivityDetail] = useState<PublicActivityDetail | null>(null)
  const [activityLimit, setActivityLimit] = useState(20)
  const [dateNotice, setDateNotice] = useState('')
  const bundle = state.data
  const loading = state.loading
  const timelineDates = bundle?.available_dates ?? []
  const selectedDate = availableDate(timelineDates, requestedDate)
  const timelineIndex = Math.max(0, timelineDates.indexOf(selectedDate))
  const frames = useMemo(() => new Map(bundle?.frames.map(frame => [frame.date, frame])), [bundle])
  const live = frames.get(selectedDate) ?? null
  const chartHistory = bundle?.history ?? null
  const calendar = bundle?.calendars.find(month => month.month === calendarMonth) ?? null
  const activityAsOf = selectedDate || bundle?.to || ''
  const activities = useMemo(() => bundle?.activities.filter(item =>
    todayInShanghai(new Date(item.occurred_at)) <= activityAsOf &&
    (filters.category === 'all' || item.category === filters.category) &&
    (filters.status === 'all' || item.status === filters.status)) ?? [], [bundle, activityAsOf, filters])
  const activityRows = activities.slice(0, activityLimit)
  const refresh = () => { setPlaying(false); setActivityDetail(null); setRefreshVersion(value => value + 1) }
  const selectDate = (value: string) => {
    const date = availableDate(timelineDates, value)
    setPlaying(false); setRequestedDate(date)
    setDateNotice(date && date !== value ? `${value} 无可用估值，已定位至 ${date}。` : '')
  }
  const togglePlayback = () => {
    if (playing) { setPlaying(false); return }
    if (timelineDates.length < 2) return
    if (timelineIndex === timelineDates.length - 1) setRequestedDate(timelineDates[0] ?? null)
    else setRequestedDate(selectedDate)
    setDateNotice(''); setPlaying(true)
  }
  const showActivity = (item: PublicActivityDetail) => { setActivityDetail(item) }

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  useEffect(() => {
    const update = () => { setNow(new Date()); setOnline(navigator.onLine); setVisible(document.visibilityState !== 'hidden') }
    const timer = window.setInterval(update, 30_000)
    document.addEventListener('visibilitychange', update)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => { if (!playing) setBatchDay(today) }, [today, playing])
  useEffect(() => {
    const task = startRefreshTask(async (signal) => {
      setActivityDetail(null)
      setState(current => ({ ...current, loading: true }))
      try {
        const data = await loadBundle(batchDay, signal)
        if (!signal.aborted) setState({ data, loading: false, error: false })
        return { failed: false }
      } catch (error) {
        if (signal.aborted) throw error
        const revoked = error instanceof PublicApiError && [403, 404].includes(error.status)
        setState(current => ({ data: revoked ? null : current.data, loading: false, error: true }))
        return { failed: true, retryAfterMs: error instanceof PublicApiError ? error.retryAfterMs : 0 }
      }
    }, { intervalMs: null, retry: true })
    return () => { task.dispose() }
  }, [batchDay, refreshVersion])
  useEffect(() => {
    if (selectedDate) setCalendarMonth(selectedDate.slice(0, 7))
  }, [selectedDate])
  useEffect(() => { setActivityLimit(20); setActivityDetail(null) }, [selectedDate, filters, bundle])
  useEffect(() => {
    if (!playing || !visible || loading) return
    const timer = window.setTimeout(() => {
      const next = timelineDates[timelineIndex + 1]
      if (next === undefined) setPlaying(false)
      else setRequestedDate(next)
    }, 1_200)
    return () => { window.clearTimeout(timer) }
  }, [playing, visible, loading, timelineDates, timelineIndex])
  const operationsPanel = (
    <section className={css.panel} aria-label="操作与运行过程">
      <div className={css.heading}><div><h2>操作与运行过程<RefreshIndicator loading={loading} label="操作记录" /></h2><p>截至 {activityAsOf || '—'} · 公开摘要</p></div><Button variant="ghost" className={css.iconButton} aria-label="展开操作记录" title="展开操作记录" disabled={activityRows.length === 0} onClick={() => { setActivitiesOpen(true) }}><IconFullscreenOutline16 /></Button></div>
      <div className={css.filters} role="group" aria-label="活动筛选">
        <label className={css.filterField}>类型<Select aria-label="记录类型" value={filters.category} options={categoryOptions} onValueChange={(category: string) => { setFilters(current => ({ ...current, category })) }} /></label>
        <label className={css.filterField}>状态<Select aria-label="记录状态" value={filters.status} options={statusOptions} onValueChange={(status: string) => { setFilters(current => ({ ...current, status })) }} /></label>
        {(filters.category !== 'all' || filters.status !== 'all') && <Button variant="ghost" onClick={() => { setFilters({ category: 'all', status: 'all' }) }}>清除筛选</Button>}
      </div>
      <StatusNotice loading={loading} error={bundle?.activities_status === 'error'} hasData={bundle !== null && bundle.activities_status !== 'error'} label="操作记录" retry={refresh} />
      {bundle?.activities_status === 'truncated' && <p role="status">仅载入最近 {bundle.activities.length} 条公开记录，更早记录未包含在本批数据中。</p>}
      <div className={css.activityList}>
        {bundle !== null && bundle.activities_status !== 'error' && activities.length === 0 && <div className={css.empty}>{filters.category === 'all' && filters.status === 'all' ? '截至所选日期暂无已公开记录。' : '当前筛选条件下暂无公开记录。'}</div>}
        {activityRows.map(item => <button type="button" className={css.activityRow} key={item.public_id} onClick={() => { showActivity(item) }}><i data-status={item.status} /><span><small>{categoryLabels[item.category]} · {item.category === 'operation' ? '记录于 ' : ''}{localTime(item.occurred_at)}</small><strong>{item.title}</strong></span></button>)}
        {activities.length > activityLimit && <Button variant="outline" onClick={() => { setActivityLimit(value => value + 20) }}>加载更多</Button>}
      </div>
    </section>
  )
  return <div className={css.app}>
    <header className={css.header}><a className={css.brand} href="/" aria-label="投研智能体公开观察室首页"><img src={brandIcon} alt="" /><span><strong>投研智能体</strong><small>PUBLIC OBSERVATORY</small></span></a><div className={css.headerActions}><Button variant="outline" onClick={() => { setDark(value => !value) }}>{dark ? '浅色' : '深色'}</Button></div></header>
    <section className={css.timebar} aria-label="全局时间切片">
      <div className={css.timeControls}>
        <Button variant="outline" disabled={timelineDates.length === 0} onClick={() => { if (timelineDates[0]) selectDate(timelineDates[0]) }}>第一天</Button>
        <Button variant="outline" disabled={timelineIndex === 0} onClick={() => { selectDate(timelineDates[timelineIndex - 1] ?? selectedDate) }} aria-label="前一日">←</Button>
        {selectedDate ? <DatePicker value={selectedDate || today} label={selectedDate ? '选择日期' : '暂无可用日期'} availableDates={timelineDates} disabled={timelineDates.length === 0} {...timelineDates[0] ? { min: timelineDates[0] } : {}} {...timelineDates.at(-1) ? { max: timelineDates.at(-1) ?? today } : {}} onChange={selectDate} /> : <Button variant="outline" disabled>暂无可用日期</Button>}
        <Button variant="outline" disabled={timelineDates.length === 0 || timelineIndex >= timelineDates.length - 1} onClick={() => { selectDate(timelineDates[timelineIndex + 1] ?? selectedDate) }} aria-label="后一日">→</Button>
        <Button variant="outline" disabled={timelineDates.length === 0} onClick={() => { setPlaying(false); setRequestedDate(null); setDateNotice('') }}>最新数据</Button>
        <Button variant="outline" disabled={timelineDates.length < 2} title={timelineDates.length < 2 ? '至少需要两个历史估值日才能播放' : undefined} onClick={togglePlayback}>{playing ? '暂停' : '播放'}</Button>
      </div>
      <div className={css.refreshControls}><span>{!online ? '离线 · 可继续浏览已载入数据' : 'T+1 更新 · 切换日期无需重新加载'}</span><Button variant="outline" disabled={loading || playing || !online} onClick={refresh}>刷新数据</Button></div>
      {dateNotice && <p role="status">{dateNotice}</p>}
      {timelineDates.length > 0 && <div className={css.playbackTrack}>
        <div className={css.playbackLabels}><span aria-live="off">{selectedDate ? selectedDate.replaceAll('-', '.') : '—'} · 持仓估值 {money(chartHistory?.points.find(point => point.date === selectedDate)?.value)}</span><span>{timelineIndex + 1} / {timelineDates.length}</span></div>
        <div className={css.playbackProgress}><ProgressBar value={timelineIndex} max={Math.max(1, timelineDates.length - 1)} ariaLabel="历史播放进度" /><input type="range" min="0" max={Math.max(0, timelineDates.length - 1)} value={timelineIndex} disabled={timelineDates.length < 2} aria-label="跳转历史播放日期" aria-valuetext={timelineDates[timelineIndex]} onChange={(event) => { const date = timelineDates[Number(event.currentTarget.value)]; if (date) { if (playing) setRequestedDate(date); else selectDate(date) } }} /></div>
      </div>}
    </section>
    <main className={css.main}>
      <div className={css.heroTitle}>
        <div><p className={css.eyebrow}>HOLDINGS PERFORMANCE · UTC+8</p><h1>公开观察室</h1></div>
        <div className={css.marketStatus} data-active={false}><i />A 股 · T+1 历史数据</div>
      </div>
      <StatusNotice loading={loading} error={state.error} hasData={bundle !== null} label="观察室数据" retry={refresh} />
      {bundle !== null && timelineDates.length === 0 && <div className={css.empty}>当前区间暂无可用历史估值。休市和缺少估值的日期已跳过。</div>}
      {live?.freshness.message && <div className={css.staleNotice}>{live.freshness.message}</div>}
      <section className={css.summary} aria-label="持仓概览">
        <div className={css.pnlBlock}><span className={css.summaryLabel}>截至 {selectedDate ? selectedDate.replaceAll('-', '.') : '—'} · 持仓浮盈<RefreshIndicator loading={loading} label="持仓概览" /></span><strong className={profitClass(live?.summary.floating_profit_loss)}>{money(live?.summary.floating_profit_loss)}</strong><p className={profitClass(live?.summary.cost_return)}>{percent(live?.summary.cost_return)}</p><div className={css.formulaHelp}><span>计算口径</span><HelpPopover label="查看计算口径"><p>持仓浮盈 = 持仓市值 − 持仓成本；成本收益率 = 持仓浮盈 ÷ 持仓成本。</p><p>金额不含现金。缺少任何持仓报价时，汇总市值与浮盈显示为“—”；历史表现按持仓变更估算资金流。</p></HelpPopover></div></div>
        <div className={css.metricGrid}>
          <div><span>持仓市值</span><strong>{money(live?.summary.market_value)}</strong><small>不含现金</small></div>
          <div><span>持仓成本</span><strong>{money(live?.summary.holdings_cost)}</strong><small>所选日期持仓数量 × 成本价</small></div>
          <p className={css.unavailableMetrics}>现金 — · 完整总权益 —；暂无可靠来源，当前金额仅反映持仓。</p>
        </div>
      </section>
      <div className={css.statusline} aria-live={playing ? 'off' : 'polite'}>{live !== null ? <><strong>{live.source === 'current_holdings' ? '当前持仓' : '历史持仓记录'}</strong><span>持仓记录于 {live.holdings_as_of}</span><span>{live.freshness.stale ? '部分报价缺失' : '持仓估值可用'}</span></> : <span>{loading ? '正在读取所选日期持仓…' : '所选日期暂无可用持仓估值'}</span>}</div>
      <section className={css.panel} aria-label="持仓历史表现">
        <div className={css.heading}><div><h2>持仓历史表现<RefreshIndicator loading={loading} label="历史表现" /></h2><p>最近 90 日 · T+1 更新 · 估算值，不含现金</p></div>
          <div className={css.headingMeta}>{timelineDates.length > 0 && <span>{timelineDates[0]} — {timelineDates.at(-1)}</span>}<PerformanceHelp label="历史收益说明" limitations={chartHistory?.limitations ?? []} /></div>
        </div>
        {chartHistory?.quality === 'partial' && <p className={css.compactNotice}>部分历史估值缺失<HelpPopover label="历史数据缺失说明" openOnHover>{chartHistory.limitations.map((limit, index) => <p key={index}>{limit}</p>)}</HelpPopover></p>}
        {chartHistory && <EquityChart points={chartHistory.points} dark={dark} activeDate={selectedDate} onSelect={selectDate} />}
      </section>
      <div className={css.columns}><section className={css.panel}><div className={css.heading}><div><h2>持仓<RefreshIndicator loading={loading} label="持仓" /></h2><p>{live === null ? '所选日期暂无持仓明细' : `${live.items.length} 个持仓 · 不含现金`}</p></div><Button variant="ghost" className={css.iconButton} aria-label="展开持仓明细" title="展开持仓明细" disabled={live === null} onClick={() => { setHoldingsOpen(true) }}><IconFullscreenOutline16 /></Button></div><div className={css.holdingList}>{live?.items.length === 0 && <div className={css.empty}>当前没有持仓。</div>}{live?.items.slice(0, 5).map(item => <div className={css.holdingRow} key={item.ticker}><div><strong>{item.name || item.ticker}</strong><small>{item.ticker} · {integer.format(Number(item.quantity))} 份</small></div><div><strong>{money(item.market_value)}</strong><small>{money(item.profit_loss)}</small></div></div>)}</div></section>{operationsPanel}</div>
      <section className={css.panel} aria-label="每日盈亏日历"><div className={css.heading}><div><h2>每日盈亏<RefreshIndicator loading={loading} label="日历" /></h2><p>人民币 · T+1 更新 · 按持仓变化估算，缺失不补零</p></div><div className={css.headingMeta}><PerformanceHelp label="日历收益说明" limitations={calendar?.limitations ?? []} /><Select aria-label="选择月份" value={calendarMonth} disabled={bundle === null} options={bundle?.calendars.map(month => ({ value: month.month, label: month.month.replace('-', ' 年 ') + ' 月' })) ?? []} onValueChange={(month: string) => { setCalendarMonth(month) }} /></div></div><Calendar month={calendarMonth} today={today} selectedDate={selectedDate} calendar={calendar} onSelect={selectDate} /></section>
      <footer>公开内容仅供了解持仓与研究过程，不构成投资建议。金额不含现金；历史收益为估算。</footer>
    </main>
    <Modal open={holdingsOpen} onClose={() => { setHoldingsOpen(false) }} title="持仓明细" closeLabel="关闭持仓明细" className={css.wideModal}><div className={css.tableWrap}><table><caption>{selectedDate} 的持仓资料与估值</caption><thead><tr><th>证券</th><th>数量</th><th>成本价</th><th>估值价</th><th>市值</th><th>浮盈</th></tr></thead><tbody>{live?.items.map(item => <tr key={item.ticker}><td><strong>{item.name || item.ticker}</strong><small>{item.ticker}</small></td><td>{integer.format(Number(item.quantity))}</td><td>{money(item.cost_price)}</td><td>{money(item.market_price)}</td><td>{money(item.market_value)}</td><td>{money(item.profit_loss)}<small>{percent(item.return_rate)}</small></td></tr>)}</tbody></table></div></Modal>
    <Modal open={activitiesOpen} onClose={() => { setActivitiesOpen(false) }} title="操作与运行过程" closeLabel="关闭运行过程" className={css.wideModal}><div className={css.activityList}>{activityRows.map(item => <button type="button" className={css.activityRow} key={item.public_id} onClick={() => { showActivity(item) }}><i data-status={item.status} /><span><small>{categoryLabels[item.category]} · {localTime(item.occurred_at)}</small><strong>{item.title}</strong></span></button>)}</div></Modal>
    <Modal open={activityDetail !== null} onClose={() => { setActivityDetail(null) }} title={activityDetail?.title ?? '活动详情'} closeLabel="关闭活动详情"><div className={css.modalCopy}>{activityDetail && <><p className={css.detailMeta}>{categoryLabels[activityDetail.category]} · {localTime(activityDetail.occurred_at)}</p><p>{activityDetail.summary}</p>{activityDetail.holdings_changes === null && <p>历史持仓字段不完整，无法核对数量与成本变化。</p>}{activityDetail.holdings_changes?.length === 0 && <p>持仓数量与成本未发生变化。</p>}{(activityDetail.holdings_changes?.length ?? 0) > 0 && <div className={css.tableWrap}><table><caption>持仓记录变化（非成交）</caption><thead><tr><th>证券</th><th>数量（前 → 后）</th><th>成本价（前 → 后）</th></tr></thead><tbody>{activityDetail.holdings_changes?.map(change => <tr key={change.ticker}><td><strong>{change.name || live?.items.find(item => item.ticker === change.ticker)?.name || '名称暂不可用'}</strong><small>{change.ticker}</small></td><td>{integer.format(Number(change.before_quantity))} → {integer.format(Number(change.after_quantity))}</td><td>{money(change.before_cost_price)} → {money(change.after_cost_price)}</td></tr>)}</tbody></table></div>}</>}</div></Modal>
  </div>
}

function Calendar({ month, today, selectedDate, calendar, onSelect }: {
  month: string
  today: string
  selectedDate: string
  calendar: PublicCalendar | null
  onSelect: (date: string) => void
}) {
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(year ?? 1970, (monthNumber ?? 1) - 1, 1)
  const blanks = (first.getDay() + 6) % 7
  const days = new Date(year ?? 1970, monthNumber ?? 1, 0).getDate()
  const values = new Map(calendar?.items.map(item => [item.date, item]) ?? [])
  const statuses = new Map(calendar?.days.map(item => [item.date, item.trading_status]) ?? [])
  const statusLabels = { trading: '交易日', closed: '休市', unknown: '待确认' }
  return <div className={css.calendar}><div className={css.weekdays}>{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div><div className={css.calendarGrid}>
    {Array.from({ length: blanks }, (_, index) => <span key={`blank-${index}`} />)}
    {Array.from({ length: days }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, '0')}`
      const item = values.get(date)
      const status = statuses.get(date) ?? 'unknown'
      const label = `${date}，${status === 'unknown' ? '交易日待确认' : statusLabels[status]}，${date === today && status === 'trading' ? 'T+1 待更新' : item === undefined ? '无历史估值' : item.daily_profit_loss === null ? '已有估值，缺少收益基准' : `估算盈亏 ${money(item.daily_profit_loss)}`}`
      const direction = item?.daily_profit_loss == null ? 'missing' : Number(item.daily_profit_loss) > 0 ? 'positive' : Number(item.daily_profit_loss) < 0 ? 'negative' : 'flat'
      return <button type="button" key={date} disabled={item === undefined} data-selected={date === selectedDate} data-trading-status={status} data-direction={direction} data-future={date > today} data-pending={date === today} aria-label={label} title={label} onClick={() => { onSelect(date) }}><span>{index + 1}</span><small>{date > today && status === 'trading' ? '未到' : date === today && status === 'trading' ? '待更新' : status === 'trading' && direction === 'missing' ? item === undefined ? '缺估值' : '缺基准' : statusLabels[status]}</small><strong>{money(item?.daily_profit_loss)}</strong></button>
    })}
  </div><p className={css.calendarStatus}>{calendar === null ? '日历数据未读取' : calendar.items.length === 0 ? '本月暂无可用历史估值' : `${calendar.items.length} 个历史估值日 · ${calendar.items.filter(item => item.daily_profit_loss !== null).length} 日可估算盈亏`}</p></div>
}
