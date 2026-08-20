// market-watch 适配器 JSON 客户端（无 SSE：所有盯盘操作秒级同步返回）
// 纯 Node fetch，与 dsh 解耦，可独立测试。返回类型与 index.ts 的 output.schema 对齐。

import type { JsonValue } from '@deepseek-ai/dsh-session'

/**
 * Send one JSON request to the market-watch adapter.
 * @param baseUrl - Adapter origin without a trailing route.
 * @param path - Absolute adapter route beginning with `/`.
 * @param method - HTTP method; defaults to `GET`.
 * @param body - JSON object serialized for request methods that need a body.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's decoded JSON response.
 * @throws Rejects when request serialization, fetch, JSON decoding, or a non-success response fails.
 */
export async function httpJson<T = unknown>(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  if (signal !== undefined) init.signal = signal
  const res = await fetch(`${baseUrl}${path}`, init)
  if (!res.ok) {
    throw new Error(`适配器 HTTP ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

// ---- 自选 ---------------------------------------------------------------

/**
 * Add one ticker to the adapter-owned watchlist.
 * @param baseUrl - Adapter origin.
 * @param body - Ticker code and optional display name.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's add or duplicate outcome.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function watchAdd(
  baseUrl: string,
  body: { code: string; name?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; duplicate: boolean; code: string; name: string }> {
  return httpJson(baseUrl, '/watchlist/add', 'POST', body, signal)
}

/**
 * Remove one ticker from the adapter-owned watchlist.
 * @param baseUrl - Adapter origin.
 * @param body - Ticker code to remove.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns Whether the adapter removed the ticker.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function watchRemove(
  baseUrl: string,
  body: { code: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; removed: boolean; code: string }> {
  return httpJson(baseUrl, '/watchlist/remove', 'POST', body, signal)
}

/**
 * Read the adapter-owned watchlist in insertion order.
 * @param baseUrl - Adapter origin.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns Watchlist entries and their count.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function watchList(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ items: Array<{ code: string; name: string; added_at?: string }>; count: number }> {
  return httpJson(baseUrl, '/watchlist', 'GET', undefined, signal)
}

// ---- 盯盘规则 ------------------------------------------------------------

/** One numeric condition accepted by an adapter alert rule. */
export interface AlertConditionInput {
  field: string
  operator: string
  value: number
}

/**
 * Persist one alert rule in the adapter.
 * @param baseUrl - Adapter origin.
 * @param body - Rule scope, conditions, combination mode, and delivery guards.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The stored rule identifier and JSON record.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function addAlert(
  baseUrl: string,
  body: {
    name: string
    ticker?: string
    combine?: string
    conditions: AlertConditionInput[]
    cooldown_min?: number
    daily_cap?: number
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; id: string; rule: JsonValue }> {
  return httpJson(baseUrl, '/alerts', 'POST', body, signal)
}

/**
 * Read every persisted alert rule.
 * @param baseUrl - Adapter origin.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns Alert-rule JSON records and their count.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function listAlerts(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ items: JsonValue[]; count: number }> {
  return httpJson(baseUrl, '/alerts', 'GET', undefined, signal)
}

/**
 * Delete one persisted alert rule.
 * @param baseUrl - Adapter origin.
 * @param id - Rule identifier placed directly in the adapter route.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns Whether the adapter removed the rule.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function removeAlert(
  baseUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; removed: boolean; id: string }> {
  return httpJson(baseUrl, `/alerts/${id}`, 'DELETE', undefined, signal)
}

// ---- 扫描 / 面板 / 技术信号 -----------------------------------------------

/**
 * Run one synchronous market-mover scan.
 * @param baseUrl - Adapter origin.
 * @param body - Scan kind and optional ranking filters.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless scan JSON.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function scanMovers(
  baseUrl: string,
  body: { kind: string; top_n?: number; min_amount_yi?: number },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/scan', 'POST', body, signal)
}

/**
 * Read the current quote and alert state for every watched ticker.
 * @param baseUrl - Adapter origin.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns Overview rows and the associated trade date.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function watchOverview(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ items: JsonValue[]; trade_date?: string }> {
  return httpJson(baseUrl, '/overview', 'GET', undefined, signal)
}

/**
 * Calculate synchronous technical signals for one ticker.
 * @param baseUrl - Adapter origin.
 * @param body - Ticker code and optional lookback length.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless indicator JSON.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function techSignal(
  baseUrl: string,
  body: { code: string; lookback?: number },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/tech-signal', 'POST', body, signal)
}

// ---- 新闻 / 简报 ---------------------------------------------------------

/**
 * Generate the latest market and watchlist news digest.
 * @param baseUrl - Adapter origin.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless news JSON.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function newsExpress(baseUrl: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/news/express', 'POST', undefined, signal)
}

/**
 * Generate a pre-market or post-market brief synchronously.
 * @param baseUrl - Adapter origin.
 * @param body - Brief period and manual trading-day override.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless brief JSON.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function dailyBrief(
  baseUrl: string,
  body: { period: string; manual?: boolean },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/brief/generate', 'POST', body, signal)
}
