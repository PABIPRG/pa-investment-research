import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type {} from '@deepseek-ai/dsh-session-log-export/client'
import { InvestmentReadinessSection, type InvestmentReadinessSectionInjected } from './InvestmentReadinessSection.tsx'
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
export const inject = ['slots', 'locale', 'investmentResearchRuntimeClient', 'sessionLogDownload']

/** Register the investment readiness section after its Settings declaration exists. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'ui-settings-investment-research: dictionaries',
  )
  const runtime = ctx.investmentResearchRuntimeClient
  const t = ctx.locale.bind(NS)
  const injected = (): InvestmentReadinessSectionInjected => ({
    hooks: {
      investmentReadiness: runtime,
      sessionLogDownload: ctx.sessionLogDownload.store,
    },
    downloadSession: sessionId => ctx.sessionLogDownload.download(sessionId),
    refresh: () => runtime.refresh(),
    requestRestart: () => runtime.requestRestart(),
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
