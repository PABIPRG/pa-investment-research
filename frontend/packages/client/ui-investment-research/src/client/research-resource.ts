export type ResearchResourcePhase =
  | 'idle' | 'preparing' | 'ready' | 'refreshing' | 'stale' | 'unavailable'

export interface ResearchResourceSnapshot<T> {
  readonly phase: ResearchResourcePhase
  readonly value?: T
  readonly error: string
  readonly asOf?: string
}

export interface ResearchResourceStore {
  getSnapshot<T>(key: string): ResearchResourceSnapshot<T>
  read<T>(key: string, load: () => Promise<T>): Promise<T>
  revalidate<T>(key: string, load: () => Promise<T>): Promise<T>
  peek<T>(key: string): T | undefined
  subscribe(key: string, listener: () => void): () => void
  invalidate(key: string): void
  schedule(owner: string, key: string, delayMs: number, callback: () => void): void
  clearTimers(owner: string): void
}

interface ResourceFlight {
  readonly generation: number
  readonly promise: Promise<unknown>
}

interface ResourceEntry {
  generation: number
  snapshot: ResearchResourceSnapshot<unknown>
  hasValue: boolean
  currentFlight: ResourceFlight | undefined
  readonly activeFlights: Set<Promise<unknown>>
  lastUsed: number
}

const DEFAULT_LIMIT = 20
const IDLE_SNAPSHOT: ResearchResourceSnapshot<never> = Object.freeze({ phase: 'idle', error: '' })
const SELF_FLIGHT_ERROR = 'Research resource loader returned its own flight'

function errorMessage(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const message: unknown = reason.message
      return typeof message === 'string' && message !== '' ? message : 'Unknown error'
    }
    const message = String(reason)
    return message === '' ? 'Unknown error' : message
  } catch {
    return 'Unknown error'
  }
}

function serviceAsOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  for (const field of ['as_of', 'asOf'] as const) {
    try {
      const candidate = (value as Record<typeof field, unknown>)[field]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    } catch {
      // A hostile result object must not strand its resource flight.
    }
  }
  return undefined
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.max(1, Math.floor(limit))
}

/**
 * Keeps request results isolated by the caller's complete stable key for one
 * shell lifetime. Persistence belongs to the backend; this store never writes
 * browser storage.
 */
