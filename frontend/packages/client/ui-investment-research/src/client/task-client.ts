import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, text } from './data.ts'
import type { JsonRecord } from './data.ts'

/** Request facade shared by product pages that launch and follow backend tasks. */
export type InvestmentTaskRequest = (request: InvestmentDataRequest) => Promise<unknown>

/** Sentinel returned when a page unmounts while a backend task is still running. */
export const TASK_CANCELLED = Symbol('task-polling-cancelled')

/** Extract the backend task identifier from a start response. */
export function taskId(value: unknown): string {
  return text(asRecord(value).task_id, '')
}

/** Poll one durable investment task until its result can be read or the caller leaves. */
export async function waitForTask(
  requestData: InvestmentTaskRequest,
  id: string,
  onProgress: (label: string) => void,
  isActive: () => boolean,
): Promise<JsonRecord | typeof TASK_CANCELLED> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (!isActive()) return TASK_CANCELLED
    const status = asRecord(await requestData({
      operation: 'trading-core.task-status', input: { task_id: id },
    }))
    if (!isActive()) return TASK_CANCELLED
    const phase = text(status.status, 'pending')
    onProgress(phase === 'pending' ? '等待执行…' : phase === 'running' ? '正在执行…' : '正在收尾…')
    if (phase === 'failed') throw new Error(text(status.error, '任务执行失败'))
    if (phase === 'done') {
      const result = asRecord(await requestData({ operation: 'trading-core.task-result', input: { task_id: id } }))
      return isActive() ? result : TASK_CANCELLED
    }
    await new Promise(resolve => window.setTimeout(resolve, 1_000))
  }
  throw new Error('任务仍在后台执行，请稍后在投研报告中查看结果。')
}
