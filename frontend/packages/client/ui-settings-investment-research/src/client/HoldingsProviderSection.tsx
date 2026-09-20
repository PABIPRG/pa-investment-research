import { Select } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { InvestmentDataRequest, InvestmentJsonValue } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { InvestmentReadinessKey } from './locales.ts'
import css from './HoldingsProviderSection.module.css'

/** narrow request-data signature so the component doesn't depend on the full runtime client */
type RequestData = (request: InvestmentDataRequest) => Promise<InvestmentJsonValue>

export interface HoldingsProviderSectionProps {
  t: (key: InvestmentReadinessKey) => string
  requestData: RequestData
  brokerSync?: boolean
  providers?: readonly string[]
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

function currentPlatform(): string {
  return navigator.platform.startsWith('Mac') ? 'darwin'
    : navigator.platform.startsWith('Win') ? 'win32'
      : 'linux'
}

/** Settings section for choosing the holdings data-source provider. */
export function HoldingsProviderSection(props: HoldingsProviderSectionProps): ReactNode {
  const { t, requestData } = props
  const [effective, setEffective] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [persistentAuthorization, setPersistentAuthorization] = useState(false)
  const native = (window as unknown as { __DSH_ELECTRON__?: {
    holdingsAction?: (input: { action: string; account_mode: 'real' | 'simulated' }) => Promise<unknown>
  } }).__DSH_ELECTRON__?.holdingsAction

  useEffect(() => {
    if (props.brokerSync === false) {
      setEffective('manual')
      setLoading(false)
      return () => {}
    }
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
  }, [props.brokerSync, requestData, t])

  useEffect(() => {
    if (native === undefined || currentPlatform() !== 'darwin') return
    void native({ action: 'consent_status', account_mode: 'simulated' }).then(value => {
      setPersistentAuthorization(typeof value === 'object' && value !== null
        && (value as { persistent_authorization?: unknown }).persistent_authorization === true)
    }).catch(() => {})
  }, [native])

  const allowed = props.providers === undefined ? undefined : new Set(props.providers)
  const availableOptions = OPTIONS.filter(option => option.value === effective
    || (allowed === undefined ? option.platforms.has(currentPlatform()) : allowed.has(option.value)))
  const effectiveIsKnown = OPTIONS.some(option => option.value === effective)
  const optionLabel = (value: string): string => {
    const option = OPTIONS.find(candidate => candidate.value === value)
    return option === undefined ? t('providerUnknown') : t(option.labelKey)
  }

  const onChange = (value: string): void => {
    if (saving || value === effective) return
    setSaving(true)
    setError('')
    setNotice('')
    void requestData({
      operation: 'trading-core.holdings-user-config-update',
      input: { entries: { HOLDINGS_PROVIDER: value } },
    }).then(
      () => {
        setEffective(value)
        setNotice(t('providerSaved').replace('{provider}', optionLabel(value)))
        setSaving(false)
      },
      () => {
        setError(t('providerSaveFailed'))
        setSaving(false)
      },
    )
  }

  return (
    <section className={css.provider} aria-labelledby="holdings-provider-title">
      <h2 id="holdings-provider-title">{t('providerTitle')}</h2>
      <p>{t('providerIntro')}</p>
      <label className={css.selectRow}>
        <span>{t('providerLabel')}</span>
        <Select aria-label={t('providerLabel')} value={effective ?? ''} disabled={loading || saving} aria-busy={saving}
          onValueChange={onChange}
          options={[
            ...(loading ? [{ value: '', label: t('providerLoading') }] : []),
            ...(!loading && effective !== undefined && !effectiveIsKnown ? [{ value: effective, label: t('providerUnknown') }] : []),
            ...availableOptions.map(option => ({ value: option.value, label: t(option.labelKey) })),
          ]} />
        <small>{t(props.brokerSync === false ? 'providerCloudHint' : 'providerHint')}</small>
      </label>
      {native !== undefined && currentPlatform() === 'darwin' && <div className={css.authorizationRow}>
        <div><strong>同花顺主动读取授权</strong><span>{persistentAuthorization ? '长期授权已开启；应用仍不会定时或在后台自动读取。' : '当前每次切换到同花顺前都会询问。'}</span></div>
        {persistentAuthorization && <button type="button" disabled={saving} onClick={() => {
          setSaving(true); setError(''); setNotice('')
          void native({ action: 'revoke_consent', account_mode: 'simulated' }).then(() => {
            setPersistentAuthorization(false); setNotice('已关闭同花顺长期读取授权。'); setSaving(false)
          }, () => { setError('无法关闭长期读取授权，请稍后重试。'); setSaving(false) })
        }}>关闭长期授权</button>}
      </div>}
      {notice !== '' && <p className={css.success} role="status">{notice}</p>}
      {error !== '' && <p className={css.error} role="alert">{error}</p>}
    </section>
  )
}
