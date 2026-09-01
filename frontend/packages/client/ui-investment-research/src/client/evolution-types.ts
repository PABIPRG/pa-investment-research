import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { AssistantIntent } from './assistant-intent.ts'

export type EvolutionRequestData = (request: InvestmentDataRequest) => Promise<unknown>

export type EvolutionLifecycleGroup =
  | '' | 'active' | 'candidate' | 'mutated' | 'retired' | 'watch' | 'rejected'

export interface EvolutionDashboardProps {
  readonly requestData: EvolutionRequestData
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onOpenStrategy: (strategyId: string, returnGroup?: EvolutionLifecycleGroup) => void
  readonly onOpenStock?: (code: string) => void
  readonly initialLifecycleGroup?: EvolutionLifecycleGroup
}

export interface StrategyEvolutionDiagnosticsProps {
  readonly requestData: EvolutionRequestData
  readonly strategyId: string
  readonly strategyLabel: string
  readonly strategyStatus: string
  readonly archived?: boolean
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onBack: () => void
  readonly onOpenStock?: (code: string) => void
}
