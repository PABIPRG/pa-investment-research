// market-watch 适配器 JSON 客户端（无 SSE：所有盯盘操作秒级同步返回）
// 纯 Node fetch，与 dsh 解耦，可独立测试。返回类型与 index.ts 的 output.schema 对齐。

import type { JsonValue } from '@deepseek-ai/dsh-session'

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

export function watchAdd(
  baseUrl: string,
  body: { code: string; name?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; duplicate: boolean; code: string; name: string }> {
  return httpJson(baseUrl, '/watchlist/add', 'POST', body, signal)
}

export function watchRemove(
  baseUrl: string,
  body: { code: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; removed: boolean; code: string }> {
  return httpJson(baseUrl, '/watchlist/remove', 'POST', body, signal)
}

export function watchList(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ items: Array<{ code: string; name: string; added_at?: string }>; count: number }> {
  return httpJson(baseUrl, '/watchlist', 'GET', undefined, signal)
}

// ---- 盯盘规则 ------------------------------------------------------------

export interface AlertConditionInput {
  field: string
  operator: string
  value: number
}

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

export function listAlerts(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ items: JsonValue[]; count: number }> {
  return httpJson(baseUrl, '/alerts', 'GET', undefined, signal)
}

export function removeAlert(
  baseUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; removed: boolean; id: string }> {
  return httpJson(baseUrl, `/alerts/${id}`, 'DELETE', undefined, signal)
}

// ---- 扫描 / 面板 / 技术信号 -----------------------------------------------

export function scanMovers(
  baseUrl: string,
  body: { kind: string; top_n?: number; min_amount_yi?: number },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/scan', 'POST', body, signal)
}

export function watchOverview(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ items: JsonValue[]; trade_date?: string }> {
  return httpJson(baseUrl, '/overview', 'GET', undefined, signal)
}

export function techSignal(
  baseUrl: string,
  body: { code: string; lookback?: number },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/tech-signal', 'POST', body, signal)
}

// ---- 新闻 / 简报 ---------------------------------------------------------

export function newsExpress(baseUrl: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/news/express', 'POST', undefined, signal)
}

export function dailyBrief(
  baseUrl: string,
  body: { period: string; manual?: boolean },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/brief/generate', 'POST', body, signal)
}
