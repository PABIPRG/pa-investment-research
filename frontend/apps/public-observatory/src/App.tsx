import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, DatePicker, HelpPopover, IconFullscreenOutline16, IconRefreshOutline16, Modal, MonthPicker, ProgressBar, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import brandIcon from '../../../official-site/app-icon.png'
import {
  historyCutoff, loadActivityDetail, loadCalendar, loadHistory, loadMoreActivities, loadObservatorySlice, PublicApiError,
  type ObservatorySlice, type PublicCalendar, type PublicHistory, type PublicActivity, type PublicActivityDetail,
} from './api.ts'
import { EquityChart } from './EquityChart.tsx'
import { marketStatus } from './marketStatus.ts'
import { startRefreshTask, type RefreshTask, type RefreshPolicy } from './refresh.ts'
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
function offsetDate(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}
function money(value: string | null | undefined): string { return value == null ? '—' : currency.format(Number(value)) }
function percent(value: string | null | undefined): string { return value == null ? '—' : `${(Number(value) * 100).toFixed(2)}%` }
function profitClass(value: string | null | undefined): string | undefined {
  return value == null || Number(value) === 0 ? undefined : Number(value) > 0 ? css.positive : css.negative
}
function localTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
function emptySlice(): ObservatorySlice {
  return {
    liveLoading: true, historyLoading: true, calendarLoading: true, activitiesLoading: true,
    live: null, liveError: false, history: null, historyError: false,
    calendar: null, calendarError: false, activities: null, activitiesError: false,
  }
}
type LoadState = { query: string; data: ObservatorySlice | null; error: string | null }
type DailyState<T> = { key: string; data: T | null; loading: boolean; error: boolean }
type Part = 'live' | 'history' | 'calendar' | 'activities'
function mergePart(previous: ObservatorySlice, next: ObservatorySlice, part: Part): ObservatorySlice {
  if (part === 'live') return {
    ...previous, liveLoading: false, liveError: next.liveError,
    live: next.liveError ? previous.live : next.live,
  }
  if (part === 'history') return {
    ...previous, historyLoading: false, historyError: next.historyError,
    history: next.historyError ? previous.history : next.history,
  }
  if (part === 'calendar') return {
    ...previous, calendarLoading: false, calendarError: next.calendarError,
    calendar: next.calendarError ? previous.calendar : next.calendar,
  }
  return {
    ...previous, activitiesLoading: false, activitiesError: next.activitiesError,
    activities: next.activitiesError ? previous.activities : next.activities,
  }
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
  const today = useMemo(() => todayInShanghai(now), [now])
  const [selectedDate, setSelectedDate] = useState(today)
  const [calendarMonth, setCalendarMonth] = useState(today.slice(0, 7))
  const [filters, setFilters] = useState({ category: 'all', status: 'all' })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [playing, setPlaying] = useState(false)
  const [playbackDates, setPlaybackDates] = useState<string[]>([])
  const [playbackIndex, setPlaybackIndex] = useState<number | null>(null)
  const [playbackHistory, setPlaybackHistory] = useState<PublicHistory | null>(null)
  const historyEnd = playbackHistory?.to ?? historyCutoff(today, today)
  const liveTask = useRef<RefreshTask | null>(null)
  const historyTask = useRef<RefreshTask | null>(null)
  const calendarTask = useRef<RefreshTask | null>(null)
  const policy: { live: RefreshPolicy; daily: RefreshPolicy } = {
    live: { intervalMs: autoRefresh && selectedDate === today && !playing ? 15_000 : null, retry: autoRefresh && !playing },
    daily: { intervalMs: null, retry: autoRefresh && !playing },
  }
  const policies = useRef(policy)
  policies.current = policy
  const dateContext = useRef({ today, autoRefresh, playbackIndex })
  dateContext.current = { today, autoRefresh, playbackIndex }
  const [historyState, setHistoryState] = useState<DailyState<PublicHistory>>({ key: historyEnd, data: null, loading: true, error: false })
  const [calendarState, setCalendarState] = useState<DailyState<PublicCalendar>>({
    key: calendarMonth, data: null, loading: true, error: false,
  })
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const query = `${selectedDate}:${filters.category}:${filters.status}`
  const currentQuery = useRef(query)
  currentQuery.current = query
  const generation = useRef(0)
  const detailGeneration = useRef(0)
  const firstPagePending = useRef(true)
  const [state, setState] = useState<LoadState>({ query, data: null, error: null })
  const frameReady = state.query === query && state.data?.liveLoading === false
  const [holdingsOpen, setHoldingsOpen] = useState(false)
  const [activitiesOpen, setActivitiesOpen] = useState(false)
  const [activityDetail, setActivityDetail] = useState<PublicActivityDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const refresh = () => {
    setPlaying(false)
    setPlaybackDates([])
    setPlaybackIndex(null)
    setPlaybackHistory(null)
    setRefreshVersion(value => value + 1)
  }

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  useEffect(() => {
    const update = () => {
      const nextNow = new Date()
      const nextToday = todayInShanghai(nextNow)
      const previous = dateContext.current
      if (nextToday !== previous.today && previous.autoRefresh && previous.playbackIndex === null) {
        setSelectedDate(current => current === previous.today ? nextToday : current)
      }
      setNow(nextNow)
      setOnline(navigator.onLine)
      setVisible(document.visibilityState !== 'hidden')
    }
    const timer = window.setInterval(update, 30_000)
    document.addEventListener('visibilitychange', update)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    const task = startRefreshTask(async (signal) => {
      // 浏览器恢复事件可能先于 React 提交新日界；等待新日期的 effect 接管读取。
      if (today !== todayInShanghai(new Date())) return { failed: false }
      const currentGeneration = ++generation.current
      firstPagePending.current = true
      setState(current => ({
        query, error: null,
        data: current.query === query && current.data !== null
          ? { ...current.data, liveLoading: true, activitiesLoading: true }
          : emptySlice(),
      }))
      setLoadingMore(false)
      setMoreError(false)
      try {
        const result = await loadObservatorySlice(selectedDate, filters, signal, (next, part) => {
          if (signal.aborted || currentGeneration !== generation.current) return
          if (part === 'activities') firstPagePending.current = false
          setState(current => current.query !== query ? current : ({
            ...current, data: mergePart(current.data ?? emptySlice(), next, part),
          }))
          if (part === 'activities' && !next.activitiesError) {
            setActivityDetail((current) => {
              if (current === null || next.activities?.items.some(row => row.public_id === current.public_id)) return current
              detailGeneration.current += 1
              return null
            })
          }
        }, ['live', 'activities'])
        return { failed: result.liveError || result.activitiesError, retryAfterMs: result.retryAfterMs ?? 0 }
      }
      catch (error) {
        if (signal.aborted || currentGeneration !== generation.current) throw error
        const message = error instanceof PublicApiError ? error.message : '公开数据加载失败，请稍后重试。'
        firstPagePending.current = false
        setState(current => ({ ...current, error: message, data: {
          ...(current.data ?? emptySlice()), liveLoading: false, activitiesLoading: false, liveError: true, activitiesError: true,
        } }))
        return { failed: true, retryAfterMs: error instanceof PublicApiError ? error.retryAfterMs : 0 }
      }
    }, policies.current.live)
    liveTask.current = task
    return () => { task.dispose() }
  }, [selectedDate, filters, query, refreshVersion, today])
  useEffect(() => {
    const task = startRefreshTask(async (signal) => {
      if (today !== todayInShanghai(new Date())) return { failed: false }
      setHistoryState(current => ({
        key: historyEnd, data: current.key === historyEnd ? current.data : null,
        loading: true, error: current.key === historyEnd && current.error,
      }))
      try {
        const data = await loadHistory(offsetDate(historyEnd, -89), historyEnd, signal)
        if (!signal.aborted) setHistoryState({ key: historyEnd, data, loading: false, error: false })
        return { failed: false }
      }
      catch (error) {
        if (signal.aborted) throw error
        setHistoryState(current => ({ ...current, loading: false, error: true }))
        return { failed: true, retryAfterMs: error instanceof PublicApiError ? error.retryAfterMs : 0 }
      }
    }, policies.current.daily)
    historyTask.current = task
    return () => { task.dispose() }
  }, [historyEnd, today, refreshVersion])
  useEffect(() => {
    detailGeneration.current += 1
    setActivityDetail(null)
    setDetailError(null)
  }, [query])
  useEffect(() => { setCalendarMonth(selectedDate.slice(0, 7)) }, [selectedDate])
  useEffect(() => {
    if (!playing || playbackIndex === null || !frameReady || !online || !visible) return
    const timer = window.setTimeout(() => {
      if (playbackIndex >= playbackDates.length - 1) {
        setPlaying(false)
        setSelectedDate(playbackDates[playbackIndex] ?? today)
      } else {
        setPlaybackIndex(playbackIndex + 1)
        setSelectedDate(playbackDates[playbackIndex + 1] ?? selectedDate)
      }
    }, 1_200)
    return () => { window.clearTimeout(timer) }
  }, [playing, playbackDates, playbackIndex, today, frameReady, online, visible, selectedDate])
  useEffect(() => {
    const task = startRefreshTask(async (signal) => {
      if (today !== todayInShanghai(new Date())) return { failed: false }
      setCalendarState(current => ({
        key: calendarMonth, data: current.key === calendarMonth ? current.data : null,
        loading: true, error: current.key === calendarMonth && current.error,
      }))
      try {
        const data = await loadCalendar(calendarMonth, signal, historyCutoff(today, today))
        if (!signal.aborted) setCalendarState({ key: calendarMonth, data, loading: false, error: false })
        return { failed: false }
      }
      catch (error) {
        if (signal.aborted) throw error
        setCalendarState(current => ({ ...current, loading: false, error: true }))
        return { failed: true, retryAfterMs: error instanceof PublicApiError ? error.retryAfterMs : 0 }
      }
    }, policies.current.daily)
    calendarTask.current = task
    return () => { task.dispose() }
  }, [calendarMonth, today, refreshVersion])
  useEffect(() => {
    liveTask.current?.updatePolicy(policies.current.live)
    historyTask.current?.updatePolicy(policies.current.daily)
    calendarTask.current?.updatePolicy(policies.current.daily)
  }, [autoRefresh, selectedDate, today, playing])

  const slice = state.query === query ? state.data : null
  const live = slice?.live?.availability === 'available' ? slice.live : null
  const history = historyState.key === historyEnd ? historyState.data : null
  const chartHistory = playbackIndex === null ? history : playbackHistory ?? history
  const timelineDates = chartHistory?.points.filter(row => row.value !== null).map(row => row.date).sort() ?? []
  const timelineIndex = Math.max(0, timelineDates.findLastIndex(date => date <= selectedDate))
  const calendar = calendarState.key === calendarMonth ? calendarState.data : null
  const todayTradingStatus = calendar?.month === today.slice(0, 7)
    ? calendar.days.find(day => day.date === today)?.trading_status : undefined
  const market = marketStatus(now, todayTradingStatus, selectedDate === today)
  const minDate = history?.available_since ?? undefined
  const busy = slice === null || (slice.liveLoading && historyState.loading && calendarState.loading && slice.activitiesLoading)
  const selectDate = (value: string) => {
    setPlaying(false); setPlaybackDates([]); setPlaybackIndex(null); setPlaybackHistory(null); setSelectedDate(value)
  }
  const togglePlayback = () => {
    if (playing) { setPlaying(false); return }
    if (playbackIndex !== null && playbackIndex < playbackDates.length - 1) { setPlaying(true); return }
    const source = playbackHistory ?? history
    const dates = timelineDates
    const last = dates.at(-1)
    if (dates.length < 2 || last === undefined) return
    const start = selectedDate >= last ? 0 : dates.findIndex(date => date >= selectedDate)
    setPlaybackHistory(source)
    setPlaybackDates(dates)
    setPlaybackIndex(start)
    setSelectedDate(dates[start] ?? selectedDate)
    setPlaying(true)
  }
  async function showActivity(item: PublicActivity): Promise<void> {
    const requestId = ++detailGeneration.current
    setDetailLoading(true)
    setDetailError(null)
    setActivityDetail({ ...item, related_snapshot_id: null })
    try {
      const detail = await loadActivityDetail(item.public_id)
      if (detailGeneration.current === requestId) setActivityDetail(detail)
    }
    catch (error) {
      if (detailGeneration.current !== requestId) return
      if (error instanceof PublicApiError && [403, 404].includes(error.status)) {
        setActivityDetail(null)
        setDetailError('该记录已不可用，正在重新读取公开记录。')
        refresh()
      }
      else setDetailError('详情加载失败，当前仅展示已读取的摘要。')
    }
    finally { if (detailGeneration.current === requestId) setDetailLoading(false) }
  }
  async function loadMore(): Promise<void> {
    const activities = slice?.activities
    if (firstPagePending.current || activities?.next_cursor == null) return
    const currentGeneration = generation.current
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await loadMoreActivities(selectedDate, filters, activities.next_cursor)
      if (currentQuery.current !== query || currentGeneration !== generation.current) return
      setState(current => current.query !== query || current.data?.activities?.next_cursor !== activities.next_cursor ? current : ({
        ...current, data: { ...current.data, activities: {
          ...page, items: [...new Map([...current.data.activities.items, ...page.items].map(row => [row.public_id, row])).values()],
        } },
      }))
    }
    catch (error) {
      if (currentQuery.current !== query || currentGeneration !== generation.current) return
      if (error instanceof PublicApiError && error.status === 409) {
        generation.current += 1
        detailGeneration.current += 1
        firstPagePending.current = true
        setActivityDetail(null)
        setDetailError('记录范围已更新，已清除旧分页。')
        setState(current => current.data === null ? current : ({
          ...current, data: { ...current.data, activities: null, activitiesLoading: true, activitiesError: false },
        }))
        refresh()
      }
      else setMoreError(true)
    }
    finally { if (currentGeneration === generation.current) setLoadingMore(false) }
  }
  const activityRows = slice?.activities?.items ?? []
  const operationsPanel = (
    <section className={css.panel} aria-label="操作与运行过程">
      <div className={css.heading}><div><h2>操作与运行过程<RefreshIndicator loading={slice?.activitiesLoading ?? true} label="操作记录" /></h2><p>截至 {selectedDate} · 公开摘要</p></div><Button variant="ghost" className={css.iconButton} aria-label="展开操作记录" title="展开操作记录" disabled={activityRows.length === 0} onClick={() => { setActivitiesOpen(true) }}><IconFullscreenOutline16 /></Button></div>
      <div className={css.filters} role="group" aria-label="活动筛选">
        <label className={css.filterField}>类型<Select aria-label="记录类型" value={filters.category} options={categoryOptions} onValueChange={(category: string) => { setFilters(current => ({ ...current, category })) }} /></label>
        <label className={css.filterField}>状态<Select aria-label="记录状态" value={filters.status} options={statusOptions} onValueChange={(status: string) => { setFilters(current => ({ ...current, status })) }} /></label>
        {(filters.category !== 'all' || filters.status !== 'all') && <Button variant="ghost" onClick={() => { setFilters({ category: 'all', status: 'all' }) }}>清除筛选</Button>}
      </div>
      <StatusNotice loading={slice?.activitiesLoading ?? true} error={slice?.activitiesError ?? false} hasData={slice?.activities != null} label="操作记录" retry={refresh} />
      {detailError && <p role="status">{detailError}</p>}
      <div className={css.activityList}>
        {slice?.activities?.items.length === 0 && <div className={css.empty}>{filters.category === 'all' && filters.status === 'all' ? '截至所选日期暂无已公开记录。' : '当前筛选条件下暂无公开记录。'}</div>}
        {activityRows.map(item => <button type="button" className={css.activityRow} key={item.public_id} onClick={() => { void showActivity(item) }}><i data-status={item.status} /><span><small>{categoryLabels[item.category]} · {item.category === 'operation' ? '记录于 ' : ''}{localTime(item.occurred_at)}</small><strong>{item.title}</strong></span></button>)}
        {moreError && <p role="status">更多记录加载失败，可重试。</p>}
        {slice?.activities?.next_cursor != null && <Button variant="outline" disabled={loadingMore || slice.activitiesLoading} onClick={() => { void loadMore() }}>{loadingMore ? '加载中…' : '加载更多'}</Button>}
      </div>
    </section>
  )
  return <div className={css.app}>
    <header className={css.header}><a className={css.brand} href="/" aria-label="投研智能体公开观察室首页"><img src={brandIcon} alt="" /><span><strong>投研智能体</strong><small>PUBLIC OBSERVATORY</small></span></a><div className={css.headerActions}><Button variant="outline" onClick={() => { setDark(value => !value) }}>{dark ? '浅色' : '深色'}</Button></div></header>
    <section className={css.timebar} aria-label="全局时间切片">
      <div className={css.timeControls}>
        <Button variant="outline" disabled={timelineDates.length === 0} onClick={() => { if (timelineDates[0]) selectDate(timelineDates[0]) }}>第一天</Button>
        <Button variant="outline" disabled={minDate !== undefined && selectedDate <= minDate} onClick={() => { selectDate(offsetDate(selectedDate, -1)) }} aria-label="前一日">←</Button>
        <DatePicker value={selectedDate} {...minDate === undefined ? {} : { min: minDate }} max={today} onChange={selectDate} />
        <Button variant="outline" disabled={selectedDate >= today} onClick={() => { selectDate(offsetDate(selectedDate, 1)) }} aria-label="后一日">→</Button>
        <Button variant="outline" onClick={() => { selectDate(today) }}>当日</Button>
        <Button variant="outline" disabled={timelineDates.length < 2} title={timelineDates.length < 2 ? '至少需要两个历史估值日才能播放' : undefined} onClick={togglePlayback}>{playing ? '暂停' : '播放'}</Button>
      </div>
      <div className={css.refreshControls}><label><input type="checkbox" checked={autoRefresh} disabled={selectedDate !== today || playing} onChange={(event) => { setAutoRefresh(event.currentTarget.checked) }} />{!online ? '网络已断开 · 自动刷新暂停' : playing ? '播放中 · 自动刷新暂停' : selectedDate === today ? '每 15 秒自动刷新' : '历史日期 · 自动刷新暂停'}</label><Button variant="outline" disabled={busy || playing} onClick={refresh}>刷新数据</Button></div>
      {timelineDates.length > 0 && <div className={css.playbackTrack}>
        <div className={css.playbackLabels}><span aria-live="off">{selectedDate.replaceAll('-', '.')} · 持仓估值 {money(chartHistory?.points.find(point => point.date === selectedDate)?.value)}</span><span>{timelineIndex + 1} / {timelineDates.length}</span></div>
        <div className={css.playbackProgress}><ProgressBar value={timelineIndex} max={Math.max(1, timelineDates.length - 1)} ariaLabel="历史播放进度" /><input type="range" min="0" max={Math.max(0, timelineDates.length - 1)} value={timelineIndex} disabled={timelineDates.length < 2} aria-label="跳转历史播放日期" aria-valuetext={timelineDates[timelineIndex]} onChange={(event) => { const date = timelineDates[Number(event.currentTarget.value)]; if (date) { if (playing) { setPlaybackIndex(playbackDates.indexOf(date)); setSelectedDate(date) } else selectDate(date) } }} /></div>
      </div>}
    </section>
    <main className={css.main}>
      <div className={css.heroTitle}>
        <div><p className={css.eyebrow}>HOLDINGS PERFORMANCE · UTC+8</p><h1>公开观察室</h1></div>
        <div className={css.marketStatus} data-active={market.active}><i />A 股 · {market.label}</div>
      </div>
      {state.error && <div className={css.partial} role="alert">{state.error}<Button variant="outline" onClick={refresh}>重试</Button></div>}
      <StatusNotice loading={slice?.liveLoading ?? true} error={slice?.liveError ?? false} hasData={live !== null} label="持仓" retry={refresh} />
      {slice?.live?.availability === 'unavailable' && <div className={css.inlineNotice}>{slice.live.message} 历史与活动仍可查看。</div>}
      {live?.freshness.message && <div className={css.staleNotice}>{live.freshness.message}</div>}
      <section className={css.summary} aria-label="持仓概览">
        <div className={css.pnlBlock}><span className={css.summaryLabel}>截至 {selectedDate.replaceAll('-', '.')} · 持仓浮盈<RefreshIndicator loading={slice?.liveLoading ?? true} label="持仓概览" /></span><strong className={profitClass(live?.summary.floating_profit_loss)}>{money(live?.summary.floating_profit_loss)}</strong><p className={profitClass(live?.summary.cost_return)}>{percent(live?.summary.cost_return)}</p><div className={css.formulaHelp}><span>计算口径</span><HelpPopover label="查看计算口径"><p>持仓浮盈 = 持仓市值 − 持仓成本；成本收益率 = 持仓浮盈 ÷ 持仓成本。</p><p>金额不含现金。缺少任何持仓报价时，汇总市值与浮盈显示为“—”；历史表现按持仓变更估算资金流。</p></HelpPopover></div></div>
        <div className={css.metricGrid}>
          <div><span>持仓市值</span><strong>{money(live?.summary.market_value)}</strong><small>不含现金</small></div>
          <div><span>持仓成本</span><strong>{money(live?.summary.holdings_cost)}</strong><small>所选日期持仓数量 × 成本价</small></div>
          <p className={css.unavailableMetrics}>现金 — · 完整总权益 —；暂无可靠来源，当前金额仅反映持仓。</p>
        </div>
      </section>
      <div className={css.statusline} aria-live={playing ? 'off' : 'polite'}>{live !== null ? <><strong>{live.source === 'current_holdings' ? '当前持仓' : '历史持仓记录'}</strong><span>持仓记录于 {live.holdings_as_of}</span><span>{live.freshness.stale ? '部分报价缺失' : '持仓估值可用'}</span></> : <span>{slice?.liveLoading !== false ? '正在读取所选日期持仓…' : '所选日期暂无可用持仓估值'}</span>}</div>
      <section className={css.panel} aria-label="持仓历史表现">
        <div className={css.heading}><div><h2>持仓历史表现<RefreshIndicator loading={historyState.loading} label="历史表现" /></h2><p>最近 90 日 · T+1 更新 · 估算值，不含现金</p></div>
          <div className={css.headingMeta}>{timelineDates.length > 0 && <span>{timelineDates[0]} — {timelineDates.at(-1)}</span>}<PerformanceHelp label="历史收益说明" limitations={chartHistory?.limitations ?? []} /></div>
        </div>
        <StatusNotice loading={historyState.loading} error={historyState.error} hasData={chartHistory !== null} label="历史表现" retry={refresh} />
        {chartHistory?.quality === 'partial' && <p className={css.compactNotice}>部分历史估值缺失<HelpPopover label="历史数据缺失说明" openOnHover>{chartHistory.limitations.map((limit, index) => <p key={index}>{limit}</p>)}</HelpPopover></p>}
        {chartHistory && <EquityChart points={chartHistory.points} dark={dark} activeDate={selectedDate} />}
      </section>
      <div className={css.columns}><section className={css.panel}><div className={css.heading}><div><h2>持仓<RefreshIndicator loading={slice?.liveLoading ?? true} label="持仓" /></h2><p>{live === null ? '所选日期暂无持仓明细' : `${live.items.length} 个持仓 · 不含现金`}</p></div><Button variant="ghost" className={css.iconButton} aria-label="展开持仓明细" title="展开持仓明细" disabled={live === null} onClick={() => { setHoldingsOpen(true) }}><IconFullscreenOutline16 /></Button></div><div className={css.holdingList}>{live?.items.length === 0 && <div className={css.empty}>当前没有持仓。</div>}{live?.items.slice(0, 5).map(item => <div className={css.holdingRow} key={item.ticker}><div><strong>{item.name || item.ticker}</strong><small>{item.ticker} · {integer.format(Number(item.quantity))} 份</small></div><div><strong>{money(item.market_value)}</strong><small>{money(item.profit_loss)}</small></div></div>)}</div></section>{operationsPanel}</div>
      <section className={css.panel} aria-label="每日盈亏日历"><div className={css.heading}><div><h2>每日盈亏<RefreshIndicator loading={calendarState.loading} label="日历" /></h2><p>人民币 · T+1 更新 · 按持仓变化估算，缺失不补零</p></div><div className={css.headingMeta}><PerformanceHelp label="日历收益说明" limitations={calendar?.limitations ?? []} /><MonthPicker value={calendarMonth} onChange={setCalendarMonth} /></div></div><StatusNotice loading={calendarState.loading} error={calendarState.error} hasData={calendar !== null} label="日历" retry={refresh} /><Calendar month={calendarMonth} today={today} selectedDate={selectedDate} calendar={calendar} onSelect={selectDate} /></section>
      <footer>公开内容仅供了解持仓与研究过程，不构成投资建议。金额不含现金；历史收益为估算。</footer>
    </main>
    <Modal open={holdingsOpen} onClose={() => { setHoldingsOpen(false) }} title="持仓明细" closeLabel="关闭持仓明细" className={css.wideModal}><div className={css.tableWrap}><table><caption>{selectedDate} 的持仓资料与估值</caption><thead><tr><th>证券</th><th>数量</th><th>成本价</th><th>估值价</th><th>市值</th><th>浮盈</th></tr></thead><tbody>{live?.items.map(item => <tr key={item.ticker}><td><strong>{item.name || item.ticker}</strong><small>{item.ticker}</small></td><td>{integer.format(Number(item.quantity))}</td><td>{money(item.cost_price)}</td><td>{money(item.market_price)}</td><td>{money(item.market_value)}</td><td>{money(item.profit_loss)}<small>{percent(item.return_rate)}</small></td></tr>)}</tbody></table></div></Modal>
    <Modal open={activitiesOpen} onClose={() => { setActivitiesOpen(false) }} title="操作与运行过程" closeLabel="关闭运行过程" className={css.wideModal}><div className={css.activityList}>{activityRows.map(item => <button type="button" className={css.activityRow} key={item.public_id} onClick={() => { void showActivity(item) }}><i data-status={item.status} /><span><small>{categoryLabels[item.category]} · {localTime(item.occurred_at)}</small><strong>{item.title}</strong></span></button>)}</div></Modal>
    <Modal open={activityDetail !== null} onClose={() => { detailGeneration.current += 1; setActivityDetail(null) }} title={activityDetail?.title ?? '活动详情'} closeLabel="关闭活动详情"><div className={css.modalCopy}>{activityDetail && <><p className={css.detailMeta}>{categoryLabels[activityDetail.category]} · {localTime(activityDetail.occurred_at)}</p><p>{activityDetail.summary}</p>{detailLoading && <p>正在核对详情…</p>}{detailError && <p role="status">{detailError}</p>}{activityDetail.holdings_changes === null && <p>历史持仓字段不完整，无法核对数量与成本变化。</p>}{activityDetail.holdings_changes?.length === 0 && <p>持仓数量与成本未发生变化。</p>}{(activityDetail.holdings_changes?.length ?? 0) > 0 && <div className={css.tableWrap}><table><caption>持仓记录变化（非成交）</caption><thead><tr><th>证券</th><th>数量（前 → 后）</th><th>成本价（前 → 后）</th></tr></thead><tbody>{activityDetail.holdings_changes?.map(change => <tr key={change.ticker}><td><strong>{change.name || live?.items.find(item => item.ticker === change.ticker)?.name || '名称暂不可用'}</strong><small>{change.ticker}</small></td><td>{integer.format(Number(change.before_quantity))} → {integer.format(Number(change.after_quantity))}</td><td>{money(change.before_cost_price)} → {money(change.after_cost_price)}</td></tr>)}</tbody></table></div>}</>}</div></Modal>
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
