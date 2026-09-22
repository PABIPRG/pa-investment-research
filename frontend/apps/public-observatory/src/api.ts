export interface PublicOverviewAvailable {
  availability: 'available'
  snapshot_id: string
  data_revision: number
  date: string
  currency: 'CNY'
  summary: {
    initial_capital: string
    cash: string
    market_value: string
    total_equity: string
    cumulative_profit_loss: string
    cumulative_return: string
  }
  freshness: {
    recorded_at: string
    price_as_of: string
    stale: boolean
    stale_reason: string | null
  }
}

export interface PublicOverviewUnavailable {
  availability: 'unavailable'
  reason_code: string
  message: string
}

export type PublicOverview = PublicOverviewAvailable | PublicOverviewUnavailable

export interface PublicHolding {
  ticker: string
  name: string
  quantity: string
  cost_price: string
  market_price: string
  market_value: string
  profit_loss: string
  return_rate: string | null
}

export interface PublicHoldings {
  snapshot_id: string
  data_revision: number
  date: string
  currency: 'CNY'
  items: PublicHolding[]
}

export interface EquityPoint {
  date: string
  snapshot_id: string
  data_revision: number
  total_equity: string
  cumulative_profit_loss: string
  cumulative_return: string
}

export interface PublicEquity {
  from: string
  to: string
  currency: 'CNY'
  latest_revision: number | null
  points: EquityPoint[]
}

export interface CalendarItem {
  date: string
  snapshot_id: string
  data_revision: number
  total_equity: string
  daily_profit_loss: string | null
  daily_return: string | null
}

export interface PublicCalendar {
  month: string
  currency: 'CNY'
  items: CalendarItem[]
  days: Array<{ date: string; trading_status: 'trading' | 'closed' | 'unknown' }>
}

export interface PublicActivity {
  public_id: string
  category: 'research' | 'operation' | 'system'
  status: 'completed' | 'failed'
  occurred_at: string
  title: string
  summary: string
}

export interface PublicActivities {
  as_of: string
  items: PublicActivity[]
  next_cursor: string | null
}

export interface PublicActivityDetail extends PublicActivity {
  related_snapshot_id: string | null
  holdings_changes?: Array<{
    ticker: string
    before_quantity: string
    after_quantity: string
    before_cost_price: string | null
    after_cost_price: string | null
  }> | null
}

export interface AccountSlice {
  overview: PublicOverviewAvailable
  holdings: PublicHoldings
  equity: PublicEquity
  calendar: PublicCalendar
}

export interface ObservatorySlice {
  accountLoading: boolean
  activitiesLoading: boolean
  account: AccountSlice | null
  accountUnavailable: PublicOverviewUnavailable | null
  accountError: string | null
  activities: PublicActivities | null
  activitiesError: boolean
}

export class PublicApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function configuredBaseUrl(): string {
  const value = import.meta.env.VITE_PUBLIC_API_BASE_URL?.trim()
  if (!value) throw new PublicApiError(0, '公开数据服务尚未配置。')
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new PublicApiError(0, '公开数据服务地址必须使用 HTTPS。')
  }
  return url.origin
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, `${configuredBaseUrl()}/`), {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    let message = response.status === 404 ? '该日期没有留存快照。' : '公开数据暂时不可用。'
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

async function loadAccountSlice(
  date: string,
  signal: AbortSignal,
): Promise<AccountSlice | PublicOverviewUnavailable> {
  const overview = await requestJson<PublicOverview>(
    `/api/public/performance/v1/overview?date=${encodeURIComponent(date)}`,
    signal,
  )
  if (overview.availability === 'unavailable') return overview
  const month = date.slice(0, 7)
  const [holdings, equity, calendar] = await Promise.all([
    requestJson<PublicHoldings>(
      `/api/public/performance/v1/holdings?snapshot_id=${encodeURIComponent(overview.snapshot_id)}`,
      signal,
    ),
    requestJson<PublicEquity>(
      `/api/public/performance/v1/equity?from=${addDays(date, -89)}&to=${encodeURIComponent(date)}`,
      signal,
    ),
    requestJson<PublicCalendar>(
      `/api/public/performance/v1/calendar?month=${encodeURIComponent(month)}`,
      signal,
    ),
  ])
  if (holdings.snapshot_id !== overview.snapshot_id || holdings.data_revision !== overview.data_revision) {
    throw new PublicApiError(409, '数据版本发生变化，请重新加载。')
  }
  return {
    overview,
    holdings,
    equity,
    calendar,
  }
}

/** 账户资金与操作记录独立读取；任一不可用不伪造另一类数据。 */
export async function loadObservatorySlice(
  date: string,
  filters: { category: string; status: string },
  signal: AbortSignal,
  onProgress?: (slice: ObservatorySlice, part: 'account' | 'activities') => void,
): Promise<ObservatorySlice> {
  configuredBaseUrl()
  let result: ObservatorySlice = {
    accountLoading: true, activitiesLoading: true, account: null, accountUnavailable: null,
    accountError: null, activities: null, activitiesError: false,
  }
  function publish(part: 'account' | 'activities', update: Partial<ObservatorySlice>): void {
    result = { ...result, ...update }
    if (!signal.aborted) onProgress?.(result, part)
  }
  await Promise.all([
    loadAccountSlice(date, signal).then(value => ({ value, error: null })).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      return { value: null, error: error instanceof PublicApiError ? error.message : '账户数据加载失败，请重试。' }
    }).then(account => {
      publish('account', { accountLoading: false,
        account: account.value !== null && !('availability' in account.value) ? account.value : null,
        accountUnavailable: account.value !== null && 'availability' in account.value ? account.value : null,
        accountError: account.error,
      })
    }),
    requestJson<PublicActivities>(
      `/api/public/performance/v1/activities?as_of=${encodeURIComponent(date)}&category=${encodeURIComponent(filters.category)}&status=${encodeURIComponent(filters.status)}&limit=20`,
      signal,
    ).then(value => ({ value, failed: false })).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      return { value: null, failed: true }
    }).then(activities => { publish('activities', { activitiesLoading: false, activities: activities.value, activitiesError: activities.failed }) }),
  ])
  return result
}

export function loadActivityDetail(publicId: string, signal?: AbortSignal): Promise<PublicActivityDetail> {
  return requestJson(`/api/public/performance/v1/activities/${encodeURIComponent(publicId)}`, signal)
}

export function loadCalendar(month: string, signal?: AbortSignal): Promise<PublicCalendar> {
  return requestJson(`/api/public/performance/v1/calendar?month=${encodeURIComponent(month)}`, signal)
}

export function loadMoreActivities(
  asOf: string,
  filters: { category: string; status: string },
  cursor: string,
  signal?: AbortSignal,
): Promise<PublicActivities> {
  return requestJson(
    `/api/public/performance/v1/activities?as_of=${encodeURIComponent(asOf)}&category=${encodeURIComponent(filters.category)}&status=${encodeURIComponent(filters.status)}&cursor=${encodeURIComponent(cursor)}&limit=20`,
    signal,
  )
}
