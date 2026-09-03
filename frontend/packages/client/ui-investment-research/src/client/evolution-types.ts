import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { AssistantIntent } from './assistant-intent.ts'

export type EvolutionRequestData = (request: InvestmentDataRequest) => Promise<unknown>

export type EvolutionLifecycleGroup =
  | '' | 'active' | 'candidate' | 'mutated' | 'retired' | 'watch' | 'rejected'

/** Participation states displayed independently from confidence and mutation origin. */
export type EvolutionStrategyStatus = 'active' | 'watch' | 'retired' | 'candidate' | 'rejected' | ''

/**
 * Map a strategy participation state to the rc.10 product vocabulary.
 * @param status - backend participation state; unknown values remain explicit.
 * @returns the localized participation label.
 */
export function evolutionParticipationLabel(status: string): string {
  if (status === 'active') return '正常运行'
  if (status === 'watch') return '观察中'
  if (status === 'retired') return '已淘汰'
  if (status === 'candidate') return '候选'
  if (status === 'rejected') return '已拒绝'
  return '状态未知'
}

/**
 * Map a backend confidence tier without treating it as participation state.
 * @param tier - backend confidence tier.
 * @returns the localized confidence label.
 */
export function evolutionConfidenceLabel(tier: number | undefined): string {
  if (tier === 2) return '已升级'
  if (tier === 1) return '基础层级'
  return '层级未知'
}

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
