import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

const FUNDS_PRIVACY_STORAGE_KEY = 'investment-research.hide-sensitive-funds'

interface FundsPrivacyValue {
  readonly hidden: boolean
  toggle: () => void
}

const FundsPrivacyContext = createContext<FundsPrivacyValue>({ hidden: false, toggle: () => {} })

function storedPreference(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const value = window.localStorage.getItem(FUNDS_PRIVACY_STORAGE_KEY)
    return value === null ? true : value !== 'visible'
  } catch {
    return true
  }
}

export function FundsPrivacyProvider({ children }: { readonly children: ReactNode }) {
  const [hidden, setHidden] = useState(storedPreference)

  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (event.key === FUNDS_PRIVACY_STORAGE_KEY) setHidden(event.newValue !== 'visible')
    }
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener('storage', sync) }
  }, [])

  const toggle = useCallback((): void => {
    setHidden((current) => {
      const next = !current
      try { window.localStorage.setItem(FUNDS_PRIVACY_STORAGE_KEY, next ? 'hidden' : 'visible') } catch {}
      return next
    })
  }, [])
  const value = useMemo(() => ({ hidden, toggle }), [hidden, toggle])
  return <FundsPrivacyContext.Provider value={value}>{children}</FundsPrivacyContext.Provider>
}

export function useFundsPrivacy(): FundsPrivacyValue {
  return useContext(FundsPrivacyContext)
}

/** Preserve missing-data markers while masking resolved account values. */
export function privateFunds(value: string, hidden: boolean): string {
  return hidden && value !== '—' ? '***' : value
}
