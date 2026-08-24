import clsx from 'clsx'
import type { ReactNode } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  createInvestmentReadinessStore,
  InvestmentReadinessSnapshot,
  InvestmentRestartResult,
  InvestmentRestartState,
} from './store.ts'
import type { InvestmentReadinessKey } from './locales.ts'
import css from './InvestmentReadinessSection.module.css'

/** Registration-side facade narrowed to the facts and actions this page consumes. */
export interface InvestmentReadinessSectionInjected {
  hooks: {
    /** Secret-free Host readiness snapshot bound by the renderer. */
    investmentReadiness: HostObservable<InvestmentReadinessSnapshot>
  }
  /** Re-read Host readiness after an operator repair. */
  refresh: () => Promise<void>
  /** Ask the launcher to restart after quiescent shutdown. */
  requestRestart: () => Promise<InvestmentRestartResult>
}

/** Full props assembled by the settings section registration. */
export type InvestmentReadinessSectionProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createInvestmentReadinessStore>>
  & PropsLocale<'settings.investmentResearch'>
  & InjectFace<InvestmentReadinessSectionInjected>

type Translate = InvestmentReadinessSectionProps['t']
type InvestmentBackendReadiness = InvestmentReadinessSnapshot['backends'][number]
type InvestmentCredentialReadiness = InvestmentBackendReadiness['credentials'][number]
type InvestmentCapabilityReadiness = NonNullable<InvestmentBackendReadiness['capability']>

function interpolate(text: string, key: string, value: string): string {
  return text.replace(`{${key}}`, () => value)
}

function backendName(backend: InvestmentBackendReadiness, t: Translate): string {
  return t(backend.backendId === 'trading-core' ? 'stock' : 'market')
}

function ownershipLabel(backend: InvestmentBackendReadiness, t: Translate): string {
  if (backend.ownership === 'owned') return t('owned')
  if (backend.ownership === 'attached') return t('attached')
  if (backend.ownership === 'external') return t('external')
  return t('stopped')
}

function backendStatusLabel(backend: InvestmentBackendReadiness, t: Translate): string {
  const keys = {
    stopped: 'stopped',
    'healthy-owned': 'healthyOwned',
    'healthy-attached': 'healthyAttached',
    external: 'externalBackend',
    failed: 'failed',
  } satisfies Record<InvestmentBackendReadiness['backendStatus'], InvestmentReadinessKey>
  return t(keys[backend.backendStatus])
}

function credentialLabel(credential: InvestmentCredentialReadiness | undefined, t: Translate): string {
  const status = credential?.status ?? 'missing'
  const keys = {
    missing: 'credentialMissing',
    configured: 'credentialConfigured',
    'read-only': 'credentialReadOnly',
    'restart-required': 'credentialRestart',
    'external-managed': 'credentialExternal',
  } satisfies Record<InvestmentCredentialReadiness['status'], InvestmentReadinessKey>
  return t(keys[status])
}

function capabilityLabel(capability: InvestmentCapabilityReadiness | null, t: Translate): string {
  const status = capability?.status ?? 'unavailable'
  const keys = {
    'stock-full': 'stockFull',
    'market-template-only': 'marketTemplate',
    'market-full': 'marketFull',
    unavailable: 'unavailable',
  } satisfies Record<InvestmentCapabilityReadiness['status'], InvestmentReadinessKey>
  return t(keys[status])
}

function llmLabel(capability: InvestmentCapabilityReadiness | null, t: Translate): string {
  const keys = {
    required: 'llmRequired',
    enhancement: 'llmEnhancement',
    none: 'llmNone',
  } satisfies Record<InvestmentCapabilityReadiness['llm'], InvestmentReadinessKey>
  return t(keys[capability?.llm ?? 'none'])
}

function credentialOf(backend: InvestmentBackendReadiness): InvestmentCredentialReadiness | undefined {
  return backend.credentials.find(credential => credential.ref === 'DEEPSEEK_API_KEY')
    ?? backend.credentials[0]
}

function restartFeedback(
  state: InvestmentRestartState,
  t: Translate,
): string | undefined {
  if (state.status === 'pending') return t('restarting')
  if (state.status === 'accepted') return t('restartAccepted')
  if (state.status === 'unavailable') {
    return interpolate(t('restartUnavailable'), 'reason', state.reason ?? '')
  }
  if (state.status === 'error') return t('restartFailed')
  return undefined
}

