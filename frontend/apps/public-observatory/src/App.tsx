import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, DatePicker, HelpPopover, Modal, MonthPicker, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import brandIcon from '../../../official-site/app-icon.png'
import {
  loadActivityDetail,
  loadCalendar,
  loadMoreActivities,
  loadObservatorySlice,
  PublicApiError,
  type ObservatorySlice,
  type PublicCalendar,
  type PublicActivity,
  type PublicActivityDetail,
} from './api.ts'
import { EquityChart } from './EquityChart.tsx'
import css from './App.module.css'

type LoadState = {
  loading: boolean
  data: ObservatorySlice | null
  query: string
  error: string | null
}

const currency = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2,
})
const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function offsetDate(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function money(value: string | null | undefined): string {
  return value == null ? '—' : currency.format(Number(value))
}

function percent(value: string | null | undefined): string {
  return value == null ? '—' : `${(Number(value) * 100).toFixed(2)}%`
}

function compactMoney(value: string | null | undefined): string {
  if (value == null) return '—'
  const amount = Number(value)
  const scale = Math.abs(amount) >= 1e8 ? 1e8 : Math.abs(amount) >= 1e4 ? 1e4 : Math.abs(amount) >= 1e3 ? 1e3 : 1
  const unit = scale === 1e8 ? '亿' : scale === 1e4 ? '万' : scale === 1e3 ? '千' : ''
  return `${Number((amount / scale).toFixed(2))}${unit}`
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

const categoryLabels = { research: '研究', operation: '操作', system: '系统' } as const
const categoryOptions = [{ value: 'all', label: '全部' }, { value: 'research', label: '研究' }, { value: 'operation', label: '操作' }, { value: 'system', label: '系统' }]
const statusOptions = [{ value: 'all', label: '全部' }, { value: 'completed', label: '完成' }, { value: 'failed', label: '失败 / 已回滚' }]

function Skeleton() {
  return <div className={css.skeleton} aria-label="正在加载公开数据"><i /><i /><i /></div>
}

export function App() {
  const today = useMemo(shanghaiToday, [])
  const [selectedDate, setSelectedDate] = useState(today)
  const [calendarMonth, setCalendarMonth] = useState(today.slice(0, 7))
  const [filters, setFilters] = useState({ category: 'all', status: 'all' })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [playbackDates, setPlaybackDates] = useState<string[]>([])
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const query = `${selectedDate}:${filters.category}:${filters.status}`
  const currentQuery = useRef(query)
  currentQuery.current = query
  const detailRequest = useRef(0)
  const loadGeneration = useRef(0)
  const firstPagePending = useRef(true)
  const [state, setState] = useState<LoadState>({ loading: true, data: null, query, error: null })
  const [holdingsOpen, setHoldingsOpen] = useState(false)
  const [activitiesOpen, setActivitiesOpen] = useState(false)
  const [activityDetail, setActivityDetail] = useState<PublicActivityDetail | null>(null)
  const [activityDetailLoading, setActivityDetailLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++loadGeneration.current
    firstPagePending.current = true
    setState(current => ({ ...current, data: current.query === query && current.data !== null ? { ...current.data, accountLoading: true, activitiesLoading: true } : null, query, loading: true, error: null }))
    setLoadingMore(false)
    setMoreError(false)
    void loadObservatorySlice(selectedDate, filters, controller.signal, (result, part) => {
      if (controller.signal.aborted || generation !== loadGeneration.current) return
      if (part === 'activities') firstPagePending.current = false
      setState(current => {
        const base = current.query === query && current.data !== null ? current.data : result
        const data = part === 'account'
          ? { ...base, account: result.account, accountUnavailable: result.accountUnavailable, accountError: result.accountError, accountLoading: false }
          : { ...base, activities: result.activities, activitiesError: result.activitiesError, activitiesLoading: false }
        return { loading: data.accountLoading || data.activitiesLoading, data, query, error: null }
      })
      if (part === 'activities') setActivityDetail(current => {
        if (current === null || result.activities?.items.some(item => item.public_id === current.public_id)) return current
        detailRequest.current += 1
        return null
      })
    })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof PublicApiError ? error.message : '公开数据加载失败，请稍后重试。'
        if (!controller.signal.aborted) setState({ loading: false, data: null, query, error: message })
      })
    return () => { controller.abort() }
  }, [filters, query, refreshVersion, selectedDate])

  useEffect(() => {
    detailRequest.current += 1
    setActivityDetail(null)
    setDetailError(null)
  }, [query])

  useEffect(() => { setCalendarMonth(selectedDate.slice(0, 7)) }, [selectedDate])

  useEffect(() => {
    if (!autoRefresh || selectedDate !== today) return
    const timer = window.setInterval(() => { setRefreshVersion(value => value + 1) }, 15_000)
    return () => { window.clearInterval(timer) }
  }, [autoRefresh, selectedDate, today])

  useEffect(() => {
    if (!playing || playbackDates.length === 0) return
    const timer = window.setInterval(() => {
      setSelectedDate((current) => {
        const index = playbackDates.indexOf(current)
        if (index < 0 || index >= playbackDates.length - 1) {
          setPlaying(false)
          return current
        }
        return playbackDates[index + 1] ?? current
      })
    }, 1_200)
    return () => { window.clearInterval(timer) }
  }, [playbackDates, playing])

  useEffect(() => {
    if (state.data?.account == null || state.data.account.calendar.month === calendarMonth) return
    const controller = new AbortController()
    void loadCalendar(calendarMonth, controller.signal).then((calendar) => {
      if (controller.signal.aborted) return
      setState(current => current.data?.account == null ? current : ({
        ...current,
        data: { ...current.data, account: { ...current.data.account, calendar } },
      }))
    }).catch(() => {})
    return () => { controller.abort() }
  }, [calendarMonth, state.data])

  const slice = state.query === query ? state.data : null
  const data = slice?.account ?? null
  const overview = data?.overview
  const pnl = Number(overview?.summary.cumulative_profit_loss ?? 0)
  const minDate = data?.equity.points[0]?.date

  function selectDate(value: string): void {
    setPlaying(false)
    setSelectedDate(value)
  }

  function togglePlayback(): void {
    if (playing) {
      setPlaying(false)
      return
    }
    const dates = data?.equity.points.map(point => point.date) ?? []
    if (dates.length === 0) return
    setPlaybackDates(dates)
    setSelectedDate(dates[0] ?? today)
    setPlaying(dates.length > 1)
  }

  async function showActivity(item: PublicActivity): Promise<void> {
    const requestId = ++detailRequest.current
    setActivityDetailLoading(true)
    setDetailError(null)
    setActivityDetail({ ...item, related_snapshot_id: null })
    try {
      const detail = await loadActivityDetail(item.public_id)
      if (detailRequest.current === requestId) setActivityDetail(detail)
    }
    catch (error) {
      if (detailRequest.current !== requestId) return
      if (error instanceof PublicApiError && [403, 404].includes(error.status)) {
        setActivityDetail(null)
        setDetailError('该记录已不可用，正在重新读取公开记录。')
        setRefreshVersion(value => value + 1)
      }
      else setDetailError('详情加载失败，当前仅展示已读取的摘要。')
    }
    finally { if (detailRequest.current === requestId) setActivityDetailLoading(false) }
  }

  async function loadMore(): Promise<void> {
    const activities = slice?.activities
    if (firstPagePending.current || activities?.next_cursor == null) return
    const generation = loadGeneration.current
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await loadMoreActivities(selectedDate, filters, activities.next_cursor)
      if (currentQuery.current !== query || generation !== loadGeneration.current) return
      setState(current => current.data === null || current.query !== query || generation !== loadGeneration.current || current.data.activities?.next_cursor !== activities.next_cursor ? current : ({
        ...current,
        data: {
          ...current.data,
          activities: {
            ...page,
            items: [...new Map([...(current.data.activities?.items ?? []), ...page.items].map(item => [item.public_id, item])).values()],
          },
        },
      }))
    }
    catch (error: unknown) {
      if (currentQuery.current !== query || generation !== loadGeneration.current) return
      if (error instanceof PublicApiError && error.status === 409) {
        // 许可／索引变化后旧页和在途详情同时失效，不继续重试旧游标。
        loadGeneration.current += 1
        detailRequest.current += 1
        firstPagePending.current = true
        setActivityDetail(null)
        setActivityDetailLoading(false)
        setLoadingMore(false)
        setDetailError('记录范围已更新，已清除旧分页。')
        setState(current => current.data === null ? current : ({
          ...current,
          data: { ...current.data, activities: null, activitiesLoading: true, activitiesError: false },
        }))
        setRefreshVersion(value => value + 1)
      }
      else setMoreError(true)
    }
    finally { if (generation === loadGeneration.current) setLoadingMore(false) }
  }

  const operationsPanel = (
    <section className={css.panel} aria-label="操作与运行过程">
      <div className={css.heading}><div><h2>操作与运行过程</h2><p>截至 {selectedDate} · 独立于资金快照</p></div><Button variant="ghost" disabled={!slice?.activities?.items.length} onClick={() => { setActivitiesOpen(true) }}>展开记录</Button></div>
      <div className={css.filters} role="group" aria-label="操作记录筛选">
        <label className={css.filterField}>类型<Select aria-label="记录类型" value={filters.category} options={categoryOptions} onValueChange={(category) => { setFilters(current => ({ ...current, category })) }} /></label>
        <label className={css.filterField}>状态<Select aria-label="记录状态" value={filters.status} options={statusOptions} onValueChange={(status) => { setFilters(current => ({ ...current, status })) }} /></label>
        {(filters.category !== 'all' || filters.status !== 'all') && <Button variant="ghost" onClick={() => { setFilters({ category: 'all', status: 'all' }) }}>清除筛选</Button>}
      </div>
      {(slice === null ? state.loading : slice.activitiesLoading) && <p role="status">正在读取操作记录…</p>}
      {detailError && <p role="status">{detailError}</p>}
      {slice?.activitiesError && <div className={css.partial} role="status"><span>操作记录暂时无法读取，账户数据独立加载。</span><Button variant="outline" disabled={slice.activitiesLoading} onClick={() => { setRefreshVersion(value => value + 1) }}>{slice.activitiesLoading ? '正在重试…' : '重试记录'}</Button></div>}
      <div className={css.activityList}>
        {slice?.activities?.items.length === 0 && <div className={css.empty}>{filters.category === 'all' && filters.status === 'all' ? '截至所选日期暂无已公开记录，不代表期间没有发生操作。' : '当前筛选条件下暂无公开记录。'}</div>}
        {slice?.activities?.items.map(item => (
          <button type="button" className={css.activityRow} key={item.public_id} onClick={() => { void showActivity(item) }}>
            <i data-status={item.status} /><span><small>{categoryLabels[item.category]} · {item.category === 'operation' ? '记录于 ' : ''}{localTime(item.occurred_at)}</small><strong>{item.title}</strong><em>{item.summary}</em></span>
          </button>
        ))}
        {moreError && <p role="status">更多记录加载失败，可重试。</p>}
        {slice?.activities?.next_cursor != null && <Button variant="outline" disabled={loadingMore || slice.activitiesLoading} onClick={() => { void loadMore() }}>{loadingMore ? '加载中…' : '加载更多'}</Button>}
      </div>
    </section>
  )

  return (
    <div className={css.app}>
      <header className={css.header}>
        <a className={css.brand} href="/" aria-label="投研智能体公开观察室首页">
          <img src={brandIcon} alt="" /><span><strong>投研智能体</strong><small>PUBLIC OBSERVATORY</small></span>
        </a>
        <div className={css.headerActions}>
          <Button variant="outline" onClick={() => { setDark(value => !value) }}>
            {dark ? '浅色' : '深色'}
          </Button>
        </div>
      </header>

      <section className={css.timebar} aria-label="全局时间切片">
        <div className={css.timeControls}>
          <Button variant="outline" disabled={minDate === undefined} onClick={() => { if (minDate) selectDate(minDate) }}>第一天</Button>
          <Button variant="outline" onClick={() => { selectDate(offsetDate(selectedDate, -1)) }} aria-label="前一日">←</Button>
          <DatePicker value={selectedDate} {...minDate === undefined ? {} : { min: minDate }} max={today} onChange={selectDate} />
          <Button variant="outline" disabled={selectedDate >= today} onClick={() => { selectDate(offsetDate(selectedDate, 1)) }} aria-label="后一日">→</Button>
          <Button variant="outline" onClick={() => { selectDate(today) }}>当日</Button>
          <Button variant="outline" disabled={(data?.equity.points.length ?? 0) === 0} onClick={togglePlayback}>{playing ? '暂停' : '播放'}</Button>
        </div>
        <div className={css.refreshControls}>
          <label><input type="checkbox" checked={autoRefresh} disabled={selectedDate !== today} onChange={event => { setAutoRefresh(event.currentTarget.checked) }} />{selectedDate === today ? '每 15 秒自动刷新' : '历史日期 · 自动刷新暂停'}</label>
          <Button variant="outline" disabled={state.loading || selectedDate !== today} onClick={() => { setRefreshVersion(value => value + 1) }}>刷新数据</Button>
        </div>
      </section>

      <main className={css.main}>
        <div className={css.heroTitle}>
          <div><p className={css.eyebrow}>ACCOUNT PERFORMANCE · UTC+8</p><h1>公开观察室</h1></div>
          <div className={css.marketStatus}><i />A 股 · 公开快照</div>
        </div>

        {state.loading && slice === null && <Skeleton />}
        {state.error !== null && slice === null && (
          <section className={css.messageCard} role="alert"><strong>暂时无法读取公开数据</strong><p>{state.error}</p><Button variant="outline" onClick={() => { setRefreshVersion(value => value + 1) }}>重试</Button></section>
        )}
        {slice?.accountLoading && <section className={css.messageCard} role="status">正在读取账户金额，操作记录单独加载。</section>}
        {slice !== null && !slice.accountLoading && data === null && (
          <section className={css.messageCard} aria-label="账户金额暂不可用"><strong>账户金额暂不可用</strong><p>{slice.accountError ?? slice.accountUnavailable?.message}</p><div className={css.missingMetrics}><span>总权益 <b>—</b></span><span>初始资金 <b>—</b></span><span>现金 <b>—</b></span><span>累计盈亏 <b>—</b></span></div><span>{slice.accountError ? '账户请求失败，暂时无法确认快照状态；下方操作记录独立加载。' : '尚无可公开的完整账户快照，不计算收益；下方操作记录独立展示。'}</span>{slice.accountError && <Button variant="outline" onClick={() => { setRefreshVersion(value => value + 1) }}>重试账户数据</Button>}</section>
        )}
        {data === null && operationsPanel}

        {data !== null && overview !== undefined && (
          <>
            {overview.freshness.stale && <div className={css.staleNotice}>行情数据可能陈旧：{overview.freshness.stale_reason ?? '数据源未更新'}</div>}

            <section className={css.summary} aria-label="盈亏概览">
              <div className={css.pnlBlock}>
                <span>截至 {overview.date.replaceAll('-', '.')} · 累计{pnl > 0 ? '盈利' : pnl < 0 ? '亏损' : '持平'}</span>
                <strong className={pnl > 0 ? css.positive : pnl < 0 ? css.negative : undefined}>{money(overview.summary.cumulative_profit_loss)}</strong>
                <p>{percent(overview.summary.cumulative_return)}</p>
                <div className={css.formulaHelp}><span>计算口径</span><HelpPopover label="查看计算口径"><p>盈亏 = 当前总权益 − 初始资金；收益率 = 盈亏 ÷ 初始资金。</p><p>总权益包含现金和持仓市值。页面只展示权威账户快照，不用仅持仓表现、影子账户或演示数据补齐缺口。</p></HelpPopover></div>
              </div>
              <div className={css.metricGrid}>
                <div><span>总权益</span><strong>{money(overview.summary.total_equity)}</strong><small>现金 + 持仓市值</small></div>
                <div><span>初始资金</span><strong>{money(overview.summary.initial_capital)}</strong><small>固定统计起点</small></div>
                <div><span>现金</span><strong>{money(overview.summary.cash)}</strong></div>
                <div><span>持仓市值</span><strong>{money(overview.summary.market_value)}</strong></div>
              </div>
            </section>

            <div className={css.statusline} aria-live="polite">
              <strong>{state.loading ? '正在获取最新数据' : '公开快照可用'}</strong>
              <span>记录 {localTime(overview.freshness.recorded_at)}</span>
              <span>行情 {localTime(overview.freshness.price_as_of)}</span>
              <span>版本 {overview.data_revision}</span>
            </div>

            <section className={css.panel}>
              <div className={css.heading}><div><h2>权益轨迹</h2><p>最近 90 日留存快照 · 不插值</p></div></div>
              <EquityChart points={data.equity.points} dark={dark} />
            </section>

            <div className={css.columns}>
              <section className={css.panel}>
                <div className={css.heading}><div><h2>持仓与现金</h2><p>{data.holdings.items.length} 个持仓</p></div><Button variant="ghost" onClick={() => { setHoldingsOpen(true) }}>展开明细</Button></div>
                <div className={css.holdingList}>
                  {data.holdings.items.length === 0 ? <div className={css.empty}>暂无持仓，账户权益全部为现金。</div> : data.holdings.items.slice(0, 5).map(item => (
                    <div className={css.holdingRow} key={item.ticker}>
                      <div><strong>{item.name || item.ticker}</strong><small>{item.ticker} · {integer.format(Number(item.quantity))} 份</small></div>
                      <div><strong>{money(item.market_value)}</strong><small className={Number(item.profit_loss) >= 0 ? css.positive : css.negative}>{money(item.profit_loss)}</small></div>
                    </div>
                  ))}
                </div>
                <div className={css.cashRow}><span>现金</span><strong>{money(overview.summary.cash)}</strong></div>
              </section>

              {operationsPanel}
            </div>

            <section className={css.panel} aria-label="每日盈亏日历">
              <div className={css.heading}><div><h2>每日盈亏</h2><p>人民币 · 较上一留存快照</p></div><MonthPicker value={calendarMonth} onChange={setCalendarMonth} /></div>
              <Calendar month={calendarMonth} selectedDate={selectedDate} items={data.calendar.month === calendarMonth ? data.calendar.items : []} days={data.calendar.month === calendarMonth ? data.calendar.days ?? [] : []} onSelect={selectDate} />
            </section>
          </>
        )}

        <footer>公开内容仅用于项目过程验证，不构成投资建议。缺失值不按零处理。</footer>
      </main>

      <Modal open={holdingsOpen} onClose={() => { setHoldingsOpen(false) }} title="持仓明细" closeLabel="关闭持仓明细" className={css.wideModal}>
        <div className={css.tableWrap}><table><caption>{selectedDate} 的全部公开持仓</caption><thead><tr><th>证券</th><th>数量</th><th>成本价</th><th>估值价</th><th>市值</th><th>盈亏</th></tr></thead><tbody>{data?.holdings.items.map(item => <tr key={item.ticker}><td><strong>{item.name || item.ticker}</strong><small>{item.ticker}</small></td><td>{integer.format(Number(item.quantity))}</td><td>{money(item.cost_price)}</td><td>{money(item.market_price)}</td><td>{money(item.market_value)}</td><td className={Number(item.profit_loss) >= 0 ? css.positive : css.negative}>{money(item.profit_loss)}<small>{percent(item.return_rate)}</small></td></tr>)}</tbody></table></div>
      </Modal>
      <Modal open={activitiesOpen} onClose={() => { setActivitiesOpen(false) }} title="操作与运行过程" closeLabel="关闭运行过程" className={css.wideModal}>
        <div className={css.activityList}>
          {slice?.activities?.items.length === 0 && <div className={css.empty}>当前筛选条件下暂无公开记录。</div>}
          {slice?.activities?.items.map(item => (
            <button type="button" className={css.activityRow} key={item.public_id} onClick={() => { void showActivity(item) }}>
              <i data-status={item.status} /><span><small>{categoryLabels[item.category]} · {item.category === 'operation' ? '记录于 ' : ''}{localTime(item.occurred_at)}</small><strong>{item.title}</strong><em>{item.summary}</em></span>
            </button>
          ))}
        </div>
      </Modal>
      <Modal open={activityDetail !== null} onClose={() => { detailRequest.current += 1; setActivityDetail(null) }} title={activityDetail?.title ?? '活动详情'} closeLabel="关闭活动详情">
        {activityDetail !== null && <div className={css.modalCopy}><p className={css.detailMeta}>{categoryLabels[activityDetail.category]} · {activityDetail.category === 'operation' ? '记录于 ' : ''}{localTime(activityDetail.occurred_at)}</p><p>{activityDetail.summary}</p>{activityDetailLoading && <p>正在核对详情…</p>}{detailError && <p role="status">{detailError}</p>}{activityDetail.related_snapshot_id !== null && <p>关联公开快照：<code>{activityDetail.related_snapshot_id}</code></p>}
          {activityDetail.holdings_changes === null && <p>历史持仓字段不完整，无法核对数量与成本变化。</p>}
          {activityDetail.holdings_changes?.length === 0 && <p>持仓数量与成本未发生变化。</p>}
          {(activityDetail.holdings_changes?.length ?? 0) > 0 && <div className={css.tableWrap}><table><caption>持仓记录变化（非成交）</caption><thead><tr><th>证券代码</th><th>数量（前 → 后）</th><th>成本价（前 → 后）</th></tr></thead><tbody>{activityDetail.holdings_changes?.map(change => <tr key={change.ticker}><td>{change.ticker}</td><td>{integer.format(Number(change.before_quantity))} → {integer.format(Number(change.after_quantity))}</td><td>{money(change.before_cost_price)} → {money(change.after_cost_price)}</td></tr>)}</tbody></table></div>}
        </div>}
      </Modal>
    </div>
  )
}

