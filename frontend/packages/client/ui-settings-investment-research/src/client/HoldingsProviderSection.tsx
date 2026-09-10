import { useEffect, useState, type ReactNode } from 'react'
import type { InvestmentDataRequest, InvestmentJsonValue } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { InvestmentReadinessKey } from './locales.ts'
import css from './HoldingsProviderSection.module.css'

/** narrow request-data signature so the component doesn't depend on the full runtime client */
type RequestData = (request: InvestmentDataRequest) => Promise<InvestmentJsonValue>

export interface HoldingsProviderSectionProps {
  t: (key: InvestmentReadinessKey) => string
  requestData: RequestData
  requestRestart: () => Promise<{ status: 'accepted' } | { status: 'unavailable'; reason: string }>
  restartPending: boolean
}

/** Provider option with a platform gate. */
interface ProviderOption {
  readonly value: string
  readonly labelKey: InvestmentReadinessKey
  readonly platforms: ReadonlySet<string>
}

const OPTIONS: readonly ProviderOption[] = [
  { value: 'manual', labelKey: 'providerManual', platforms: new Set(['darwin', 'win32', 'linux']) },
  { value: 'easytrader', labelKey: 'providerEasytrader', platforms: new Set(['win32']) },
  { value: 'mac_ths', labelKey: 'providerMacThs', platforms: new Set(['darwin']) },
  { value: 'qmt', labelKey: 'providerQmt', platforms: new Set(['win32']) },
]

const PLATFORM = navigator.platform.startsWith('Mac') ? 'darwin'
  : navigator.platform.startsWith('Win') ? 'win32'
  : 'linux'

/** Settings section for choosing the holdings data-source provider. */
export function HoldingsProviderSection(props: HoldingsProviderSectionProps): ReactNode {
  const { t, requestData, requestRestart, restartPending } = props
  const [effective, setEffective] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void requestData({ operation: 'trading-core.holdings-user-config' }).then(
      (result) => {
        if (!alive) return
        const obj = result as Record<string, unknown>
        const eff = obj.effective as Record<string, unknown> | undefined
        setEffective(typeof eff?.HOLDINGS_PROVIDER === 'string' ? eff.HOLDINGS_PROVIDER : 'manual')
        setLoading(false)
      },
      () => {
        if (!alive) return
        setError(t('providerLoadFailed'))
        setLoading(false)
      },
    )
    return () => { alive = false }
  }, [requestData, t])

  const availableOptions = OPTIONS.filter(option => option.platforms.has(PLATFORM))

  const onChange = (value: string): void => {
    if (saving || value === effective) return
    setSaving(true)
    setError('')
    void requestData({
      operation: 'trading-core.holdings-user-config-update',
      input: { entries: { HOLDINGS_PROVIDER: value } },
    }).then(
      () => {
        setEffective(value)
        setNeedsRestart(true)
        setSaving(false)
      },
      () => {
        setError(t('providerSaveFailed'))
        setSaving(false)
      },
    )
  }

  const restart = (): void => {
    if (restartPending) return
    void requestRestart()
  }

  return (
    <section className={css.provider} aria-labelledby="holdings-provider-title">
      <h2 id="holdings-provider-title">{t('providerTitle')}</h2>
      <p>{t('providerIntro')}</p>
      <label className={css.selectRow}>
        <span>{t('providerLabel')}</span>
        <select
          aria-label={t('providerLabel')}
          value={effective ?? ''}
          disabled={loading || saving}
          aria-busy={saving}
          onChange={(event) => { onChange(event.target.value) }}
        >
          {loading && <option value="">{t('providerLoading')}</option>}
          {availableOptions.map(option => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </select>
        <small>{t('providerHint')}</small>
      </label>
      {needsRestart && (
        <div className={css.restartBanner} role="status">
          <span>{t('providerRestartHint')}</span>
          <button
            type="button"
            className={css.restartButton}
            disabled={restartPending}
            onClick={restart}
          >
            {t('restart')}
          </button>
        </div>
      )}
      {error !== '' && <p className={css.error} role="alert">{error}</p>}
    </section>
  )
}