export function createResearchResourceStore(limit = DEFAULT_LIMIT): ResearchResourceStore {
  const capacity = normalizeLimit(limit)
  const entries = new Map<string, ResourceEntry>()
  const listeners = new Map<string, Set<() => void>>()
  const timers = new Map<string, Map<string, ReturnType<typeof globalThis.setTimeout>>>()
  let access = 0

  const touch = (entry: ResourceEntry): void => {
    access += 1
    entry.lastUsed = access
  }

  const entryFor = (key: string): ResourceEntry => {
    const current = entries.get(key)
    if (current !== undefined) {
      touch(current)
      return current
    }
    const created: ResourceEntry = {
      generation: 0,
      snapshot: IDLE_SNAPSHOT,
      hasValue: false,
      currentFlight: undefined,
      activeFlights: new Set(),
      lastUsed: 0,
    }
    touch(created)
    entries.set(key, created)
    return created
  }

  const trim = (): void => {
    while (entries.size > capacity) {
      let candidateKey: string | undefined
      let candidateAccess = Number.POSITIVE_INFINITY
      for (const [key, entry] of entries) {
        if (entry.activeFlights.size > 0 || entry.lastUsed >= candidateAccess) continue
        candidateKey = key
        candidateAccess = entry.lastUsed
      }
      if (candidateKey === undefined) return
      entries.delete(candidateKey)
    }
  }

  const publish = (
    key: string,
    entry: ResourceEntry,
    snapshot: ResearchResourceSnapshot<unknown>,
  ): void => {
    entry.snapshot = Object.freeze(snapshot)
    for (const listener of [...(listeners.get(key) ?? [])]) {
      try {
        listener()
      } catch (error) {
        console.error('[ui-investment-research] research resource subscriber threw:', error)
      }
    }
  }

  const retainedSnapshot = (
    entry: ResourceEntry,
    phase: 'refreshing' | 'stale',
    error: string,
  ): ResearchResourceSnapshot<unknown> => {
    const common = { phase, value: entry.snapshot.value, error }
    return entry.snapshot.asOf === undefined
      ? common
      : { ...common, asOf: entry.snapshot.asOf }
  }

  const getSnapshot = <T>(key: string): ResearchResourceSnapshot<T> => {
    const entry = entryFor(key)
    trim()
    return entry.snapshot as ResearchResourceSnapshot<T>
  }

  const peek = <T>(key: string): T | undefined => {
    const entry = entries.get(key)
    if (entry === undefined) return undefined
    touch(entry)
    return entry.hasValue ? entry.snapshot.value as T : undefined
  }

  const loadResource = <T>(
    key: string,
    load: () => Promise<T>,
    revalidate: boolean,
  ): Promise<T> => {
    const entry = entryFor(key)
    const current = entry.currentFlight
    if (current !== undefined && current.generation === entry.generation) {
      return current.promise as Promise<T>
    }
    if (!revalidate && entry.hasValue && entry.snapshot.phase === 'ready') {
      trim()
      return Promise.resolve(entry.snapshot.value as T)
    }

    const generation = entry.generation
    let resolveFlight!: (value: T) => void
    let rejectFlight!: (reason: unknown) => void
    const flight = new Promise<T>((resolve, reject) => {
      resolveFlight = resolve
      rejectFlight = reject
    })
    entry.currentFlight = { generation, promise: flight }
    entry.activeFlights.add(flight)
    trim()

    const cleanup = (): void => {
      entry.activeFlights.delete(flight)
      if (entry.currentFlight?.promise === flight) entry.currentFlight = undefined
      trim()
    }

    const settleValue = (value: T): void => {
      try {
        const isCurrent = entry.generation === generation
          && entry.currentFlight?.promise === flight
        if (isCurrent) {
          entry.hasValue = true
          const common = { phase: 'ready' as const, value, error: '' }
          const asOf = serviceAsOf(value) ?? entry.snapshot.asOf
          publish(key, entry, asOf === undefined ? common : { ...common, asOf })
        }
      } catch (error) {
        rejectFlight(error)
        return
      } finally {
        cleanup()
      }
      resolveFlight(value)
    }

    const settleError = (reason: unknown): void => {
      try {
        const isCurrent = entry.generation === generation
          && entry.currentFlight?.promise === flight
        if (isCurrent) {
          publish(key, entry, entry.hasValue
            ? retainedSnapshot(entry, 'stale', errorMessage(reason))
            : { phase: 'unavailable', error: errorMessage(reason) })
        }
      } catch (error) {
        rejectFlight(error)
        return
      } finally {
        cleanup()
      }
      rejectFlight(reason)
    }

    try {
      publish(key, entry, entry.hasValue
        ? retainedSnapshot(entry, 'refreshing', '')
        : { phase: 'preparing', error: '' })
      const loaded = load()
      if (loaded === flight) settleError(new Error(SELF_FLIGHT_ERROR))
      else Promise.resolve(loaded).then(settleValue, settleError)
    } catch (error) {
      settleError(error)
    }
    return flight
  }

  const read = <T>(key: string, load: () => Promise<T>): Promise<T> => (
    loadResource(key, load, false)
  )

  const revalidate = <T>(key: string, load: () => Promise<T>): Promise<T> => (
    loadResource(key, load, true)
  )

  const subscribe = (key: string, listener: () => void): (() => void) => {
    entryFor(key)
    let keyed = listeners.get(key)
    if (keyed === undefined) {
      keyed = new Set()
      listeners.set(key, keyed)
    }
    keyed.add(listener)
    trim()
    let closed = false
    return () => {
      if (closed) return
      closed = true
      keyed.delete(listener)
      if (keyed.size === 0 && listeners.get(key) === keyed) listeners.delete(key)
    }
  }

  const invalidate = (key: string): void => {
    const entry = entryFor(key)
    entry.generation += 1
    entry.currentFlight = undefined
    publish(key, entry, entry.hasValue
      ? retainedSnapshot(entry, 'stale', '')
      : { phase: 'idle', error: '' })
    trim()
  }

  const schedule = (
    owner: string,
    key: string,
    delayMs: number,
    callback: () => void,
  ): void => {
    let owned = timers.get(owner)
    if (owned === undefined) {
      owned = new Map()
      timers.set(owner, owned)
    }
    const existing = owned.get(key)
    if (existing !== undefined) globalThis.clearTimeout(existing)

    let handle!: ReturnType<typeof globalThis.setTimeout>
    handle = globalThis.setTimeout(() => {
      const current = timers.get(owner)
      if (current?.get(key) !== handle) return
      current.delete(key)
      if (current.size === 0) timers.delete(owner)
      callback()
    }, delayMs)
    owned.set(key, handle)
  }

  const clearTimers = (owner: string): void => {
    const owned = timers.get(owner)
    if (owned === undefined) return
    for (const handle of owned.values()) globalThis.clearTimeout(handle)
    timers.delete(owner)
  }

  return { getSnapshot, read, revalidate, peek, subscribe, invalidate, schedule, clearTimers }
}
