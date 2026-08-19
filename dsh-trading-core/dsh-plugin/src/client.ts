// 适配器 HTTP + SSE 客户端（与 dsh 解耦，纯 Node，可独立测试）
//
// 消费适配器 SSE：stage → 进度回调；result → 最终 Signal+报告。
// 事件序列：stage* → result → done（失败为 error → done）。

import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'

/** 进度注入目标（dsh 的 ToolRunContext 的最小切片，便于独立测试）。 */
export interface ProgressSink {
  signal: AbortSignal
  agent?: { inject?(message: UserMessage): void }
}

export interface SseFrame {
  event?: string
  data?: string
}

/** 通用任务启动：POST 到任意任务端点（/analyze /holdings/analyze /brief），返回 task_id。 */
export async function startTask(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    throw new Error(`适配器 HTTP ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as { task_id?: string }
  if (!json.task_id) {
    throw new Error(`适配器未返回 task_id: ${JSON.stringify(json)}`)
  }
  return json.task_id
}

/** 股票分析（analyze_stock 工具用，向后兼容）。 */
export function startAnalysis(
  baseUrl: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  return startTask(baseUrl, '/analyze', body, signal)
}

/** 通用 JSON 请求（自选/简报读取等轻量接口）。 */
export async function httpJson(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) {
    throw new Error(`适配器 HTTP ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as unknown
}

export function getWatchlist(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  return httpJson(baseUrl, '/watchlist', 'GET', undefined, signal)
}

export function setWatchlist(
  baseUrl: string,
  tickers: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  return httpJson(baseUrl, '/watchlist', 'POST', { tickers }, signal)
}

export function getLatestBrief(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  return httpJson(baseUrl, '/brief/latest', 'GET', undefined, signal)
}

export function getRiskProfile(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  return httpJson(baseUrl, '/risk_profile', 'GET', undefined, signal)
}

export function setRiskProfile(
  baseUrl: string,
  riskProfile: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return httpJson(baseUrl, '/risk_profile', 'POST', { risk_profile: riskProfile }, signal)
}

export interface HoldingInput {
  ticker: string
  quantity: number
  cost_price: number
}

export function saveHoldings(
  baseUrl: string,
  holdings: HoldingInput[],
  signal?: AbortSignal,
): Promise<unknown> {
  return httpJson(baseUrl, '/holdings/save', 'POST', { holdings }, signal)
}

/** 极简 SSE 解析：把 ReadableStream 拆成 event/data 帧（兼容 CRLF/LF）。 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // sse-starlette 用 \r\n\r\n 分隔，统一归一化为 \n
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        yield parseFrame(frame)
      }
    }
    // 冲刷流末尾残留的最后一帧（result/done 常落在末尾）
    if (buffer.trim()) {
      yield parseFrame(buffer)
    }
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(raw: string): SseFrame {
  let event: string | undefined
  let data: string | undefined
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data = line.slice(5).trim()
    // 忽略注释（心跳 ping）与未知字段
  }
  return { event, data }
}

/**
 * 消费 SSE 进度流。
 * @param onStage 每个 stage 事件回调（进度消息字符串）
 * @returns 最终 result 载荷
 */
export async function consumeSse(
  url: string,
  sink: ProgressSink,
  timeoutMs: number,
  onStage?: (message: string) => void,
): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.any([sink.signal, AbortSignal.timeout(timeoutMs)]),
  })
  if (!res.ok || !res.body) {
    throw new Error(`适配器 SSE HTTP ${res.status}`)
  }

  let final: unknown
  for await (const frame of parseSse(res.body)) {
    if (frame.event === 'stage') {
      let msg: string | undefined
      try {
        msg = (JSON.parse(frame.data ?? '{}') as { message?: string }).message
      } catch {
        msg = frame.data
      }
      if (msg) {
        if (onStage) onStage(msg)
        injectProgress(sink, msg)
      }
    } else if (frame.event === 'result') {
      try {
        final = JSON.parse(frame.data ?? '{}')
      } catch {
        /* 忽略坏帧 */
      }
    } else if (frame.event === 'error') {
      const msg = (() => {
        try {
          return (JSON.parse(frame.data ?? '{}') as { message?: string }).message
        } catch {
          return frame.data
        }
      })()
      throw new Error(`分析失败：${msg ?? '未知错误'}`)
    } else if (frame.event === 'done') {
      break
    }
  }
  if (!final) {
    throw new Error('适配器 SSE 流结束但未收到 result')
  }
  return final
}

/** 把引擎进度追加到模型上下文（非唤醒；失败不打断分析）。 */
export function injectProgress(sink: ProgressSink, message: string): void {
  try {
    const msg: UserMessage = createUserMessage({
      content: [{ type: 'text', text: message }] satisfies ContentBlock[],
      source: { kind: 'plugin', plugin: 'stock-analysis' },
    })
    sink.agent?.inject?.(msg)
  } catch {
    /* 进度注入失败不影响工具结果 */
  }
}
