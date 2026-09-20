import { useEffect, useMemo, useRef, useState } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, records, text } from './data.ts'
import { cacheSecurityNames, readSecurityNames, validSecurityName } from './security-name-cache.ts'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

/** Resolve code-only portfolio and event records through the shared security catalog. */
export function useSecurityNames(
  requestData: RequestData,
  values: readonly string[],
  knownNames?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const codeKey = useMemo(() => [...new Set(values
    .map(value => value.trim())
    .filter(value => /^\d{6}$/.test(value)))]
    .sort()
    .join('|'), [values])
  const knownKey = JSON.stringify(Object.entries(knownNames ?? {})
    .filter(([code, name]) => validSecurityName(code, name)).sort(([a], [b]) => a.localeCompare(b)))
  const [names, setNames] = useState<Record<string, string>>(() => ({
    ...readSecurityNames(), ...Object.fromEntries(JSON.parse(knownKey) as Array<[string, string]>),
  }))
  const [retryVersion, setRetryVersion] = useState(0)
  const attempts = useRef<Record<string, number>>({})

  useEffect(() => {
    const known = Object.fromEntries(JSON.parse(knownKey) as Array<[string, string]>)
    if (Object.keys(known).length === 0) return
    cacheSecurityNames(known)
    setNames(current => Object.entries(known).some(([code, name]) => current[code] !== name)
      ? { ...current, ...known } : current)
  }, [knownKey])

  useEffect(() => {
    const codes = codeKey === '' ? [] : codeKey.split('|')
    const unresolved = codes.filter(code => names[code] === undefined)
    if (unresolved.length === 0) return
    const requestState = { cancelled: false }
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      let shouldRetry = false
      for (let start = 0; start < unresolved.length; start += 4) {
        const resolved = await Promise.all(unresolved.slice(start, start + 4).map(async (code): Promise<readonly [string, string]> => {
          try {
            const result = asRecord(await requestData({
              operation: 'market-watch.security-search', input: { query: code, limit: 8 },
            }))
            const match = records(result.items).find(item => text(item.code, '').trim() === code)
            const name = text(match?.name, '').trim()
            return [code, validSecurityName(code, name) ? name : ''] as const
          } catch {
            return [code, ''] as const
          }
        }))
        if (requestState.cancelled) return
        const settled: Array<readonly [string, string]> = []
        for (const [code, name] of resolved) {
          if (name !== '') {
            attempts.current[code] = 0
            settled.push([code, name])
            continue
          }
          const count = (attempts.current[code] ?? 0) + 1
          attempts.current[code] = count
          if (count >= 3) settled.push([code, ''])
          else shouldRetry = true
        }
        if (settled.length > 0) {
          cacheSecurityNames(Object.fromEntries(settled))
          setNames(current => ({ ...current, ...Object.fromEntries(settled) }))
        }
      }
      if (shouldRetry && !requestState.cancelled) {
        const waitMs = Math.min(4000, 1000 * 2 ** Math.max(0, retryVersion))
        retryTimer = setTimeout(() => { setRetryVersion(value => value + 1) }, waitMs)
      }
    })()
    return () => {
      requestState.cancelled = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [codeKey, names, requestData, retryVersion])

  return names
}
