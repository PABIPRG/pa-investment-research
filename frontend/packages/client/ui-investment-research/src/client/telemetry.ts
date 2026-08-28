import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'

/** Allow-listed user actions recorded by the local learning pipeline. */
export type LocalTelemetryAction = 'page_view' | 'impression' | 'open' | 'analyze' | 'follow' | 'unfollow'
/** Product surfaces that may originate a local learning fact. */
export type LocalTelemetrySurface =
  | 'dashboard' | 'search' | 'opportunity' | 'stock_detail' | 'portfolio'
  | 'strategy' | 'evolution' | 'industry' | 'reports' | 'assistant'
/** Structured object classes accepted as local learning targets. */
export type LocalTelemetryTargetType =
  | 'page' | 'event' | 'risk' | 'strategy' | 'security' | 'portfolio'
  | 'industry' | 'report'

/** Optional allow-listed dimensions attached to a local learning fact. */
export interface LocalTelemetryContext {
  readonly ticker?: string
  readonly industries?: string[]
  readonly strategy_id?: string
  readonly direction?: string
  readonly bucket?: string
  readonly event_type?: string
  readonly risk_source?: string
  readonly risk_severity?: string
  readonly analysis_kind?: string
  readonly position?: number
  readonly reason_codes?: string[]
}

/** Browser-side event contract before the host assigns trusted storage time. */
export interface LocalTelemetryEvent {
  readonly action: LocalTelemetryAction
  readonly surface: LocalTelemetrySurface
  readonly targetType: LocalTelemetryTargetType
  readonly targetId: string
  readonly context?: LocalTelemetryContext
  /** Session dedupe is for impressions; moment dedupe absorbs effect replay. */
  readonly dedupe?: 'session' | 'moment' | 'none'
}

/** Non-blocking function used by product surfaces to record one local fact. */
export type TrackLocalTelemetry = (event: LocalTelemetryEvent) => Promise<void>

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface TelemetryDependencies {
  readonly now?: () => number
  readonly id?: () => string
  readonly momentWindowMs?: number
  readonly dedupeCapacity?: number
}

function defaultId(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Create one UI-instance recorder with bounded, non-persistent dedupe state.
 * @param requestData - Browser-safe host bridge for allow-listed investment operations.
 * @param dependencies - Optional clocks, identifiers, and cache limits used by tests.
 * @returns One instance session identifier and a fail-open tracking function.
 */
export function createLocalTelemetry(
  requestData: RequestData,
  dependencies: TelemetryDependencies = {},
): { readonly sessionId: string; readonly track: TrackLocalTelemetry } {
  const now = dependencies.now ?? Date.now
  const id = dependencies.id ?? defaultId
  const momentWindowMs = dependencies.momentWindowMs ?? 750
  const capacity = Math.max(1, Math.floor(dependencies.dedupeCapacity ?? 1_000))
  const sessionId = `session:${id()}`
  const sessionKeys = new Map<string, true>()
  const momentKeys = new Map<string, number>()

  const trim = <T>(map: Map<string, T>): void => {
    while (map.size > capacity) {
      const oldest = map.keys().next().value as string
      map.delete(oldest)
    }
  }

  const track: TrackLocalTelemetry = async (event) => {
    const mode = event.dedupe ?? 'none'
    const key = [event.action, event.surface, event.targetType, event.targetId].join('|')
    if (mode === 'session') {
      if (sessionKeys.has(key)) return
      sessionKeys.set(key, true)
      trim(sessionKeys)
    } else if (mode === 'moment') {
      const timestamp = now()
      const previous = momentKeys.get(key)
      if (previous !== undefined && timestamp - previous < momentWindowMs) return
      momentKeys.delete(key)
      momentKeys.set(key, timestamp)
      trim(momentKeys)
    }

    try {
      await requestData({
        operation: 'trading-core.local-learning-events',
        input: {
          events: [{
            event_id: `event:${id()}`,
            schema_version: 1,
            action: event.action,
            surface: event.surface,
            target_type: event.targetType,
            target_id: event.targetId,
            session_id: sessionId,
            context: { ...(event.context ?? {}) },
          }],
        },
      })
    } catch {
      // Telemetry is an accessory capability and never changes the product action.
    }
  }

  return { sessionId, track }
}
