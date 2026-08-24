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
