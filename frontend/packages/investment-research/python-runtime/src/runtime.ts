import { access } from 'node:fs/promises'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { checkBackendHealth as defaultCheckHealth } from './health.ts'
import { BackendLog, backendLogPaths, safeErrorMessage } from './log.ts'
import { resolveBackendAddress, resolveBackendPaths as defaultResolvePaths } from './path.ts'
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
  PythonBackendDefinition,
  PythonBackendLease,
  ResolvedBackendPaths,
} from './types.ts'

const DEFAULT_CONFIG = {
  startupTimeoutMs: 30_000,
  healthPollMs: 250,
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
}

type ActiveEntry =
  | (ActiveEntryBase & Readonly<{ ownership: 'owned'; handle: SubprocessHandle; log: BackendLog; state: OwnedBackendState }>)
  | (ActiveEntryBase & Readonly<{ ownership: 'attached' | 'external'; handle?: never; log?: never; state?: never }>)

type HealthCheck = (definition: PythonBackendDefinition, options?: { signal?: AbortSignal }) => Promise<BackendHealthResult>

interface StartupFlight {
  controller: AbortController
  promise: Promise<ActiveEntry>
  waiters: number
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error)
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
  readonly executableExists?: (path: string) => Promise<boolean>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

function sameDefinition(left: PythonBackendDefinition, right: PythonBackendDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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
  private readonly stopping = new Map<InvestmentBackendId, Promise<void>>()
  private disposed = false
  private readonly subprocess: SubprocessRuntime
  private readonly config: RuntimeConfig
  private readonly checkHealth: HealthCheck
  private readonly resolvePaths: (definition: PythonBackendDefinition) => ResolvedBackendPaths
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
    this.resolvePaths = options.resolvePaths ?? defaultResolvePaths
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
    const current = this.definitions.get(definition.id)
    if (current !== undefined) {
      if (!sameDefinition(current.definition, definition)) {
        throw new Error(`investment Python backend "${definition.id}" registration conflict`)
      }
      current.registrations += 1
    } else {
      this.definitions.set(definition.id, { definition, registrations: 1 })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const entry = this.definitions.get(definition.id)
      /* v8 ignore next -- another owner cannot delete a still-counted definition */
      if (entry === undefined) return
      entry.registrations -= 1
      if (entry.registrations === 0) this.definitions.delete(definition.id)
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
      if (this.disposed) throw new Error('investment Python runtime is disposed')
    }

    let entry = this.active.get(id)
    if (entry !== undefined) {
      const health = await this.checkHealth(registered.definition, signal === undefined ? {} : { signal })
      if (health.status !== 'healthy') {
        throw new Error(`investment Python backend "${id}" health is ${health.status}`)
      }
      if (this.active.get(id) !== entry || this.stopping.has(id)) return this.acquire(id, signal)
    }
    if (entry === undefined) {
      let flight = this.flights.get(id)
      if (flight === undefined) {
        const controller = new AbortController()
        let created: StartupFlight
        const promise = this.start(registered.definition, controller.signal)
          .then(async (started) => {
            /* v8 ignore next -- start observes the internal signal; this closes only its final publication race. */
            if (this.disposed || created.waiters === 0) {
              await this.stop(started)
              /* v8 ignore next -- both messages describe the same defensive publication race. */
              throw new Error(this.disposed ? 'investment Python runtime is disposed' : 'investment Python backend acquisition cancelled')
            }
            this.active.set(id, started)
            return started
          })
          .finally(() => {
            /* v8 ignore next -- no replacement flight can publish until this flight removes itself. */
            if (this.flights.get(id) === created) this.flights.delete(id)
          })
        created = { controller, promise, waiters: 0 }
        void promise.catch(() => {})
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
          const idle = this.active.get(id)
          /* v8 ignore next -- covers cancellation between shared publication and this waiter's continuation. */
          if (idle?.refs === 0) await this.stopIdle(idle)
        }
      }
    }
    entry.refs += 1
    return this.lease(entry)
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
    /* v8 ignore next -- ordinary non-owned releases are handled directly in lease.release. */
    if (entry.ownership !== 'owned') {
      this.active.delete(id)
      return
    }
    const current = this.stopping.get(id)
    /* v8 ignore next -- only the defensive cancelled-waiter cleanup can join an existing stop. */
    if (current !== undefined) return current
    const stopping = this.stop(entry).finally(() => {
      this.active.delete(id)
      this.stopping.delete(id)
    })
    this.stopping.set(id, stopping)
    await stopping
  }

  private async start(definition: PythonBackendDefinition, signal: AbortSignal): Promise<ActiveEntry> {
    resolveBackendAddress(definition)
    const health = await this.checkHealth(definition, { signal })
    signal.throwIfAborted()
    if (health.status === 'healthy') {
      return { definition, ownership: definition.mode === 'external' ? 'external' : 'attached', refs: 0 }
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
    const log = await BackendLog.open(backendLogPaths(this.config.dshHome, definition.id), {
      tailBytes: this.config.logTailBytes,
      maxBytes: this.config.logMaxBytes,
    })
    const oldState = await readOwnedBackendState(ownedBackendStatePath(this.config.dshHome, definition.id))
    if (oldState.kind !== 'missing') await log.append('runtime', `previous runtime state: ${oldState.kind}\n`)

    const address = resolveBackendAddress(definition)
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
        ...(definition.managedEnv === undefined ? {} : { env: { ...definition.managedEnv } }),
      })
    } catch (error) {
      throw new Error(`investment Python backend "${definition.id}" spawn failed: ${safeErrorMessage(error, definition.managedEnv)}`)
    }
    const offsets = { stdout: 0, stderr: 0 }
    let outcome: Awaited<SubprocessHandle['done']> | undefined
    let spawnFailure: unknown
    void handle.done.then((value) => { outcome = value }, (error: unknown) => { spawnFailure = error })
    const drain = async (): Promise<void> => {
      for (const source of ['stdout', 'stderr'] as const) {
        const read = handle.collected[source]?.readFrom(offsets[source])
        if (read !== undefined) {
          offsets[source] = read.nextOffset
          await log.append(source, read.text)
        }
      }
    }
    let state: OwnedBackendState | undefined
    try {
      const deadlineAt = this.internals.now() + this.config.startupTimeoutMs
      for (;;) {
        signal.throwIfAborted()
        const next = await this.checkHealth(definition, { signal })
        await drain()
        signal.throwIfAborted()
        if (next.status === 'healthy') break
        if (next.status !== 'refused') {
          throw new Error(`investment Python backend "${definition.id}" health is ${next.status}`)
        }
        if (spawnFailure !== undefined || outcome !== undefined) {
          const fact = spawnFailure === undefined
            ? `exit ${String(outcome?.exitCode)}`
            : safeErrorMessage(spawnFailure, definition.managedEnv)
          throw new Error(`investment Python backend "${definition.id}" exited before healthy (${fact})\n${log.tail()}`)
        }
        if (this.internals.now() >= deadlineAt) {
          throw new Error(`investment Python backend "${definition.id}" startup timed out after ${this.config.startupTimeoutMs}ms\n${log.tail()}`)
        }
        await this.internals.sleep(this.config.healthPollMs)
      }

      state = {
        version: 1,
        id: definition.id,
        service: definition.service,
        pid: handle.pid,
        baseUrl: definition.baseUrl,
        projectDir: paths.projectDir,
        startedAt: new Date().toISOString(),
      }
      await writeOwnedBackendState(ownedBackendStatePath(this.config.dshHome, definition.id), state)
      return { definition, ownership: 'owned', handle, log, state, refs: 0 }
    } catch (error) {
      await this.failOwned(handle, drain)
      if (state !== undefined) {
        await Promise.allSettled([
          clearOwnedBackendState(ownedBackendStatePath(this.config.dshHome, definition.id), state),
        ])
      }
      throw error
    }
  }

  private async failOwned(handle: SubprocessHandle, drain: () => Promise<void>): Promise<void> {
    handle.terminate()
    await Promise.allSettled([handle.waitForExit()])
    await Promise.allSettled([drain()])
  }

  private async stop(entry: ActiveEntry): Promise<void> {
    if (entry.ownership !== 'owned') return
    entry.handle.terminate()
    const exit = await Promise.allSettled([entry.handle.waitForExit()])
    await clearOwnedBackendState(ownedBackendStatePath(this.config.dshHome, entry.definition.id), entry.state)
    const failure = exit[0]
    if (failure?.status === 'rejected') throw failure.reason
  }

  /** Reject new work, terminate every in-memory owned handle, and await tree quiescence. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const flight of this.flights.values()) flight.controller.abort(new Error('investment Python runtime is disposed'))
    const flights = [...this.flights.values()].map(flight => flight.promise)
    if (flights.length > 0) await Promise.allSettled(flights)
    const stopping = [...this.stopping.values()]
    if (stopping.length > 0) await Promise.allSettled(stopping)
    const entries = [...this.active.values()]
    this.active.clear()
    await Promise.all(entries.map(entry => this.stop(entry)))
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
