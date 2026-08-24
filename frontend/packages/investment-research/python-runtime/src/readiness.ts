import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type {
  InvestmentBackendId,
  InvestmentBackendReadiness,
  InvestmentCapabilityDefinition,
  InvestmentCapabilityReadiness,
  InvestmentCapabilityUse,
  InvestmentCredentialReadiness,
  InvestmentReadinessSnapshot,
  InvestmentRuntimeAssetReadiness,
  PythonBackendDefinition,
  PythonBackendLease,
} from './types.ts'

/** Non-secret facts captured for one credential actually considered during owned spawn. */
export interface RuntimeCredentialFact {
  /** Credential reference. */
  readonly ref: CredentialRef
  /** Whether the child received a resolved value. */
  readonly configured: boolean
  /** Provider source of the resolved value, when configured. */
  readonly source?: string
  /** Whether the effective source may be replaced through the provider. */
  readonly writable: boolean
}

/** Minimal backend lifecycle state consumed by readiness projection and preflight. */
export interface BackendReadinessState {
  /** Registered or active backend definition. */
  readonly definition: PythonBackendDefinition
  /** Verified ownership, or `null` while inactive. */
  readonly ownership: PythonBackendLease['ownership'] | null
  /** Latest verified health, or inactive when no entry is active. */
  readonly health: 'healthy' | 'failed' | 'inactive'
  /** Captured owned-child credential facts. */
  readonly credentials: readonly RuntimeCredentialFact[]
  /** Whether a referenced credential changed after the owned child started. */
  readonly restartRequired: boolean
}

interface CapabilityEntry {
  readonly definition: InvestmentCapabilityDefinition
  registrations: number
}

function sameCapability(left: InvestmentCapabilityDefinition, right: InvestmentCapabilityDefinition): boolean {
  return left.backendId === right.backendId && left.toolCount === right.toolCount && left.llm === right.llm
}

function credentialRefs(definition: PythonBackendDefinition): readonly CredentialRef[] {
  return [...new Set(definition.credentialEnv?.map(credential => credential.ref) ?? [])].sort()
}

function relevantCredentialRefs(
  definition: PythonBackendDefinition,
  role: 'required' | 'enhancement',
): readonly CredentialRef[] {
  return [...new Set(definition.credentialEnv
    ?.filter(credential => credential.role === role)
    .map(credential => credential.ref) ?? [])].sort()
}

function projectCredentials(state: BackendReadinessState): readonly InvestmentCredentialReadiness[] {
  if (state.ownership === 'attached' || state.ownership === 'external') {
    return credentialRefs(state.definition).map(ref => Object.freeze({ ref, status: 'external-managed' as const }))
  }
  if (state.ownership !== 'owned') return []
  return state.credentials.map((credential) => Object.freeze({
    ref: credential.ref,
    configured: credential.configured,
    ...(credential.source === undefined ? {} : { source: credential.source }),
    writable: credential.writable,
    status: state.restartRequired
      ? 'restart-required'
      : credential.configured
        ? credential.writable ? 'configured' : 'read-only'
        : 'missing',
  }))
}

function credentialCoverage(
  state: BackendReadinessState,
  role: 'required' | 'enhancement',
): Readonly<{
  refs: readonly CredentialRef[]
  missing: CredentialRef | undefined
  configured: boolean
}> {
  const refs = relevantCredentialRefs(state.definition, role)
  const missing = refs.find(ref => !state.credentials.some(credential => credential.ref === ref && credential.configured))
  return { refs, missing, configured: refs.length > 0 && missing === undefined }
}

function isConfigured(state: BackendReadinessState, definition: InvestmentCapabilityDefinition): boolean {
  if (state.ownership === 'attached' || state.ownership === 'external') return true
  if (state.ownership !== 'owned' || state.restartRequired) return false
  if (definition.llm === 'none') return true
  return credentialCoverage(state, definition.llm).configured
}

function capabilityStatus(
  state: BackendReadinessState,
  definition: InvestmentCapabilityDefinition,
): InvestmentCapabilityReadiness['status'] {
  if (state.ownership === null || state.health !== 'healthy' || state.restartRequired) return 'unavailable'
  const configured = isConfigured(state, definition)
  if (definition.backendId === 'trading-core') return configured ? 'stock-full' : 'unavailable'
  if (definition.llm === 'enhancement' && !configured) return 'market-template-only'
  return configured ? 'market-full' : 'unavailable'
}

function backendStatus(state: BackendReadinessState): InvestmentBackendReadiness['backendStatus'] {
  if (state.health === 'failed') return 'failed'
  if (state.ownership === 'owned') return 'healthy-owned'
  if (state.ownership === 'attached') return 'healthy-attached'
  if (state.ownership === 'external') return 'external'
  return 'stopped'
}

