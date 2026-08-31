export type JsonRecord = Record<string, unknown>

export function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

export function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

export function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function percent(value: unknown): string {
  const resolved = number(value)
  if (resolved === undefined) return '—'
  return `${resolved > 0 ? '+' : ''}${resolved.toFixed(2)}%`
}

export function money(value: unknown): string {
  const resolved = number(value)
  return resolved === undefined ? '—' : `¥${resolved.toFixed(2)}`
}

/** 大额缩写：¥xx.xx 亿 / ¥xx.x 万 / ¥1,234（整数取整）。 */
export function compactMoney(value: number): string {
  if (value >= 100_000_000) return `¥${(value / 100_000_000).toFixed(2)} 亿`
  if (value >= 10_000) return `¥${(value / 10_000).toFixed(1)} 万`
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}

/** 持仓实时行情自动刷新周期。报价源 ulist 短缓存 10s，60s 轮询对齐”实时”直觉。 */
export const QUOTE_REFRESH_MS = 60_000

/** 行情失败后快速重试间隔。后端 ulist 短缓存 10s 会去重重复请求，重试不额外压源。 */
export const QUOTE_RETRY_MS = 8_000

/** 连续失败快速重试上限；超过则等下一个 60s 周期，避免后端宕机时打爆请求。 */
export const QUOTE_RETRY_MAX = 2

const TECHNICAL_LOCATION_ERROR = /https?:\/\/|(?:^|\s)(?:\/Users|\/private|\/var|\/tmp)\/|[A-Z]:\\/iu
const TECHNICAL_RUNTIME_ERROR = /Traceback|Runtime log:|investment Python backend|\b(?:ENOENT|ECONNREFUSED)\b|\bat\s+\S+\s+\(/iu

function containsTechnicalError(value: string): boolean {
  return TECHNICAL_LOCATION_ERROR.test(value) || TECHNICAL_RUNTIME_ERROR.test(value)
}

/** Keep operator diagnostics out of ordinary product surfaces. */
export function productErrorText(
  reason: unknown,
  fallback = '数据服务暂不可用，请稍后重试。',
): string {
  const raw = (reason instanceof Error ? reason.message : String(reason)).trim()
  if (raw === '') return fallback
  const httpDetail = raw.match(/failed with HTTP \d+:\s*(.+)$/su)?.[1]
  if (httpDetail !== undefined) {
    try {
      const decoded = JSON.parse(httpDetail) as unknown
      const detail = asRecord(decoded).detail
      if (typeof detail === 'string' && detail.trim() !== '' && !containsTechnicalError(detail)) {
        return detail.trim().slice(0, 240)
      }
    } catch {
      // Non-JSON backend bodies remain covered by the technical-text guard.
    }
  }
  return containsTechnicalError(raw) ? fallback : raw.slice(0, 240)
}
