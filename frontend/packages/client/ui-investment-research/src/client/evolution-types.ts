import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { AssistantIntent } from './assistant-intent.ts'

export type EvolutionRequestData = (request: InvestmentDataRequest) => Promise<unknown>

export type EvolutionLifecycleGroup =
  | '' | 'active' | 'candidate' | 'mutated' | 'retired' | 'watch' | 'rejected'

/** Participation states displayed independently from confidence and mutation origin. */
export type EvolutionStrategyStatus = 'active' | 'watch' | 'retired' | 'candidate' | 'rejected' | ''

/** Deterministic five-dimension strategy wording shared by evolution surfaces. */
export interface EvolutionSemanticLabels {
  readonly participation: string
  readonly verification: string
  readonly confidence: string
  readonly source: string
  readonly task: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

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

/**
 * Format a backend time without hiding its source timezone.
 * @param value - ISO-8601 or service-local timestamp.
 * @param fallback - text used when no timestamp exists.
 * @returns a complete second-level timestamp with explicit timezone semantics.
 */
export function formatEvolutionTimestamp(value: unknown, fallback = '—'): string {
  const raw = stringValue(value)
  if (raw === '') return fallback
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(raw)
  if (iso !== null) {
    const offset = iso[3] === 'Z' ? '+00:00' : iso[3]
    return `${iso[1]} ${iso[2]} UTC${offset}`
  }
  return `${raw.replace('T', ' ')}（服务本地时间）`
}

/**
 * Project raw backend strategy fields to the rc.10 five-dimension vocabulary.
 * @param value - strategy detail, lifecycle entry, or merged evolution record.
 * @param participationOverride - authoritative lifecycle bucket when available.
 * @returns all five labels; mutation affects source only.
 */
export function evolutionSemanticLabels(
  value: Record<string, unknown>,
  participationOverride = '',
): EvolutionSemanticLabels {
  const evolve = record(value.evolve)
  const participation = participationOverride
    || stringValue(value.participation_status)
    || stringValue(evolve.state)
    || stringValue(value.status)
  const verification = stringValue(value.verification_status)
  const rawTier = value.confidence_tier ?? value.tier ?? evolve.tier
  const tier = typeof rawTier === 'number' ? rawTier : Number(rawTier)
  const source = stringValue(value.source)
  const mutatedFrom = stringValue(value.mutated_from) || stringValue(evolve.mutated_from)
  const task = stringValue(value.task_status)
  const verificationLabels: Readonly<Record<string, string>> = {
    passed: '已验证通过',
    not_passed: '验证未通过',
    insufficient: '样本不足',
    pending: '待验证',
  }
  const sourceLabels: Readonly<Record<string, string>> = {
    evolution: '变异来源',
    manual: '人工',
    event: '事件生成',
    demo_fixture: '演示数据',
    initial_auto: '自动首测',
    periodic_retest: '自动复测',
  }
  const taskLabels: Readonly<Record<string, string>> = {
    pending: '排队中',
    running: '运行中',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  }
  return {
    participation: evolutionParticipationLabel(participation),
    verification: (verificationLabels[verification] ?? verification) || '样本不足',
    confidence: evolutionConfidenceLabel(Number.isFinite(tier) ? tier : undefined),
    source: mutatedFrom !== '' || source === 'evolution' ? '变异来源' : (sourceLabels[source] ?? source) || '未标注',
    task: (taskLabels[task] ?? task) || '暂无任务',
  }
}

/**
 * Render the five labels for UI and model-facing deterministic context.
 * @param labels - the shared semantic labels.
 * @returns one stable Chinese sentence without inferred values.
 */
export function evolutionSemanticSummary(labels: EvolutionSemanticLabels): string {
  return `参与状态：${labels.participation}；验证结果：${labels.verification}；置信等级：${labels.confidence}；来源：${labels.source}；任务状态：${labels.task}`
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
