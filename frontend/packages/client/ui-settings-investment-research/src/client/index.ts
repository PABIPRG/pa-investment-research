import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type {} from '@deepseek-ai/dsh-session-log-export/client'
import {
  InvestmentReadinessSection,
  type InvestmentReadinessSectionInjected,
  type ProjectModelOption,
  type ProjectModelSelection,
  type ProjectModelSettings,
} from './InvestmentReadinessSection.tsx'
import { createInvestmentReadinessStore } from './store.ts'
import { en, zh, type InvestmentReadinessKey } from './locales.ts'

export type { InvestmentReadinessKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Investment Runtime readiness and acceptance copy. */
    'settings.investmentResearch': InvestmentReadinessKey
  }
}

const NS = 'settings.investmentResearch'

/** Required services for the investment readiness Settings contribution. */
export const inject = ['slots', 'locale', 'connection', 'investmentResearchRuntimeClient', 'sessionLogDownload']

const DEFAULT_MODEL_NAMESPACE = 'agent-default-model'

function selectionFrom(view: SettingsNamespaceView): ProjectModelSelection {
  const value = typeof view.value === 'object' && view.value !== null
    ? view.value as Record<string, unknown>
    : {}
  const provider = typeof value.provider === 'string' ? value.provider : ''
  const model = typeof value.model === 'string' ? value.model : ''
  if (provider === '' || model === '') throw new Error('default model settings are incomplete')
  return { provider, model }
}

async function loadProjectModels(api: ConnectionHandle['api']): Promise<ProjectModelSettings> {
  const [settingsResponse, modelsResponse] = await Promise.all([
    api.settings.describe({}),
    api.llm.models({}),
  ])
  if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
  if (!modelsResponse.result.ok) throw new Error(modelsResponse.result.error.message)
  const view = settingsResponse.result.value.namespaces.find(item => item.ns === DEFAULT_MODEL_NAMESPACE)
  if (view === undefined) throw new Error('default model settings are unavailable')
  const options: ProjectModelOption[] = modelsResponse.result.value.groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    model: model.id,
    label: model.name,
    providerLabel: group.name,
  })))
  const current = selectionFrom(view)
  if (!options.some(option => option.provider === current.provider && option.model === current.model)) {
    options.unshift({ ...current, label: current.model, providerLabel: current.provider })
  }
  return {
    current,
    options,
    writable: settingsResponse.result.value.writable,
    revision: view.revision,
  }
}

async function saveProjectModel(
  api: ConnectionHandle['api'],
  selection: ProjectModelSelection,
  expectedRevision: number,
): Promise<ProjectModelSettings> {
  const response = await api.settings.mutate({
    ns: DEFAULT_MODEL_NAMESPACE,
    expectedRevision,
    ops: [
      { op: 'set', path: ['provider'], value: selection.provider },
      { op: 'set', path: ['model'], value: selection.model },
      { op: 'unset', path: ['reasoningEffort'] },
    ],
  })
  if (!response.result.ok) throw new Error(response.result.error.message)
  return loadProjectModels(api)
}

/** Register the investment readiness section after its Settings declaration exists. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'ui-settings-investment-research: dictionaries',
  )
  const runtime = ctx.investmentResearchRuntimeClient
  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  const injected = (): InvestmentReadinessSectionInjected => ({
    hooks: {
      investmentReadiness: runtime,
      sessionLogDownload: ctx.sessionLogDownload.store,
    },
    downloadSession: sessionId => ctx.sessionLogDownload.download(sessionId),
    refresh: () => runtime.refresh(),
    requestRestart: () => runtime.requestRestart(),
    loadProjectModels: () => loadProjectModels(connection.api),
    saveProjectModel: (selection, revision) => saveProjectModel(connection.api, selection, revision),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'investment-research',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    store: createInvestmentReadinessStore,
    inject: injected,
  }, InvestmentReadinessSection))
}