function Calendar({ month, selectedDate, items, days: tradingDays, onSelect }: {
  month: string
  selectedDate: string
  items: PublicCalendar['items']
  days: PublicCalendar['days']
  onSelect: (value: string) => void
}) {
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(year ?? 1970, (monthNumber ?? 1) - 1, 1)
  const blanks = (first.getDay() + 6) % 7
  const days = new Date(year ?? 1970, monthNumber ?? 1, 0).getDate()
  const values = new Map(items.map(item => [item.date, item]))
  const statuses = new Map(tradingDays.map(item => [item.date, item.trading_status]))
  const statusLabels = { trading: '交易日', closed: '休市', unknown: '待确认' }
  return (
    <div className={css.calendar}>
      <div className={css.weekdays}>{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
      <div className={css.calendarGrid}>
        {Array.from({ length: blanks }, (_, index) => <span key={`blank-${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const day = index + 1
          const date = `${month}-${String(day).padStart(2, '0')}`
          const item = values.get(date)
          const status = statuses.get(date) ?? 'unknown'
          const label = `${date}，${status === 'unknown' ? '交易日待确认' : statusLabels[status]}，${item === undefined ? '无账户快照' : `盈亏 ${money(item.daily_profit_loss)}`}`
          return <button type="button" key={date} disabled={item === undefined} data-selected={date === selectedDate} data-trading-status={status} aria-label={label} title={label} onClick={() => { onSelect(date) }}><span>{day}</span><small>{statusLabels[status]}</small><strong className={item === undefined || item.daily_profit_loss === null ? undefined : Number(item.daily_profit_loss) >= 0 ? css.positive : css.negative}><span className={css.calendarAmountFull}>{money(item?.daily_profit_loss)}</span><span className={css.calendarAmountCompact}>{compactMoney(item?.daily_profit_loss)}</span></strong></button>
        })}
      </div>
      <p className={css.calendarStatus}>{items.length === 0 ? '本月暂无留存快照' : `${items.length} 个账户快照`}</p>
      {tradingDays.length === 0 || tradingDays.some(day => day.trading_status === 'unknown') ? <p className={css.calendarStatus}>部分日期的交易日历待确认</p> : null}
    </div>
  )
}
