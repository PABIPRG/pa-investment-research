// market-watch 适配器 JSON 客户端（盯盘/快讯，纯 Node fetch，与 dsh 解耦可独立测试）
// 返回类型与 index.ts 的 output.schema 对齐。中文 keyword/搜索词由 URLSearchParams
// 自动 UTF-8 编码，避免 GBK 乱码。
//
// 注意：items 元素必须是 type 别名（含可选标量字段），不能是 interface 或 Record<string, unknown>[]，
// 否则 defineTool 的 execute 返回类型推导（schema 派生 JsonValue）会报类型不兼容：
//   - interface 没有隐式索引签名，无法赋给 {[key: string]: JsonValue}
//   - Record<string, unknown> 的 value 是 unknown，不属于 JsonValue

export async function httpJson<T = unknown>(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) {
    throw new Error(`适配器 HTTP ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

// ---- 共享结构（type 别名，JsonValue 兼容；嵌套数组用内联对象类型） ----

export type FlashItem = {
  id?: string
  time?: string
  tag?: string
  title?: string
  content?: string
  source?: string
}

export type EventItem = {
  id?: string
  type?: string
  direction?: string
  tickers?: Array<{ name?: string; code?: string }>
  industries?: string[]
  summary?: string
  title?: string
  time?: string
  source?: string
}

export type AlertItem = {
  id?: string
  title?: string
  summary?: string
  codes?: string[]
  ts?: string
}

export type QuoteItem = {
  code?: string
  name?: string
  price?: number
  pct_change?: number
  amount_yi?: number
  turnover?: number
  hit?: Array<{ name?: string; code?: string }>
  near?: Array<{ name?: string; code?: string }>
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type SnapshotMeta = {
  trade_date: string
  as_of: string
  source: string
  stale: boolean
  complete: boolean
  warnings: string[]
}

export type ScanSnapshot = (
  | { kind: 'gainers' | 'volume_ratio' | 'turnover' | 'amount'; items: QuoteItem[] }
  | { kind: 'limit'; limit_up: QuoteItem[]; limit_down: QuoteItem[] }
) & SnapshotMeta

export type TechSignalSnapshot =
  | {
      status: 'ready'
      code: string
      name: string
      as_of: string
      stale: boolean
      bars: number
      last: JsonValue
      indicators: JsonValue
      signals: JsonValue[]
    }
  | {
      status: 'preparing'
      code: string
      as_of: string | null
      retry_after_ms: number
      message: string
    }
  | {
      status: 'unavailable'
      code: string
      as_of: string | null
      reason_code: string
      message: string
      retryable: boolean
    }

// ---- 实时快讯流 ----------------------------------------------------------

export function flash(
  baseUrl: string,
  body: { limit?: number },
  signal?: AbortSignal,
): Promise<{
  as_of: string
  sources: string[]
  tier: 'base' | 'full'
  complete: boolean
  stale: boolean
  items: FlashItem[]
}> {
  const qs = new URLSearchParams()
  if (body.limit !== undefined) qs.set('limit', String(body.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return httpJson(baseUrl, `/news/flash${suffix}`, 'GET', undefined, signal)
}

// ---- 结构化投资事件 ------------------------------------------------------

export function events(
  baseUrl: string,
  body: { limit?: number },
  signal?: AbortSignal,
): Promise<{ as_of: string; count: number; items: EventItem[] }> {
  const qs = new URLSearchParams()
  if (body.limit !== undefined) qs.set('limit', String(body.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return httpJson(baseUrl, `/news/events${suffix}`, 'GET', undefined, signal)
}

// ---- 事件预警中心 --------------------------------------------------------

export function eventAlerts(
  baseUrl: string,
  body: { limit?: number },
  signal?: AbortSignal,
): Promise<{ as_of: string; items: AlertItem[]; watch: string[]; hold: string[] }> {
  const qs = new URLSearchParams()
  if (body.limit !== undefined) qs.set('limit', String(body.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return httpJson(baseUrl, `/news/event-alerts${suffix}`, 'GET', undefined, signal)
}

// ---- 盯盘面板 ------------------------------------------------------------

export function overview(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ as_of: string; trade_date: string; items: QuoteItem[] }> {
  return httpJson(baseUrl, '/overview', 'GET', undefined, signal)
}

// ---- 盘中异动扫描 --------------------------------------------------------

export function scan(
  baseUrl: string,
  body: { kind?: string },
  signal?: AbortSignal,
): Promise<ScanSnapshot> {
  return httpJson<ScanSnapshot>(baseUrl, '/scan', 'POST', body, signal)
}

// ---- 个股技术信号 --------------------------------------------------------

export function techSignal(
  baseUrl: string,
  body: { code: string },
  signal?: AbortSignal,
): Promise<TechSignalSnapshot> {
  return httpJson<TechSignalSnapshot>(baseUrl, '/tech-signal', 'POST', body, signal)
}

// ---- 最近简报 ------------------------------------------------------------

export function latestBrief(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/brief/latest', 'GET', undefined, signal)
}
