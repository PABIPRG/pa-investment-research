export interface PublicHolding {
  ticker: string
  name: string
  quantity: string
  cost_price: string
  market_price: string | null
  market_value: string | null
  profit_loss: string | null
  return_rate: string | null
}

export interface PublicLiveAvailable {
  availability: 'available'
  date: string
  currency: 'CNY'
  source: 'current_holdings' | 'recorded_holdings'
  holdings_as_of: string
  summary: {
    holdings_cost: string
    market_value: string | null
    floating_profit_loss: string | null
    cost_return: string | null
    cash: null
    initial_capital: null
    total_equity: null
  }
  items: PublicHolding[]
  freshness: { stale: boolean; message: string | null }
}

export interface PublicLiveUnavailable {
  availability: 'unavailable'
  reason_code: string
  message: string
}

export type PublicLive = PublicLiveAvailable | PublicLiveUnavailable
export interface HistoryPoint { date: string; value: string | null; profit_loss: string | null }
export interface PublicHistory {
  from: string
  to: string
  currency: 'CNY'
  quality: 'unavailable' | 'partial' | 'estimated'
  limitations: string[]
  available_since: string | null
  points: HistoryPoint[]
}
export interface CalendarItem { date: string; daily_profit_loss: string | null }
export interface PublicCalendar {
  month: string
  items: CalendarItem[]
  days: Array<{ date: string; trading_status: 'trading' | 'closed' | 'unknown' }>
  limitations: string[]
}
export interface PublicActivity {
  public_id: string
  category: 'research' | 'operation' | 'system'
  status: 'completed' | 'failed'
  occurred_at: string
  title: string
  summary: string
}
export interface PublicActivities { as_of: string; items: PublicActivity[]; next_cursor: string | null }
export interface PublicActivityDetail extends PublicActivity {
  related_snapshot_id: string | null
  holdings_changes?: Array<{
    ticker: string
    name?: string
    before_quantity: string
    after_quantity: string
    before_cost_price: string | null
    after_cost_price: string | null
  }> | null
}
export interface ObservatorySlice {
  retryAfterMs?: number
  liveLoading: boolean
  historyLoading: boolean
  calendarLoading: boolean
  activitiesLoading: boolean
  live: PublicLive | null
  liveError: boolean
  history: PublicHistory | null
  historyError: boolean
  calendar: PublicCalendar | null
  calendarError: boolean
  activities: PublicActivities | null
  activitiesError: boolean
}
export class PublicApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs = status === 429 ? 60_000 : 0) { super(message) }
}
function configuredBaseUrl(): string {
  const value = import.meta.env.VITE_PUBLIC_API_BASE_URL?.trim()
  if (!value) throw new PublicApiError(0, '公开数据服务尚未配置。')
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) throw new PublicApiError(0, '公开数据服务地址必须使用 HTTPS。')
  return url.origin
}
async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, `${configuredBaseUrl()}/`)
  const controller = new AbortController()
  const abort = () => { controller.abort(signal?.reason) }
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeoutError = new PublicApiError(0, '公开数据读取超时，请稍后重试。')
  const timeout = setTimeout(() => { controller.abort(timeoutError) }, 30_000)
  try {
    const response = await fetch(url, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { accept: 'application/json' }, signal: controller.signal,
    })
    if (!response.ok) {
      let message = response.status === 404 ? '所选日期没有公开记录。' : '公开数据暂时不可用。'
      try {
        const body = await response.json() as { message?: unknown }
        if (typeof body.message === 'string') message = body.message
      }
      catch { /* keep the stable fallback */ }
      const retryAfter = response.headers.get('retry-after')
      const delay = retryAfter === null ? 0
        : /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
      const retryAfterMs = Math.max(response.status === 429 ? 60_000 : 0, Number.isFinite(delay) ? Math.min(delay, 2_147_483_647) : 0)
      throw new PublicApiError(response.status, message, retryAfterMs)
    }
    return await response.json() as T
  }
  catch (error) {
    if (signal?.aborted) throw signal.reason
    if (controller.signal.reason === timeoutError) throw timeoutError
    throw error
  }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function loadLive(date: string, signal?: AbortSignal): Promise<PublicLive> {
  return requestJson(`/api/public/performance/v1/live?date=${encodeURIComponent(date)}`, signal)
}
export function loadHistory(from: string, to: string, signal?: AbortSignal): Promise<PublicHistory> {
  return requestJson(`/api/public/performance/v1/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, signal)
}
/** 历史估值按 T+1 展示，截止北京时间昨日。 */
export function historyCutoff(date: string, today = shanghaiToday()): string {
  const yesterday = addDays(today, -1)
  return date < yesterday ? date : yesterday
}
export async function loadCalendar(month: string, signal?: AbortSignal, cutoff = historyCutoff(shanghaiToday())): Promise<PublicCalendar> {
  const [year, monthNumber] = month.split('-').map(Number)
  const end = `${month}-${String(new Date(year ?? 2000, monthNumber ?? 1, 0).getDate()).padStart(2, '0')}`
  const from = addDays(`${month}-01`, -1)
  const to = end > cutoff ? cutoff : end
  const [days, history] = await Promise.all([
    requestJson<{ days: PublicCalendar['days'] }>(`/api/public/performance/v1/calendar?month=${encodeURIComponent(month)}`, signal),
    from <= to ? loadHistory(from, to, signal) : Promise.resolve({ points: [], limitations: [] }),
  ])
  const statuses = new Map(days.days.map(day => [day.date, day.trading_status]))
  const points = [...history.points].sort((a, b) => a.date.localeCompare(b.date))
  const items = points.filter(point => point.date.startsWith(`${month}-`) && point.value !== null && statuses.get(point.date) !== 'closed').map((point) => {
    const prior = points.filter(row => row.date < point.date).at(-1)
    const daily = point.profit_loss !== null && prior?.profit_loss != null
      ? (Number(point.profit_loss) - Number(prior.profit_loss)).toFixed(2) : null
    return { date: point.date, daily_profit_loss: daily }
  })
  return { month, days: days.days, items, limitations: history.limitations }
}
/** 并行读取指定区块；实时轮询可排除按日更新的历史与日历；时间线固定为截至北京时间昨日的 90 日。 */
export async function loadObservatorySlice(
  date: string,
  filters: { category: string; status: string },
  signal: AbortSignal,
  onProgress?: (slice: ObservatorySlice, part: 'live' | 'history' | 'calendar' | 'activities') => void,
  parts: ReadonlyArray<'live' | 'history' | 'calendar' | 'activities'> = ['live', 'history', 'calendar', 'activities'],
): Promise<ObservatorySlice> {
  configuredBaseUrl()
  let result: ObservatorySlice = {
    liveLoading: parts.includes('live'), historyLoading: parts.includes('history'),
    calendarLoading: parts.includes('calendar'), activitiesLoading: parts.includes('activities'),
    live: null, liveError: false, history: null, historyError: false,
    calendar: null, calendarError: false, activities: null, activitiesError: false,
  }
  function publish(part: 'live' | 'history' | 'calendar' | 'activities', update: Partial<ObservatorySlice>): void {
    result = { ...result, ...update }
    if (!signal.aborted) onProgress?.(result, part)
  }
  async function settle<T>(part: 'live' | 'history' | 'calendar' | 'activities', operation: Promise<T>, success: (value: T) => Partial<ObservatorySlice>, failed: Partial<ObservatorySlice>): Promise<void> {
    try { publish(part, success(await operation)) }
    catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      publish(part, {
        ...failed, retryAfterMs: Math.max(result.retryAfterMs ?? 0, error instanceof PublicApiError ? error.retryAfterMs : 0),
      })
    }
  }
  const timelineEnd = historyCutoff(shanghaiToday())
  await Promise.all([
    parts.includes('live') && settle('live', loadLive(date, signal), live => ({ live, liveLoading: false }), { liveLoading: false, liveError: true }),
    parts.includes('history') && settle('history', loadHistory(addDays(timelineEnd, -89), timelineEnd, signal), history => ({ history, historyLoading: false }), { historyLoading: false, historyError: true }),
    parts.includes('calendar') && settle('calendar', loadCalendar(date.slice(0, 7), signal), calendar => ({ calendar, calendarLoading: false }), { calendarLoading: false, calendarError: true }),
    parts.includes('activities') && settle('activities', requestJson<PublicActivities>(`/api/public/performance/v1/activities?as_of=${encodeURIComponent(date)}&category=${encodeURIComponent(filters.category)}&status=${encodeURIComponent(filters.status)}&limit=20`, signal), activities => ({ activities, activitiesLoading: false }), { activitiesLoading: false, activitiesError: true }),
  ])
  return result
}
export function loadActivityDetail(publicId: string, signal?: AbortSignal): Promise<PublicActivityDetail> {
  return requestJson(`/api/public/performance/v1/activities/${encodeURIComponent(publicId)}`, signal)
}
export function loadMoreActivities(
  asOf: string, filters: { category: string; status: string }, cursor: string, signal?: AbortSignal,
): Promise<PublicActivities> {
  return requestJson(`/api/public/performance/v1/activities?as_of=${encodeURIComponent(asOf)}&category=${encodeURIComponent(filters.category)}&status=${encodeURIComponent(filters.status)}&cursor=${encodeURIComponent(cursor)}&limit=20`, signal)
}

export interface PublicBundle {
  from: string
  to: string
  currency: 'CNY'
  data_version: string
  available_dates: string[]
  frames: PublicLiveAvailable[]
  history: PublicHistory
  calendars: PublicCalendar[]
  activities: PublicActivityDetail[]
  activities_status: 'ready' | 'truncated' | 'error'
}
/** 一次读取当前 90 日的 T+1 批次；浏览操作只使用返回的数据。 */
export function loadBundle(today: string, signal?: AbortSignal): Promise<PublicBundle> {
  const to = historyCutoff(today, today)
  return requestJson(`/api/public/performance/v1/bundle?from=${addDays(to, -89)}&to=${to}`, signal)
}
/** 非有效日定位到前一有效日；早于区间时定位首日。 */
export function availableDate(dates: readonly string[], requested: string | null): string {
  return (requested === null ? dates.at(-1) : dates.findLast(date => date <= requested) ?? dates[0]) ?? ''
}
