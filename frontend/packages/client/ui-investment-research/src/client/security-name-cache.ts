import { asRecord } from './data.ts'

const STORAGE_KEY = 'investment-research.security-names.v1'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 512
type CachedName = { name: string; savedAt: number }

/** Only cache catalog labels, never code fallbacks or holdings data. */
export function validSecurityName(code: string, name: unknown): name is string {
  return /^\d{6}$/.test(code) && typeof name === 'string'
    && name.trim() !== '' && name.trim() !== code && name.length <= 120
}

function readEntries(): Record<string, CachedName> {
  let raw: string | null
  try { raw = window.localStorage.getItem(STORAGE_KEY) } catch {
    // Browser storage may be disabled; live lookup remains available.
    return {}
  }
  let value: unknown
  try { value = JSON.parse(raw ?? '{}') } catch {
    // A corrupt cache is disposable and does not affect authoritative data.
    return {}
  }
  const now = Date.now()
  const entries: Array<[string, CachedName]> = []
  for (const [code, item] of Object.entries(asRecord(value))) {
    const entry = asRecord(item)
    if (typeof entry.savedAt !== 'number') continue
    const age = now - entry.savedAt
    if (validSecurityName(code, entry.name)
      && Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS) {
      entries.push([code, { name: entry.name.trim(), savedAt: entry.savedAt }])
    }
  }
  return Object.fromEntries(entries.sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ENTRIES))
}

/** Read this origin's unexpired public security labels; no account fields are stored. */
export function readSecurityNames(): Record<string, string> {
  return Object.fromEntries(Object.entries(readEntries()).map(([code, entry]) => [code, entry.name]))
}

/** Persist confirmed labels for at most 24 hours and retain at most 512 entries. */
export function cacheSecurityNames(names: Readonly<Record<string, string>>): void {
  const entries = readEntries()
  const now = Date.now()
  for (const [code, name] of Object.entries(names)) {
    if (validSecurityName(code, name)) entries[code] = { name: name.trim(), savedAt: now }
  }
  const bounded = Object.fromEntries(Object.entries(entries)
    .sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ENTRIES))
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bounded)) } catch {
    // Quota/private-mode failures must not prevent displaying a resolved name.
  }
}
