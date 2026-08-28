import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLogDownloadState } from '@deepseek-ai/dsh-session-log-export/client'
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
    /** Shared Session export state owned by the existing Header action. */
    sessionLogDownload: HostObservable<SessionLogDownloadState>
  }
  /** Start the existing Session-tree download and let its shared modal report progress. */
  downloadSession: (sessionId: SessionId) => Promise<void>
  /** Re-read Host readiness after an operator repair. */
  refresh: () => Promise<void>
  /** Ask the launcher to restart after quiescent shutdown. */
  requestRestart: () => Promise<InvestmentRestartResult>
  /** Read the configured provider catalog and the project-wide default Agent model. */
  loadProjectModels: () => Promise<ProjectModelSettings>
  /** Persist the project-wide default Agent model. */
  saveProjectModel: (selection: ProjectModelSelection, expectedRevision: number) => Promise<ProjectModelSettings>
}

export interface ProjectModelSelection {
  readonly provider: string
  readonly model: string
}

export interface ProjectModelOption extends ProjectModelSelection {
  readonly label: string
  readonly providerLabel: string
}

export interface ProjectModelSettings {
  readonly current: ProjectModelSelection
  readonly options: readonly ProjectModelOption[]
  readonly writable: boolean
  readonly revision: number
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
  if (backend.backendId === 'trading-core') return t('stock')
  if (backend.backendId === 'industry-chain') return t('industry')
  return t('market')
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

function credentialLabel(
  credential: InvestmentCredentialReadiness | undefined,
  capability: InvestmentCapabilityReadiness | null,
  t: Translate,
): string {
  if (credential === undefined && capability?.llm === 'none') return t('credentialNone')
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
    'industry-full': 'industryFull',
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

function modelValue(selection: ProjectModelSelection): string {
  return `${selection.provider}\u0000${selection.model}`
}

function projectModelOption(
  options: readonly ProjectModelOption[],
  value: string,
): ProjectModelOption | undefined {
  return options.find(option => modelValue(option) === value)
}

/** Render the secret-free investment Runtime readiness and explicit actions. */
export function InvestmentReadinessSection(props: InvestmentReadinessSectionProps): ReactNode {
  const snapshot = props.useInvestmentReadiness(value => value)
  const currentSession = props.useSessions(value => value.current)
  const downloadStatus = props.useSessionLogDownload(value => currentSession === undefined
    ? undefined
    : value.bySession[String(currentSession)]?.status)
  const interaction = props.useStore(value => value)
  const [projectModels, setProjectModels] = useState<ProjectModelSettings>()
  const [projectModelsError, setProjectModelsError] = useState('')
  const [projectModelsBusy, setProjectModelsBusy] = useState(false)
  const restart = interaction.restart
  const downloadBusy = downloadStatus === 'downloading'
  const needsModels = snapshot.backends.some(backend => backend.capability?.llm !== 'none'
    && (credentialOf(backend)?.status ?? 'missing') === 'missing')
  const needsRestart = snapshot.backends.some(backend => backend.restartRequired
    || credentialOf(backend)?.status === 'restart-required')
  const needsRefresh = snapshot.backends.length === 0 || snapshot.backends.some(
    backend => backend.backendStatus === 'failed' || backend.backendStatus === 'stopped',
  )
  const restartMessage = restartFeedback(restart, props.t)
  const refreshMessage = interaction.refresh === 'error'
    ? props.t('refreshFailed')
    : snapshot.backends.length === 0 ? props.t('loading') : undefined
  const runtimeAssetKey = snapshot.runtimeAsset.status === 'source-env-ready'
    ? 'sourceRuntime'
    : snapshot.runtimeAsset.status === 'bundled-ready'
      ? 'bundledRuntime'
      : snapshot.runtimeAsset.status === 'invalid'
        ? 'invalidRuntime'
        : 'missingRuntime'

  useEffect(() => {
    let alive = true
    setProjectModelsError('')
    void props.loadProjectModels().then(
      (value) => { if (alive) setProjectModels(value) },
      () => { if (alive) setProjectModelsError(props.t('projectModelsLoadFailed')) },
    )
    return () => { alive = false }
  }, [props.loadProjectModels, props.t])

  const selectProjectModel = (value: string): void => {
    if (projectModels === undefined || projectModelsBusy) return
    const selection = projectModelOption(projectModels.options, value)
    if (selection === undefined) return
    setProjectModelsBusy(true)
    setProjectModelsError('')
    void props.saveProjectModel({ provider: selection.provider, model: selection.model }, projectModels.revision).then(
      setProjectModels,
      () => { setProjectModelsError(props.t('projectModelsSaveFailed')) },
    ).finally(() => { setProjectModelsBusy(false) })
  }

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
      <section className={css.dataBackup} aria-labelledby="investment-research-data-backup-title">
        <div className={css.dataBackupCopy}>
          <h2 id="investment-research-data-backup-title">{props.t('dataBackupTitle')}</h2>
          <p>{props.t('dataBackupIntro')}</p>
        </div>
        <div className={css.dataBackupAction}>
          <button
            type="button"
            className={css.primaryButton}
            disabled={currentSession === undefined || downloadBusy}
            aria-busy={downloadBusy}
            aria-describedby="investment-research-export-scope"
            onClick={currentSession === undefined
              ? undefined
              : () => { void props.downloadSession(currentSession) }}
          >
            {props.t(downloadBusy ? 'exportingCurrentConversation' : 'exportCurrentConversation')}
          </button>
          <p id="investment-research-export-scope">
            {props.t(currentSession === undefined
              ? 'exportNoCurrentConversation'
              : 'exportCurrentConversationScope')}
          </p>
        </div>
      </section>

      <section className={css.modelRouting} aria-labelledby="investment-project-model-title">
        <div className={css.modelRoutingHeading}>
          <div>
            <h2 id="investment-project-model-title">{props.t('projectModelTitle')}</h2>
            <p>{props.t('projectModelIntro')}</p>
          </div>
          <button type="button" className={css.secondaryButton} onClick={() => { props.openSection('models') }}>
            {props.t('manageConfiguredModels')}
          </button>
        </div>
        <label className={css.projectModelSelect}>
          <span>{props.t('defaultMainModel')}</span>
          <select
            aria-label={props.t('defaultMainModel')}
            value={projectModels === undefined ? '' : modelValue(projectModels.current)}
            disabled={projectModels === undefined || !projectModels.writable || projectModelsBusy}
            aria-busy={projectModelsBusy}
            onChange={(event) => { selectProjectModel(event.target.value) }}
          >
            {projectModels === undefined && <option value="">{props.t('loadingModels')}</option>}
            {projectModels?.options.map(option => (
              <option key={modelValue(option)} value={modelValue(option)}>
                {option.label} · {option.providerLabel}
              </option>
            ))}
          </select>
          <small>{props.t('defaultMainModelHint')}</small>
        </label>
        {projectModelsError !== '' && <p className={css.modelError} role="alert">{projectModelsError}</p>}
        <div className={css.modelModuleGrid} aria-label={props.t('moduleModelUsage')}>
          <article><strong>{props.t('intelligentAnalysis')}</strong><span>{props.t('followsMainModel')}</span><small>{props.t('intelligentAnalysisModelHint')}</small></article>
          <article><strong>{props.t('stockBackend')}</strong><span>{props.t('backendDeepSeekModel')}</span><small>{props.t('stockModelHint')}</small></article>
          <article><strong>{props.t('marketBackend')}</strong><span>{props.t('backendDeepSeekModel')}</span><small>{props.t('marketModelHint')}</small></article>
          <article><strong>{props.t('industryQuery')}</strong><span>{props.t('queryNoModel')}</span><small>{props.t('industryModelHint')}</small></article>
        </div>
      </section>

      <header className={css.heading}>
        <div>
          <h2>{props.t('title')}</h2>
          <p>{props.t('intro')}</p>
        </div>
        <dl className={css.runtimeAsset}>
          <dt>{props.t('runtimeAsset')}</dt>
          <dd>{props.t(runtimeAssetKey)}</dd>
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
                  <dt>{credentialLabel(credentialOf(backend), capability, props.t)}</dt>
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

    </section>
  )
}
