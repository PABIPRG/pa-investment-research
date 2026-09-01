import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'

export interface ResearchSubject {
  readonly code: string
  readonly name?: string
  readonly quote?: {
    readonly price?: number
    readonly pctChange?: number
    readonly volumeRatio?: number
    readonly amountYi?: number
  }
}

export type ResearchSurfaceMode = 'closed' | 'minimized' | 'docked' | 'expanded'

export type RequestData = (request: InvestmentDataRequest) => Promise<unknown>
