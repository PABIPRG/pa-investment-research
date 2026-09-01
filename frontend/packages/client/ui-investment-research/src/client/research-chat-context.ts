import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'

export interface ResearchChatInstrument {
  readonly code: string
  readonly name: string
  readonly market: string
  readonly type: 'stock' | 'etf'
}

export interface ResearchChatContextTarget {
  readonly strategy_id: string | null
  readonly instrument: ResearchChatInstrument | null
}

export interface ResearchChatContext extends ResearchChatContextTarget {
  readonly schema_version: 1
  readonly session_id: string
  readonly revision: number
  readonly updated_at: string
}

export interface ResearchChatContextEntry {
  readonly phase: 'idle' | 'loading' | 'saving' | 'ready' | 'error'
  readonly confirmed: ResearchChatContext | null
  readonly revision: number
  readonly error: string
  readonly errorAction: 'load' | 'save' | 'conflict' | null
}

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface EntryStore {
  snapshot: ResearchChatContextEntry
  generation: number
  readonly listeners: Set<() => void>
}

const EMPTY_ENTRY: ResearchChatContextEntry = Object.freeze({
  phase: 'idle', confirmed: null, revision: 0, error: '', errorAction: null,
})

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseInstrument(value: unknown): ResearchChatInstrument | null {
  if (value === null) return null
  const item = record(value)
  if (item === undefined
    || typeof item.code !== 'string'
    || typeof item.name !== 'string'
    || typeof item.market !== 'string'
    || (item.type !== 'stock' && item.type !== 'etf')) {
    throw new TypeError('投研会话标的数据无效')
  }
  return { code: item.code, name: item.name, market: item.market, type: item.type }
}

function parseContext(value: unknown, expectedSessionId: string): ResearchChatContext {
  const item = record(value)
  if (item === undefined
    || item.schema_version !== 1
    || item.session_id !== expectedSessionId
    || !(item.strategy_id === null || typeof item.strategy_id === 'string')
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0
    || typeof item.updated_at !== 'string') {
    throw new TypeError('投研会话上下文数据无效')
  }
  return {
    schema_version: 1,
    session_id: expectedSessionId,
    strategy_id: item.strategy_id as string | null,
    instrument: parseInstrument(item.instrument),
    revision: Number(item.revision),
    updated_at: item.updated_at,
  }
}

function parseLoadResponse(value: unknown, sessionId: string): ResearchChatContext | null {
  const envelope = record(value)
  if (envelope?.exists === false && envelope.context === null) return null
  if (envelope?.exists !== true) throw new TypeError('投研会话上下文响应无效')
  return parseContext(envelope.context, sessionId)
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Browser-owned, session-isolated confirmation controller for composer selections. */
export class ResearchChatContextController {
  private readonly entries = new Map<string, EntryStore>()
  private disposed = false

  constructor(private readonly requestData: RequestData) {}

  private entry(sessionId: string): EntryStore {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = { snapshot: EMPTY_ENTRY, generation: 0, listeners: new Set() }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  private publish(entry: EntryStore, snapshot: ResearchChatContextEntry): void {
    if (this.disposed) return
    entry.snapshot = Object.freeze(snapshot)
    for (const listener of entry.listeners) listener()
  }

  snapshot(sessionId: string): ResearchChatContextEntry {
    return this.entry(sessionId).snapshot
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    if (this.disposed) return () => {}
    const entry = this.entry(sessionId)
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }

  async load(sessionId: string, options: { refresh?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    const entry = this.entry(sessionId)
    if (options.refresh !== true && entry.snapshot.phase === 'ready') return
    const generation = ++entry.generation
    this.publish(entry, { ...entry.snapshot, phase: 'loading', error: '', errorAction: null })
    try {
      const result = await this.requestData({
        operation: 'trading-core.research-chat-context', input: { session_id: sessionId },
      })
      if (this.disposed || generation !== entry.generation) return
      const confirmed = parseLoadResponse(result, sessionId)
      this.publish(entry, {
        phase: 'ready',
        confirmed,
        revision: confirmed?.revision ?? 0,
        error: '',
        errorAction: null,
      })
    } catch (reason) {
      if (this.disposed || generation !== entry.generation) return
      this.publish(entry, {
        ...entry.snapshot, phase: 'error', error: reasonText(reason), errorAction: 'load',
      })
      throw reason
    }
  }

  async save(sessionId: string, target: ResearchChatContextTarget): Promise<void> {
    if (this.disposed) return
    const entry = this.entry(sessionId)
    const generation = ++entry.generation
    const previous = entry.snapshot
    this.publish(entry, { ...previous, phase: 'saving', error: '', errorAction: null })
    try {
      const result = await this.requestData({
        operation: 'trading-core.research-chat-context-save',
        input: {
          session_id: sessionId,
          expected_revision: previous.revision,
          strategy_id: target.strategy_id,
          instrument: target.instrument === null ? null : {
            code: target.instrument.code,
            name: target.instrument.name,
            market: target.instrument.market,
            type: target.instrument.type,
          },
        },
      })
      if (this.disposed || generation !== entry.generation) return
      const confirmed = parseContext(result, sessionId)
      this.publish(entry, {
        phase: 'ready', confirmed, revision: confirmed.revision, error: '', errorAction: null,
      })
    } catch (reason) {
      if (this.disposed || generation !== entry.generation) return
      if (/HTTP 409|revision_conflict/u.test(reasonText(reason))) {
        await this.load(sessionId, { refresh: true })
        const refreshed = entry.snapshot
        this.publish(entry, {
          ...refreshed,
          phase: 'error',
          error: '该会话已在其他位置更新，请重新选择。',
          errorAction: 'conflict',
        })
        throw reason
      }
      this.publish(entry, {
        ...previous, phase: 'error', error: reasonText(reason), errorAction: 'save',
      })
      throw reason
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.generation += 1
      entry.listeners.clear()
    }
    this.entries.clear()
  }
}
