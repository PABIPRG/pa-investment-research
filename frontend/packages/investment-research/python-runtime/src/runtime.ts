import { access } from 'node:fs/promises'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CredentialInfo, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { checkBackendHealth as defaultCheckHealth } from './health.ts'
import { BackendLog, backendLogPaths, safeErrorMessage } from './log.ts'
import type { BackendLogPaths } from './log.ts'
import { resolveBackendAddress, resolveBackendPaths as defaultResolvePaths } from './path.ts'
import { InvestmentReadinessTracker } from './readiness.ts'
import type { BackendReadinessState, RuntimeCredentialFact } from './readiness.ts'
import {
  clearOwnedBackendState,
  ownedBackendStatePath,
  readOwnedBackendState,
  writeOwnedBackendState,
} from './state.ts'
import type { OwnedBackendState } from './state.ts'
import type {
  BackendHealthResult,
  Config,
  InvestmentBackendId,
  InvestmentCapabilityDefinition,
  InvestmentCapabilityUse,
  InvestmentReadinessSnapshot,
  InvestmentRuntimeAssetReadiness,
  ManagedCredentialEnv,
  PythonBackendDefinition,
  PythonBackendLease,
  ResolvedBackendPaths,
} from './types.ts'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'

const DEFAULT_CONFIG = {
  startupTimeoutMs: 30_000,
  healthPollMs: 250,
  healthFreshnessMs: 5_000,
  healthTimeoutMs: 2_000,
  shutdownGraceMs: 5_000,
  logTailBytes: 65_536,
  logMaxBytes: 4_194_304,
} as const

type RuntimeConfig = Required<Omit<Config, 'dshHome'>> & { readonly dshHome: string }

interface RegistryEntry {
  readonly definition: PythonBackendDefinition
  registrations: number
}

interface ActiveEntryBase {
  readonly definition: PythonBackendDefinition
  refs: number
  health: 'healthy' | 'failed'
  healthVerifiedAt: number | undefined
  healthGeneration: number
}

type ActiveEntry =
  | (ActiveEntryBase & {
    readonly ownership: 'owned'
    readonly handle: SubprocessHandle
    readonly log: BackendLog
    readonly state: OwnedBackendState
    readonly credentials: readonly RuntimeCredentialFact[]
    restartRequired: boolean
  })
  | (ActiveEntryBase & Readonly<{ ownership: 'attached' | 'external'; handle?: never; log?: never; state?: never }>)

type HealthCheck = (definition: PythonBackendDefinition, options?: { signal?: AbortSignal }) => Promise<BackendHealthResult>
type CredentialResolver = (ref: CredentialRef) => Promise<string | ResolvedCredential | undefined>
type CredentialDescriber = (ref: CredentialRef) => Promise<CredentialInfo>
type EnvironmentKeyNormalizer = (key: string) => string
type LogPathResolver = (dshHome: string, id: InvestmentBackendId) => BackendLogPaths

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BUNDLED_ENVIRONMENT_KEYS = ['PYTHONPATH', 'DSH_INVESTMENT_STATE_DIR', 'PYTHONDONTWRITEBYTECODE'] as const

interface StartupFlight {
  controller: AbortController
  promise: Promise<ActiveEntry>
  waiters: number
}

interface ActiveHealthFlight {
  readonly entry: ActiveEntry
  readonly generation: number
  promise: Promise<BackendHealthResult>
}

interface CredentialGenerationCapture {
  readonly ref: CredentialRef
  readonly generation: number
}

interface StableCredentialRead {
  readonly value: string | undefined
  readonly fact: RuntimeCredentialFact
  readonly generation: CredentialGenerationCapture
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted)
      reject(asError(signal.reason))
    }
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(asError(error))
      },
    )
  })
}

