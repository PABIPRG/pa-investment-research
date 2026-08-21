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
  private readonly flights = new Map<InvestmentBackendId, Promise<ActiveEntry>>()
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

    let entry = this.active.get(id)
    if (entry !== undefined && entry.ownership !== 'owned') {
      const health = await this.checkHealth(registered.definition, signal === undefined ? {} : { signal })
      if (health.status !== 'healthy') {
        throw new Error(`investment Python backend "${id}" health is ${health.status}`)
      }
    }
    if (entry === undefined) {
      let flight = this.flights.get(id)
      if (flight === undefined) {
        flight = this.start(registered.definition, signal)
        this.flights.set(id, flight)
        void flight.finally(() => { this.flights.delete(id) }).catch(() => {})
      }
      entry = await flight
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can race the awaited startup flight.
      if (this.disposed) {
        await this.stop(entry)
        throw new Error('investment Python runtime is disposed')
      }
      this.active.set(id, entry)
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
        this.active.delete(entry.definition.id)
        await this.stop(entry)
      },
    }
  }

  private async start(definition: PythonBackendDefinition, signal?: AbortSignal): Promise<ActiveEntry> {
    resolveBackendAddress(definition)
    const health = await this.checkHealth(definition, signal === undefined ? {} : { signal })
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
        ...(signal === undefined ? {} : { signal }),
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
    const deadlineAt = this.internals.now() + this.config.startupTimeoutMs
    for (;;) {
      signal?.throwIfAborted()
      const next = await this.checkHealth(definition, signal === undefined ? {} : { signal })
      await drain()
      if (next.status === 'healthy') break
      if (next.status !== 'refused') {
        await this.failOwned(handle, drain)
        throw new Error(`investment Python backend "${definition.id}" health is ${next.status}`)
      }
      if (spawnFailure !== undefined || outcome !== undefined) {
        const fact = spawnFailure === undefined
          ? `exit ${String(outcome?.exitCode)}`
          : safeErrorMessage(spawnFailure, definition.managedEnv)
        throw new Error(`investment Python backend "${definition.id}" exited before healthy (${fact})\n${log.tail()}`)
      }
      if (this.internals.now() >= deadlineAt) {
        await this.failOwned(handle, drain)
        throw new Error(`investment Python backend "${definition.id}" startup timed out after ${this.config.startupTimeoutMs}ms\n${log.tail()}`)
      }
      await this.internals.sleep(this.config.healthPollMs)
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
    await writeOwnedBackendState(ownedBackendStatePath(this.config.dshHome, definition.id), state)
    return { definition, ownership: 'owned', handle, log, state, refs: 0 }
  }

  private async failOwned(handle: SubprocessHandle, drain: () => Promise<void>): Promise<void> {
    handle.terminate()
    await handle.waitForExit()
    await drain()
  }

  private async stop(entry: ActiveEntry): Promise<void> {
    if (entry.ownership !== 'owned') return
    entry.handle.terminate()
    await entry.handle.waitForExit()
    await clearOwnedBackendState(ownedBackendStatePath(this.config.dshHome, entry.definition.id), entry.state)
  }

  /** Reject new work, terminate every in-memory owned handle, and await tree quiescence. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.allSettled([...this.flights.values()])
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