/** Render the secret-free investment Runtime readiness and explicit actions. */
export function InvestmentReadinessSection(props: InvestmentReadinessSectionProps): ReactNode {
  const snapshot = props.useInvestmentReadiness(value => value)
  const interaction = props.useStore(value => value)
  const restart = interaction.restart
  const needsModels = snapshot.backends.some(
    backend => (credentialOf(backend)?.status ?? 'missing') === 'missing',
  )
  const needsRestart = snapshot.backends.some(backend => backend.restartRequired
    || credentialOf(backend)?.status === 'restart-required')
  const needsRefresh = snapshot.backends.length === 0 || snapshot.backends.some(
    backend => backend.backendStatus === 'failed' || backend.backendStatus === 'stopped',
  )
  const restartMessage = restartFeedback(restart, props.t)
  const refreshMessage = interaction.refresh === 'error'
    ? props.t('refreshFailed')
    : snapshot.backends.length === 0 ? props.t('loading') : undefined

  const requestRestart = (): void => {
    if (restart.status === 'pending') return
    props.actions.beginRestart()
    void props.requestRestart().then(
      (result) => {
        if (result.status === 'accepted') props.actions.acceptRestart()
        else props.actions.unavailableRestart(result.reason)
      },
      () => { props.actions.failRestart() },
    )
  }

  const refresh = (): void => {
    if (interaction.refresh === 'pending') return
    props.actions.beginRefresh()
    void props.refresh().then(props.actions.finishRefresh, props.actions.failRefresh)
  }

  return (
    <section className={css.section}>
      <header className={css.heading}>
        <div>
          <h2>{props.t('title')}</h2>
          <p>{props.t('intro')}</p>
        </div>
        <dl className={css.runtimeAsset}>
          <dt>{props.t('runtimeAsset')}</dt>
          <dd>{props.t('sourceRuntime')}</dd>
        </dl>
      </header>

      <div className={css.actions}>
        {needsModels ? (
          <button type="button" className={css.primaryButton} onClick={() => { props.openSection('models') }}>
            {props.t('openModels')}
          </button>
        ) : null}
        {needsRestart ? (
          <button
            type="button"
            className={css.primaryButton}
            disabled={restart.status === 'pending'}
            onClick={requestRestart}
          >
            {props.t('restart')}
          </button>
        ) : null}
        {needsRefresh ? (
          <button
            type="button"
            className={css.secondaryButton}
            disabled={interaction.refresh === 'pending'}
            onClick={refresh}
          >
            {props.t('refresh')}
          </button>
        ) : null}
      </div>
      {restartMessage !== undefined
        ? <p className={css.feedback} role="status">{restartMessage}</p>
        : null}
      {refreshMessage !== undefined
        ? <p className={css.feedback} role="status">{refreshMessage}</p>
        : null}

      <div className={css.backends}>
        {snapshot.backends.map((backend) => {
          const capability = backend.capability
          return (
            <article
              className={clsx(css.backend, backend.backendStatus === 'failed' && css.backendFailed)}
              key={backend.backendId}
            >
              <div className={css.backendHeading}>
                <h3>{backendName(backend, props.t)}</h3>
                <span className={css.ownership}>{ownershipLabel(backend, props.t)}</span>
              </div>
              <p className={css.backendStatus}>{backendStatusLabel(backend, props.t)}</p>
              <dl className={css.facts}>
                <div>
                  <dt>{credentialLabel(credentialOf(backend), props.t)}</dt>
                  <dd>{capabilityLabel(capability, props.t)}</dd>
                </div>
                <div>
                  <dt>{interpolate(props.t('tools'), 'count', String(capability?.toolCount ?? 0))}</dt>
                  <dd>{llmLabel(capability, props.t)}</dd>
                </div>
                <div className={css.logRow}>
                  <dt>{props.t('log')}</dt>
                  <dd><code>{backend.runtimeLogPath}</code></dd>
                </div>
              </dl>
            </article>
          )
        })}
      </div>

      <section className={css.checklist}>
        <h2>{props.t('checklist')}</h2>
        <p>{props.t('checklistIntro')}</p>
        <ul>
          {([
            'checkHealthy', 'checkWatchList', 'checkWatchWrite',
            'checkStockList', 'checkAnalyze', 'checkMarket',
          ] satisfies InvestmentReadinessKey[]).map(key => <li key={key}>{props.t(key)}</li>)}
        </ul>
      </section>
    </section>
  )
}
