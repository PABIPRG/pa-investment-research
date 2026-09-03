import type { AnalysisPromptTemplateId } from './analysis-modules.ts'

export interface AnalysisPromptTemplateSnapshot {
  readonly templateId: AnalysisPromptTemplateId
  /** Exact text last inserted automatically; used to avoid overwriting an edited draft. */
  readonly automaticPrompt?: string
}

const GENERAL_TEMPLATE: AnalysisPromptTemplateSnapshot = Object.freeze({ templateId: 'general' })

/** Profile-local, session-scoped selection state for Smart Analysis prompt templates. */
export class AnalysisPromptTemplateController {
  private readonly entries = new Map<string, AnalysisPromptTemplateSnapshot>()
  private readonly listeners = new Map<string, Set<() => void>>()

  snapshot(sessionId: string): AnalysisPromptTemplateSnapshot {
    return this.entries.get(sessionId) ?? GENERAL_TEMPLATE
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  set(
    sessionId: string,
    templateId: AnalysisPromptTemplateId,
    automaticPrompt?: string,
  ): void {
    const previous = this.snapshot(sessionId)
    const next: AnalysisPromptTemplateSnapshot = automaticPrompt === undefined || automaticPrompt === ''
      ? Object.freeze({ templateId })
      : Object.freeze({ templateId, automaticPrompt })
    if (previous.templateId === next.templateId
      && previous.automaticPrompt === next.automaticPrompt) return
    this.entries.set(sessionId, next)
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener()
  }

  delete(sessionId: string): void {
    if (!this.entries.delete(sessionId)) return
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener()
  }

  dispose(): void {
    this.entries.clear()
    this.listeners.clear()
  }
}
