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
  constructor(readonly status: number, message: string) { super(message) }
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
  const response = await fetch(new URL(path, `${configuredBaseUrl()}/`), {
    method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { accept: 'application/json' }, ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    let message = response.status === 404 ? '所选日期没有公开记录。' : '公开数据暂时不可用。'
    try {
      const body = await response.json() as { message?: unknown }
      if (typeof body.message === 'string') message = body.message
    }
    catch { /* keep the stable fallback */ }
    throw new PublicApiError(response.status, message)
  }
  return await response.json() as T
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
export async function loadCalendar(month: string, signal?: AbortSignal): Promise<PublicCalendar> {
  const [year, monthNumber] = month.split('-').map(Number)
  const end = `${month}-${String(new Date(year ?? 2000, monthNumber ?? 1, 0).getDate()).padStart(2, '0')}`
  const today = shanghaiToday()
  const [days, history] = await Promise.all([
    requestJson<{ days: PublicCalendar['days'] }>(`/api/public/performance/v1/calendar?month=${encodeURIComponent(month)}`, signal),
    loadHistory(addDays(`${month}-01`, -1), end > today ? today : end, signal),
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
/** 各公开区块并行读取；历史时间线固定为截至当日的 90 日，详情按所选日期读取。 */
export async function loadObservatorySlice(
  date: string,
  filters: { category: string; status: string },
  signal: AbortSignal,
  onProgress?: (slice: ObservatorySlice, part: 'live' | 'history' | 'calendar' | 'activities') => void,
): Promise<ObservatorySlice> {
  configuredBaseUrl()
  const timelineEnd = shanghaiToday()
  let result: ObservatorySlice = {
    liveLoading: true, historyLoading: true, calendarLoading: true, activitiesLoading: true,
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
      publish(part, failed)
    }
  }
  await Promise.all([
    settle('live', loadLive(date, signal), live => ({ live, liveLoading: false }), { liveLoading: false, liveError: true }),
    settle('history', loadHistory(addDays(timelineEnd, -89), timelineEnd, signal), history => ({ history, historyLoading: false }), { historyLoading: false, historyError: true }),
    settle('calendar', loadCalendar(date.slice(0, 7), signal), calendar => ({ calendar, calendarLoading: false }), { calendarLoading: false, calendarError: true }),
    settle('activities', requestJson<PublicActivities>(`/api/public/performance/v1/activities?as_of=${encodeURIComponent(date)}&category=${encodeURIComponent(filters.category)}&status=${encodeURIComponent(filters.status)}&limit=20`, signal), activities => ({ activities, activitiesLoading: false }), { activitiesLoading: false, activitiesError: true }),
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