/** Injectable runtime dependencies used by deterministic lifecycle tests. */
export interface InvestmentBackendManagerOptions {
  readonly subprocess: SubprocessRuntime
  readonly config?: Config
  readonly checkHealth?: HealthCheck
  readonly resolvePaths?: (definition: PythonBackendDefinition) => ResolvedBackendPaths
  /** Resolve one credential only when an owned child is about to spawn. */
  readonly resolveCredential?: CredentialResolver
  /** Describe one credential without its value during owned spawn. */
  readonly describeCredential?: CredentialDescriber
  /** Resolve Runtime log locations from the same source used by preflight diagnostics. */
  readonly resolveLogPaths?: LogPathResolver
  /** Normalize child environment keys for the target platform's spawn semantics. */
  readonly normalizeEnvironmentKey?: EnvironmentKeyNormalizer
  readonly executableExists?: (path: string) => Promise<boolean>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

function sameDefinition(left: PythonBackendDefinition, right: PythonBackendDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function defaultNormalizeEnvironmentKey(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key
}

function normalizeCredentialEnv(
  definition: PythonBackendDefinition,
  normalizeEnvironmentKey: EnvironmentKeyNormalizer,
): readonly ManagedCredentialEnv[] | undefined {
  const managed = new Set(Object.keys(definition.managedEnv ?? {}).map(normalizeEnvironmentKey))
  const reserved = new Set(BUNDLED_ENVIRONMENT_KEYS.map(normalizeEnvironmentKey))
  const reservedManaged = [...managed].find(key => reserved.has(key))
  if (reservedManaged !== undefined) {
    throw new Error(`investment Python backend "${definition.id}" managed environment "${reservedManaged}" is reserved by the bundled Runtime`)
  }
  if (definition.credentialEnv === undefined) return undefined
  const targets = new Set<string>()
  const normalized = definition.credentialEnv.map((credential) => {
    if (!ENVIRONMENT_NAME.test(credential.env)) {
      throw new Error(`investment Python backend "${definition.id}" has invalid credential environment "${credential.env}"`)
    }
    const env = normalizeEnvironmentKey(credential.env)
    if (reserved.has(env)) {
      throw new Error(`investment Python backend "${definition.id}" credential environment "${env}" is reserved by the bundled Runtime`)
    }
    if (targets.has(env)) {
      throw new Error(`investment Python backend "${definition.id}" has duplicate credential environment "${env}"`)
    }
    if (managed.has(env)) {
      throw new Error(`investment Python backend "${definition.id}" credential environment "${env}" conflicts with managed environment`)
    }
    targets.add(env)
    return Object.freeze({ ref: credential.ref, env, role: credential.role })
  })
  normalized.sort((left, right) => {
    if (left.env < right.env) return -1
    if (left.env > right.env) return 1
    if (left.ref < right.ref) return -1
    if (left.ref > right.ref) return 1
    if (left.role < right.role) return -1
    if (left.role > right.role) return 1
    return 0
  })
  return Object.freeze(normalized)
}

function normalizeDefinition(
  definition: PythonBackendDefinition,
  normalizeEnvironmentKey: EnvironmentKeyNormalizer,
): PythonBackendDefinition {
  const credentialEnv = normalizeCredentialEnv(definition, normalizeEnvironmentKey)
  return Object.freeze({
    ...definition,
    ...(credentialEnv === undefined ? {} : { credentialEnv }),
  })
}

class CredentialOutputRedactor {
  private pending = ''
  private readonly values: readonly string[]

  constructor(private readonly env: Readonly<Record<string, string>> | undefined) {
    this.values = [...new Set(Object.values(env ?? {}).filter(value => value.length > 0))]
  }

  redact(text: string): string {
    const input = this.pending + text
    this.pending = this.trailingPrefix(input)
    return safeErrorMessage(input.slice(0, input.length - this.pending.length), this.env)
  }

  flush(): string {
    const pending = this.pending
    this.pending = ''
    return safeErrorMessage(pending, this.env)
  }

  private trailingPrefix(text: string): string {
    for (let index = 0; index < text.length; index += 1) {
      const candidate = text.slice(index)
      if (this.values.some(value => value.startsWith(candidate))) return candidate
    }
    return ''
  }
}

class OwnedStartupFailure extends Error {
  constructor(
    readonly kind: 'exited' | 'timed-out',
    readonly fact?: string,
  ) {
    super(kind)
  }
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Per-backend single-flight registry and process ownership manager. */
export class InvestmentBackendManager {
  private readonly definitions = new Map<InvestmentBackendId, RegistryEntry>()
  private readonly active = new Map<InvestmentBackendId, ActiveEntry>()
  private readonly flights = new Map<InvestmentBackendId, StartupFlight>()
  private readonly healthFlights = new Map<InvestmentBackendId, ActiveHealthFlight>()
  private readonly stopping = new Map<InvestmentBackendId, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private disposed = false
  private readonly subprocess: SubprocessRuntime
  private readonly config: RuntimeConfig
  private readonly checkHealth: HealthCheck
  private readonly resolvePaths: (definition: PythonBackendDefinition) => ResolvedBackendPaths
  private readonly resolveCredential: CredentialResolver
  private readonly describeCredential: CredentialDescriber | undefined
  private readonly resolveLogPaths: LogPathResolver
  private readonly normalizeEnvironmentKey: EnvironmentKeyNormalizer
  private readonly readinessTracker = new InvestmentReadinessTracker()
  private readonly credentialGenerations = new Map<CredentialRef, number>()
  private readonly startupCredentialGenerations = new WeakMap<ActiveEntry, readonly CredentialGenerationCapture[]>()
  /** Injectable filesystem and timing operations retained for deterministic lifecycle tests. */
  readonly internals: {
    executableExists: (path: string) => Promise<boolean>
    sleep: (ms: number) => Promise<void>
    now: () => number
  }

  constructor(options: InvestmentBackendManagerOptions) {
    this.subprocess = options.subprocess
    this.config = { ...DEFAULT_CONFIG, ...options.config, dshHome: resolveDshHome(options.config?.dshHome) }
    this.checkHealth = options.checkHealth ?? defaultCheckHealth
    this.resolvePaths = options.resolvePaths ?? (definition => defaultResolvePaths(definition, { dshHome: this.config.dshHome }))
    this.resolveCredential = options.resolveCredential ?? (async () => undefined)
    this.describeCredential = options.describeCredential
    this.resolveLogPaths = options.resolveLogPaths ?? backendLogPaths
    this.normalizeEnvironmentKey = options.normalizeEnvironmentKey ?? defaultNormalizeEnvironmentKey
    this.internals = {
      executableExists: options.executableExists ?? executableExists,
      sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      now: options.now ?? Date.now,
    }
  }

  /**
   * Register one definition; identical owners share a count and conflicts fail.
   * @param definition - complete backend identity and launch facts.
   * @returns idempotent disposer for this registration.
   */
  register(definition: PythonBackendDefinition): () => void {
    if (this.disposed) throw new Error('investment Python runtime is disposed')
    const normalized = normalizeDefinition(definition, this.normalizeEnvironmentKey)
    const current = this.definitions.get(normalized.id)
    if (current !== undefined) {
      if (!sameDefinition(current.definition, normalized)) {
        throw new Error(`investment Python backend "${normalized.id}" registration conflict`)
      }
      current.registrations += 1
    } else {
      this.definitions.set(normalized.id, { definition: normalized, registrations: 1 })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const entry = this.definitions.get(normalized.id)
      /* v8 ignore next -- another owner cannot delete a still-counted definition */
      if (entry === undefined) return
      entry.registrations -= 1
      if (entry.registrations === 0) this.definitions.delete(normalized.id)
    }
  }

  /**
   * Publish one backend capability after its tools are registered.
   * @param definition - backend, tool count, and LLM relationship.
   * @returns idempotent disposer for the capability contribution.
   */
  registerCapability(definition: InvestmentCapabilityDefinition): () => void {
    if (this.disposed) throw new Error('investment Python runtime is disposed')
    return this.readinessTracker.registerCapability(definition)
  }

  /**
   * Reject an operation that cannot safely use the active backend capability.
   * @param backendId - backend required by the operation.
   * @param use - operation's LLM relationship.
   */
  assertCapability(backendId: InvestmentBackendId, use: InvestmentCapabilityUse): void {
    if (this.disposed) throw new Error('investment Python runtime is disposed')
    const state = this.readinessStates().find(candidate => candidate.definition.id === backendId)
    this.readinessTracker.assertCapability(backendId, state, use, this.runtimeLogPath(backendId))
  }

  /**
   * Project current backend, credential, and capability facts without secrets.
   * @returns immutable JSON-safe readiness snapshot.
   */
  readiness(): InvestmentReadinessSnapshot {
    return this.readinessTracker.readiness(
      this.readinessStates(),
      id => this.runtimeLogPath(id),
      this.runtimeAssetReadiness(),
    )
  }

  /**
   * Mark active owned children that actually reference an updated credential.
   * @param ref - committed credential reference update.
   */
  credentialUpdated(ref: CredentialRef): void {
    if (this.disposed) return
    this.credentialGenerations.set(ref, (this.credentialGenerations.get(ref) ?? 0) + 1)
    for (const entry of this.active.values()) {
      if (entry.ownership !== 'owned') continue
      if (entry.definition.credentialEnv?.some(credential => credential.ref === ref) === true) {
        entry.restartRequired = true
        this.invalidateHealthFreshness(entry)
      }
    }
  }

  /**
   * Acquire a verified backend through a per-id single flight.
   * @param id - registered backend id.
   * @param signal - optional acquisition cancellation.
   * @returns one caller-owned verified backend lease.
   */
  async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease> {
    if (this.disposed) throw new Error('investment Python runtime is disposed')
    signal?.throwIfAborted()
    const registered = this.definitions.get(id)
    if (registered === undefined) throw new Error(`investment Python backend "${id}" is not registered`)

    const stopping = this.stopping.get(id)
    if (stopping !== undefined) {
      await waitWithSignal(stopping, signal)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can race the awaited teardown.
      if (this.disposed) throw new Error('investment Python runtime is disposed')
    }

    let entry = this.active.get(id)
    if (entry !== undefined) {
      await this.verifyActiveHealth(id, entry, signal)
      if (this.active.get(id) !== entry || this.stopping.has(id)) return this.acquire(id, signal)
    }
    if (entry === undefined) {
      let flight = this.flights.get(id)
      if (flight === undefined) {
        const controller = new AbortController()
        const created = { controller, waiters: 0 } as StartupFlight
        created.promise = this.start(registered.definition, controller.signal)
          .then(async (started) => {
            /* v8 ignore next -- start observes the internal signal; this closes only its final publication race. */
            if (this.disposed || created.waiters === 0) {
              await this.stop(started)
              /* v8 ignore next -- both messages describe the same defensive publication race. */
              throw new Error(this.disposed ? 'investment Python runtime is disposed' : 'investment Python backend acquisition cancelled')
            }
            this.applyCredentialUpdatesDuringStartup(started)
            this.active.set(id, started)
            this.observeOwnedExit(started)
            return started
          })
          .finally(() => {
            /* v8 ignore next -- no replacement flight can publish until this flight removes itself. */
            if (this.flights.get(id) === created) this.flights.delete(id)
          })
        void created.promise.catch(() => {})
        flight = created
        this.flights.set(id, flight)
      }
      flight.waiters += 1
      let acquired = false
      try {
        entry = await waitWithSignal(flight.promise, signal)
        acquired = true
      } finally {
        flight.waiters -= 1
        if (!acquired && flight.waiters === 0) {
          flight.controller.abort(signal?.reason ?? new Error('investment Python backend acquisition cancelled'))
          await Promise.allSettled([flight.promise])
        }
      }
    }
    entry.refs += 1
    return this.lease(entry)
  }

  private async verifyActiveHealth(id: InvestmentBackendId, entry: ActiveEntry, signal?: AbortSignal): Promise<void> {
    if (this.hasFreshHealth(entry)) return
    let flight = this.healthFlights.get(id)
    if (flight === undefined || flight.entry !== entry) {
      const created = { entry, generation: entry.healthGeneration } as ActiveHealthFlight
      created.promise = this.track(
        this.probeHealth(entry.definition, this.lifetime.signal)
          .then((health) => {
            if (this.active.get(id) === entry && entry.healthGeneration === created.generation) {
              entry.health = health.status === 'healthy' ? 'healthy' : 'failed'
              entry.healthVerifiedAt = health.status === 'healthy' ? this.internals.now() : undefined
            }
            return health
          }, (error: unknown) => {
            if (this.active.get(id) === entry && entry.healthGeneration === created.generation) {
              entry.health = 'failed'
              entry.healthVerifiedAt = undefined
            }
            throw error
          })
          .finally(() => {
            if (this.healthFlights.get(id) === created) this.healthFlights.delete(id)
          }),
      )
      flight = created
      this.healthFlights.set(id, flight)
    }
    const health = await waitWithSignal(flight.promise, signal)
    if (entry.healthGeneration !== flight.generation) {
      if (this.active.get(id) !== entry || this.stopping.has(id)) return
      return this.verifyActiveHealth(id, entry, signal)
    }
    if (health.status !== 'healthy') {
      throw new Error(`investment Python backend "${id}" health is ${health.status}`)
    }
  }

  private hasFreshHealth(entry: ActiveEntry): boolean {
    if (entry.health !== 'healthy' || entry.healthVerifiedAt === undefined) return false
    const age = this.internals.now() - entry.healthVerifiedAt
    return age >= 0 && age < this.config.healthFreshnessMs
  }

  private invalidateHealthFreshness(entry: ActiveEntry): void {
    entry.healthVerifiedAt = undefined
    entry.healthGeneration += 1
  }

  private async probeHealth(definition: PythonBackendDefinition, signal: AbortSignal): Promise<BackendHealthResult> {
    signal.throwIfAborted()
    const timeout = new AbortController()
    const timeoutError = new Error(
      `investment Python backend "${definition.id}" health probe timed out after ${this.config.healthTimeoutMs}ms`,
    )
    const timer = setTimeout(() => { timeout.abort(timeoutError) }, this.config.healthTimeoutMs)
    const probeSignal = AbortSignal.any([signal, timeout.signal])
    try {
      return await waitWithSignal(this.checkHealth(definition, { signal: probeSignal }), probeSignal)
    } catch (error) {
      if (timeout.signal.aborted && !signal.aborted) throw timeoutError
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private observeOwnedExit(entry: ActiveEntry): void {
    if (entry.ownership !== 'owned') return
    const invalidate = (): void => {
      if (this.active.get(entry.definition.id) !== entry) return
      entry.health = 'failed'
      this.invalidateHealthFreshness(entry)
    }
    void entry.handle.done.then(invalidate, invalidate)
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => { this.operations.delete(tracked) })
    this.operations.add(tracked)
    /* v8 ignore next -- prevents an abandoned caller race from becoming an unhandled rejection. */
    void tracked.catch(() => {})
    return tracked
  }

  private lease(entry: ActiveEntry): PythonBackendLease {
    let released = false
    return {
      id: entry.definition.id,
      baseUrl: entry.definition.baseUrl,
      ownership: entry.ownership,
      release: async () => {
        if (released) return
        released = true
        entry.refs -= 1
        if (entry.refs > 0) return
        if (this.active.get(entry.definition.id) !== entry) return
        if (entry.ownership !== 'owned') {
          this.active.delete(entry.definition.id)
          return
        }
        await this.stopIdle(entry)
      },
    }
  }

  private async stopIdle(entry: ActiveEntry): Promise<void> {
    const id = entry.definition.id
    this.invalidateHealthFreshness(entry)
    /* v8 ignore next -- ordinary non-owned releases are handled directly in lease.release. */
    if (entry.ownership !== 'owned') {
      this.active.delete(id)
      return
    }
    const current = this.stopping.get(id)
    /* v8 ignore next -- only the defensive cancelled-waiter cleanup can join an existing stop. */
    if (current !== undefined) return current
    const stopping = this.stop(entry).then(() => {
      this.active.delete(id)
    }).finally(() => {
      this.stopping.delete(id)
    })
    this.stopping.set(id, stopping)
    await stopping
  }

  private async resolveCredentialEnv(definition: PythonBackendDefinition, signal: AbortSignal): Promise<Readonly<{
    environment: Readonly<Record<string, string>> | undefined
    facts: readonly RuntimeCredentialFact[]
    generations: readonly CredentialGenerationCapture[]
  }>> {
    if (definition.credentialEnv === undefined) return { environment: undefined, facts: [], generations: [] }
    const values = new Map<CredentialRef, string | undefined>()
    const facts = new Map<CredentialRef, RuntimeCredentialFact>()
    const generations = new Map<CredentialRef, CredentialGenerationCapture>()
    const environment: Record<string, string> = {}
    for (const credential of definition.credentialEnv) {
      if (!values.has(credential.ref)) {
        signal.throwIfAborted()
        const stable = await this.resolveStableCredential(definition.id, credential.ref, signal)
        signal.throwIfAborted()
        values.set(credential.ref, stable.value)
        facts.set(credential.ref, stable.fact)
        generations.set(credential.ref, stable.generation)
      }
      const value = values.get(credential.ref)
      if (value !== undefined) environment[credential.env] = value
    }
    return Object.freeze({
      environment: Object.keys(environment).length === 0 ? undefined : environment,
      facts: Object.freeze([...facts.values()].sort((left, right) => left.ref.localeCompare(right.ref))),
      generations: Object.freeze([...generations.values()]),
    })
  }

  private async resolveStableCredential(
    backendId: InvestmentBackendId,
    ref: CredentialRef,
    signal: AbortSignal,
  ): Promise<StableCredentialRead> {
    for (;;) {
      signal.throwIfAborted()
      const generation = this.credentialGenerations.get(ref) ?? 0
      let resolved: string | ResolvedCredential | undefined
      try {
        signal.throwIfAborted()
        resolved = await waitWithSignal(this.resolveCredential(ref), signal)
        signal.throwIfAborted()
      } catch {
        signal.throwIfAborted()
        throw new Error(`investment Python backend "${backendId}" credential "${ref}" resolution failed`)
      }
      let info: CredentialInfo | undefined
      if (this.describeCredential !== undefined) {
        try {
          signal.throwIfAborted()
          info = await waitWithSignal(this.describeCredential(ref), signal)
          signal.throwIfAborted()
        } catch {
          signal.throwIfAborted()
          throw new Error(`investment Python backend "${backendId}" credential "${ref}" description failed`)
        }
      }
      if ((this.credentialGenerations.get(ref) ?? 0) !== generation) {
        signal.throwIfAborted()
        continue
      }
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      const source = typeof resolved === 'string' ? info?.source ?? 'resolver' : resolved?.source
      return {
        value,
        fact: Object.freeze({
          ref,
          configured: value !== undefined,
          ...(value === undefined || source === undefined ? {} : { source }),
          writable: info?.writable ?? true,
        }),
        generation: Object.freeze({ ref, generation }),
      }
    }
  }

  private async start(definition: PythonBackendDefinition, signal: AbortSignal): Promise<ActiveEntry> {
    resolveBackendAddress(definition)
    const health = await this.probeHealth(definition, signal)
    signal.throwIfAborted()
    if (health.status === 'healthy') {
      return {
        definition,
        ownership: definition.mode === 'external' ? 'external' : 'attached',
        health: 'healthy',
        healthVerifiedAt: this.internals.now(),
        healthGeneration: 0,
        refs: 0,
      }
    }
    if (definition.mode === 'external' || health.status !== 'refused') {
      throw new Error(`investment Python backend "${definition.id}" health is ${health.status}`)
    }

    const paths = this.resolvePaths(definition)
    if (!await this.internals.executableExists(paths.pythonExecutable)) {
      /* v8 ignore next -- Windows selection is exercised by path tests on non-Windows CI */
      const init = process.platform === 'win32' ? definition.initCommand.windows : definition.initCommand.posix
      throw new Error(`investment Python backend "${definition.id}" virtual environment is missing; run ${init} in ${paths.projectDir}`)
    }
    const log = await BackendLog.open(this.resolveLogPaths(this.config.dshHome, definition.id), {
      tailBytes: this.config.logTailBytes,
      maxBytes: this.config.logMaxBytes,
    })
    const oldState = await readOwnedBackendState(ownedBackendStatePath(this.config.dshHome, definition.id))
    if (oldState.kind !== 'missing') await log.append('runtime', `previous runtime state: ${oldState.kind}\n`)

    const address = resolveBackendAddress(definition)
    const resolvedCredentials = await this.resolveCredentialEnv(definition, signal)
    signal.throwIfAborted()
    const credentialEnv = resolvedCredentials.environment
    const bundledEnv = paths.source === 'bundled'
      ? {
          PYTHONPATH: paths.sitePackages!,
          DSH_INVESTMENT_STATE_DIR: paths.stateDir!,
          PYTHONDONTWRITEBYTECODE: '1',
        }
      : undefined
    const spawnEnv = definition.managedEnv === undefined && credentialEnv === undefined && bundledEnv === undefined
      ? undefined
      : { ...definition.managedEnv, ...credentialEnv, ...bundledEnv }
    const redactors = {
      stdout: new CredentialOutputRedactor(credentialEnv),
      stderr: new CredentialOutputRedactor(credentialEnv),
    }
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn({
        argv: [paths.pythonExecutable, '-m', 'uvicorn', definition.module, '--host', address.host, '--port', String(address.port)],
        cwd: paths.projectDir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.config.logTailBytes },
          stderr: { maxBytes: this.config.logTailBytes },
        },
        graceMs: this.config.shutdownGraceMs,
        signal,
        ...(spawnEnv === undefined ? {} : { env: spawnEnv }),
      })
    } catch (error) {
      throw new Error(`investment Python backend "${definition.id}" spawn failed: ${safeErrorMessage(error, spawnEnv)}`)
    }
    const offsets = { stdout: 0, stderr: 0 }
    let outcome: Awaited<SubprocessHandle['done']> | undefined
    let spawnFailure: unknown
    void handle.done.then((value) => { outcome = value }, (error: unknown) => { spawnFailure = error })
    const drain = async (final = false): Promise<void> => {
      for (const source of ['stdout', 'stderr'] as const) {
        const read = handle.collected[source]?.readFrom(offsets[source])
        if (read !== undefined) {
          offsets[source] = read.nextOffset
          const redacted = redactors[source].redact(read.text)
          if (redacted.length > 0) await log.append(source, redacted)
        }
        if (!final) continue
        const remaining = redactors[source].flush()
        if (remaining.length > 0) await log.append(source, remaining)
      }
    }
    const state: OwnedBackendState = {
      version: 1,
      id: definition.id,
      service: definition.service,
      pid: handle.pid,
      baseUrl: definition.baseUrl,
      projectDir: paths.projectDir,
      startedAt: new Date().toISOString(),
    }
    try {
      const deadlineAt = this.internals.now() + this.config.startupTimeoutMs
      for (;;) {
        signal.throwIfAborted()
        const next = await this.probeHealth(definition, signal)
        await drain()
        signal.throwIfAborted()
        if (next.status === 'healthy') break
        if (next.status !== 'refused') {
          throw new Error(`investment Python backend "${definition.id}" health is ${next.status}`)
        }
        if (spawnFailure !== undefined || outcome !== undefined) {
          const fact = spawnFailure === undefined
            ? `exit ${String(outcome?.exitCode)}`
            : safeErrorMessage(spawnFailure, spawnEnv)
          throw new OwnedStartupFailure('exited', fact)
        }
        if (this.internals.now() >= deadlineAt) {
          throw new OwnedStartupFailure('timed-out')
        }
        await this.internals.sleep(this.config.healthPollMs)
      }

      await writeOwnedBackendState(ownedBackendStatePath(this.config.dshHome, definition.id), state)
      const entry: ActiveEntry = {
        definition,
        ownership: 'owned',
        handle,
        log,
        state,
        credentials: resolvedCredentials.facts,
        restartRequired: false,
        health: 'healthy',
        healthVerifiedAt: this.internals.now(),
        healthGeneration: 0,
        refs: 0,
      }
      this.startupCredentialGenerations.set(entry, resolvedCredentials.generations)
      return entry
    } catch (error) {
      try {
        await this.failOwned(handle, drain)
      } catch (cleanupError) {
        const retained: ActiveEntry = {
          definition,
          ownership: 'owned',
          handle,
          log,
          state,
          credentials: resolvedCredentials.facts,
          restartRequired: false,
          health: 'failed',
          healthVerifiedAt: undefined,
          healthGeneration: 0,
          refs: 0,
        }
        this.startupCredentialGenerations.set(retained, resolvedCredentials.generations)
        this.applyCredentialUpdatesDuringStartup(retained)
        this.active.set(definition.id, retained)
        this.observeOwnedExit(retained)
        const original = this.startupFailureMessage(definition, error, log, spawnEnv)
        const cleanup = safeErrorMessage(cleanupError, spawnEnv)
        throw new AggregateError(
          [new Error(original), new Error(cleanup)],
          `${original}; owned process cleanup failed: ${cleanup}`,
        )
      }
      await Promise.allSettled([
        clearOwnedBackendState(ownedBackendStatePath(this.config.dshHome, definition.id), state),
      ])
      if (error instanceof OwnedStartupFailure) {
        throw new Error(this.startupFailureMessage(definition, error, log, spawnEnv))
      }
      throw error
    }
  }

  private startupFailureMessage(
    definition: PythonBackendDefinition,
    error: unknown,
    log: BackendLog,
    env: Readonly<Record<string, string | undefined>> | undefined,
  ): string {
    if (error instanceof OwnedStartupFailure) {
      if (error.kind === 'exited') {
        return `investment Python backend "${definition.id}" exited before healthy (${error.fact ?? 'unknown exit'})\n${log.tail()}`
      }
      return `investment Python backend "${definition.id}" startup timed out after ${this.config.startupTimeoutMs}ms\n${log.tail()}`
    }
    return `${safeErrorMessage(error, env)}\n${log.tail()}`
  }

  private async failOwned(handle: SubprocessHandle, drain: (final?: boolean) => Promise<void>): Promise<void> {
    handle.terminate()
    const exit = await Promise.allSettled([handle.waitForExit()])
    await Promise.allSettled([drain(true)])
    const failure = exit[0]
    if (failure.status === 'rejected') throw failure.reason
  }

  private async stop(entry: ActiveEntry): Promise<void> {
    if (entry.ownership !== 'owned') return
    entry.handle.terminate()
    try {
      await entry.handle.waitForExit()
    } catch (error) {
      throw new Error(`investment Python backend "${entry.definition.id}" process-tree wait failed: ${safeErrorMessage(error, entry.definition.managedEnv)}`)
    }
    await clearOwnedBackendState(ownedBackendStatePath(this.config.dshHome, entry.definition.id), entry.state)
  }

  /** Reject new work, terminate every in-memory owned handle, and await tree quiescence. */
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.lifetime.abort(new Error('investment Python runtime is disposed'))
    }
    for (const entry of this.active.values()) this.invalidateHealthFreshness(entry)
    for (const flight of this.flights.values()) flight.controller.abort(new Error('investment Python runtime is disposed'))
    const flights = [...this.flights.values()].map(flight => flight.promise)
    if (flights.length > 0) await Promise.allSettled(flights)
    const stopping = [...this.stopping.values()]
    if (stopping.length > 0) await Promise.allSettled(stopping)
    while (this.operations.size > 0) await Promise.allSettled([...this.operations])
    const entries = [...this.active.values()]
    const results = await Promise.allSettled(entries.map(async (entry) => {
      await this.stop(entry)
      this.active.delete(entry.definition.id)
    }))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map(result => asError(result.reason)), 'investment Python runtime disposal failed')
  }

  private runtimeLogPath(id: InvestmentBackendId): string {
    return this.resolveLogPaths(this.config.dshHome, id).active
  }

  private runtimeAssetReadiness(): InvestmentRuntimeAssetReadiness {
    const sources = new Set<ResolvedBackendPaths['source']>()
    for (const entry of this.definitions.values()) {
      try {
        sources.add(this.resolvePaths(entry.definition).source)
      } catch (error) {
        const detail = safeErrorMessage(error)
        return Object.freeze({
          status: /packaged runtime is invalid|bundled Runtime requires/iu.test(detail) ? 'invalid' : 'missing',
          detail,
        })
      }
    }
    return Object.freeze({ status: sources.has('bundled') ? 'bundled-ready' : 'source-env-ready' })
  }

  private applyCredentialUpdatesDuringStartup(entry: ActiveEntry): void {
    if (entry.ownership !== 'owned') return
    const generations = this.startupCredentialGenerations.get(entry)
    this.startupCredentialGenerations.delete(entry)
    if (generations?.some(({ ref, generation }) => (this.credentialGenerations.get(ref) ?? 0) !== generation) === true) {
      entry.restartRequired = true
    }
  }

  private readinessStates(): readonly BackendReadinessState[] {
    const states = new Map<InvestmentBackendId, BackendReadinessState>()
    for (const entry of this.definitions.values()) {
      states.set(entry.definition.id, {
        definition: entry.definition,
        ownership: null,
        health: 'inactive',
        credentials: [],
        restartRequired: false,
      })
    }
    for (const entry of this.active.values()) {
      states.set(entry.definition.id, entry.ownership === 'owned'
        ? {
          definition: entry.definition,
          ownership: entry.ownership,
          health: entry.health,
          credentials: entry.credentials,
          restartRequired: entry.restartRequired,
        }
        : {
          definition: entry.definition,
          ownership: entry.ownership,
          health: entry.health,
          credentials: [],
          restartRequired: false,
        })
    }
    return [...states.values()]
  }

  /**
   * Read mutable lifecycle relations for the invariant companion.
   * @returns mutable lifecycle relations for the invariant companion.
   */
  invariantSnapshot(): Readonly<{
    active: readonly ActiveEntry[]
    flights: readonly InvestmentBackendId[]
  }> {
    return { active: [...this.active.values()], flights: [...this.flights.keys()] }
  }
}
