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

/** One decoded SSE frame; omitted fields were absent from the wire frame. */
export interface SseFrame {
  event?: string
  data?: string
}

/**
 * Start an adapter task and require its opaque task identifier.
 * @param baseUrl - Adapter origin without a trailing route.
 * @param path - Task-start route beginning with `/`.
 * @param body - JSON request passed to the selected task endpoint.
 * @param signal - Caller-owned cancellation signal for the POST.
 * @returns The task identifier used to construct the SSE route.
 * @throws Rejects on fetch failure, a non-success response, or a response without `task_id`.
 */
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

/**
 * Start the stock-analysis task used by `analyze_stock`.
 * @param baseUrl - Adapter origin.
 * @param body - Lossless stock-analysis request fields.
 * @param signal - Caller-owned cancellation signal for the POST.
 * @returns The task identifier used to consume analysis progress.
 * @throws Propagates adapter task-start failures from {@link startTask}.
 */
export function startAnalysis(
  baseUrl: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  return startTask(baseUrl, '/analyze', body, signal)
}

/**
 * Send one lightweight JSON request to the stock-analysis adapter.
 * @param baseUrl - Adapter origin without a trailing route.
 * @param path - Absolute adapter route beginning with `/`.
 * @param method - HTTP method for the request.
 * @param body - Optional JSON object serialized as the request body.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's decoded JSON response without lossy projection.
 * @throws Rejects when request serialization, fetch, JSON decoding, or a non-success response fails.
 */
export async function httpJson(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  if (signal !== undefined) init.signal = signal
  const res = await fetch(`${baseUrl}${path}`, init)
  if (!res.ok) {
    throw new Error(`适配器 HTTP ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as unknown
}

/**
 * Read the adapter-owned stock-analysis watchlist.
 * @param baseUrl - Adapter origin.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless watchlist response.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function getWatchlist(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  return httpJson(baseUrl, '/watchlist', 'GET', undefined, signal)
}

/**
 * Replace the adapter-owned stock-analysis watchlist.
 * @param baseUrl - Adapter origin.
 * @param tickers - Complete ticker list to persist.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless save response.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function setWatchlist(
  baseUrl: string,
  tickers: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  return httpJson(baseUrl, '/watchlist', 'POST', { tickers }, signal)
}

/**
 * Read the latest generated brief and its in-chat delivery marker.
 * @param baseUrl - Adapter origin.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless latest-brief response.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function getLatestBrief(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  return httpJson(baseUrl, '/brief/latest', 'GET', undefined, signal)
}

/**
 * Read the adapter-owned global risk profile.
 * @param baseUrl - Adapter origin.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless risk-profile response.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function getRiskProfile(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  return httpJson(baseUrl, '/risk_profile', 'GET', undefined, signal)
}

/**
 * Replace the adapter-owned global risk profile.
 * @param baseUrl - Adapter origin.
 * @param riskProfile - Profile key accepted by the adapter.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless save response.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function setRiskProfile(
  baseUrl: string,
  riskProfile: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return httpJson(baseUrl, '/risk_profile', 'POST', { risk_profile: riskProfile }, signal)
}

/** One persisted position supplied to holdings analysis. */
export interface HoldingInput {
  ticker: string
  quantity: number
  cost_price: number
}

/**
 * Replace the adapter-owned holdings collection.
 * @param baseUrl - Adapter origin.
 * @param holdings - Complete position list to persist.
 * @param signal - Optional caller-owned cancellation signal.
 * @returns The adapter's lossless save response.
 * @throws Propagates adapter request failures from {@link httpJson}.
 */
export function saveHoldings(
  baseUrl: string,
  holdings: HoldingInput[],
  signal?: AbortSignal,
): Promise<unknown> {
  return httpJson(baseUrl, '/holdings/save', 'POST', { holdings }, signal)
}

/**
 * Decode CRLF or LF-delimited SSE bytes into event/data frames.
 * @param stream - Caller-supplied response body; its reader lock is released when iteration ends.
 * @returns Frames in wire order, including a final unterminated frame.
 * @throws Propagates stream read failures after releasing the reader lock.
 */
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
  return {
    ...(event === undefined ? {} : { event }),
    ...(data === undefined ? {} : { data }),
  }
}

/**
 * Consume one task's SSE stream, inject progress, and return its final result.
 * @param url - Complete SSE endpoint URL.
 * @param sink - Cancellation signal and optional progress-injection target.
 * @param timeoutMs - Upper bound applied alongside caller cancellation.
 * @param onStage - Optional observer called before each stage is injected.
 * @returns The decoded payload from the last valid `result` frame.
 * @throws Rejects on cancellation, timeout, HTTP failure, an `error` frame, or a stream without a result.
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

/**
 * Append adapter progress to the current model context without waking the agent.
 * @param sink - Optional agent injection target.
 * @param message - Progress text attributed to the stock-analysis plugin.
 * Injection failures are contained so progress reporting cannot fail the tool call.
 */
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