/** Capability registry and pure readiness/preflight state machine. */
export class InvestmentReadinessTracker {
  private readonly capabilities = new Map<InvestmentBackendId, CapabilityEntry>()

  /**
   * Publish one business capability; identical owners share a count and conflicts fail.
   * @param definition - backend, tool count, and LLM relationship.
   * @returns idempotent disposer for this contribution.
   */
  registerCapability(definition: InvestmentCapabilityDefinition): () => void {
    const normalized = Object.freeze({ ...definition })
    const current = this.capabilities.get(definition.backendId)
    if (current !== undefined) {
      if (!sameCapability(current.definition, normalized)) {
        throw new Error(`investment capability "${definition.backendId}" registration conflict`)
      }
      current.registrations += 1
    } else {
      this.capabilities.set(definition.backendId, { definition: normalized, registrations: 1 })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const entry = this.capabilities.get(definition.backendId)
      if (entry === undefined) return
      entry.registrations -= 1
      if (entry.registrations === 0) this.capabilities.delete(definition.backendId)
    }
  }

  /**
   * Build an immutable, client-safe readiness snapshot.
   * @param states - current backend lifecycle facts.
   * @param runtimeLogPath - active Runtime log path resolver.
   * @returns backend-id-sorted readiness DTO.
   */
  readiness(
    states: readonly BackendReadinessState[],
    runtimeLogPath: (id: InvestmentBackendId) => string,
    runtimeAsset: InvestmentRuntimeAssetReadiness,
  ): InvestmentReadinessSnapshot {
    const byId = new Map(states.map(state => [state.definition.id, state]))
    const ids = new Set<InvestmentBackendId>([...byId.keys(), ...this.capabilities.keys()])
    const backends = [...ids].sort().map((id): InvestmentBackendReadiness => {
      const state = byId.get(id)
      const capability = this.capabilities.get(id)?.definition
      return Object.freeze({
        backendId: id,
        ownership: state?.ownership ?? null,
        backendStatus: state === undefined ? 'stopped' : backendStatus(state),
        credentials: Object.freeze(state === undefined ? [] : [...projectCredentials(state)]),
        capability: capability === undefined
          ? null
          : Object.freeze({
            llm: capability.llm,
            toolCount: capability.toolCount,
            status: state === undefined ? 'unavailable' : capabilityStatus(state, capability),
          }),
        restartRequired: state?.restartRequired ?? false,
        runtimeLogPath: runtimeLogPath(id),
      })
    })
    return Object.freeze({ runtimeAsset, backends: Object.freeze(backends) })
  }

  /**
   * Reject a business operation that cannot safely use the active backend.
   * @param backendId - backend required by the operation.
   * @param state - current lifecycle state for the requested backend.
   * @param use - operation's LLM relationship.
   * @param runtimeLogPath - active Runtime log path for repair diagnostics.
   */
  assertCapability(
    backendId: InvestmentBackendId,
    state: BackendReadinessState | undefined,
    use: InvestmentCapabilityUse,
    runtimeLogPath: string,
  ): void {
    const capability = this.capabilities.get(backendId)?.definition
    if (state === undefined || state.ownership === null || capability === undefined) {
      const ref = state === undefined ? undefined : credentialRefs(state.definition)[0]
      throw new Error(this.errorMessage(backendId, ref, 'is not active with a registered capability', runtimeLogPath))
    }
    if (state.health !== 'healthy') {
      const ref = credentialRefs(state.definition)[0]
      throw new Error(this.errorMessage(backendId, ref, 'failed its latest health check', runtimeLogPath))
    }
    if (use === 'non-llm' || state.ownership === 'attached' || state.ownership === 'external') return
    const coverage = credentialCoverage(state, use === 'llm-required' ? 'required' : 'enhancement')
    const ref = coverage.refs[0] ?? credentialRefs(state.definition)[0]
    if (state.restartRequired) {
      throw new Error(this.errorMessage(state.definition.id, ref, 'must restart after its credential changed', runtimeLogPath))
    }
    if (use === 'llm-enhancement') return
    if (!coverage.configured) {
      throw new Error(this.errorMessage(
        state.definition.id,
        coverage.missing ?? ref,
        'requires a configured credential',
        runtimeLogPath,
      ))
    }
  }

  private errorMessage(
    backendId: string,
    ref: CredentialRef | undefined,
    reason: string,
    runtimeLogPath: string,
  ): string {
    const credential = ref === undefined ? 'its declared credential' : `credential "${ref}"`
    return `investment Python backend "${backendId}" ${reason}: ${credential}. Open Settings > Models to manage the credential. Runtime log: ${runtimeLogPath}`
  }
}
