// trading-core 适配器 JSON 客户端（组合/策略，纯 Node fetch，与 dsh 解耦可独立测试）
//
// 任务型工具（analyze_stock/analyze_holdings/brief/backtest/strategy_run/shadow_run）：
//   POST /… → {task_id} → 轮询 GET /analyze/{task_id}（pending/running/done/failed）
//   → done 后 GET /analyze/{task_id}/result 拿最终结果。轮询有上限，超时返回
//   {status:'running', note} 让对话侧能追问（配合 tc_task_status 续查）。
//
// 同步工具：GET/POST 直连，秒级返回。
//
// 注意：返回对象里的嵌套字段用 JsonValue / type 别名（可选标量），不能是 interface
// 或 Record<string, unknown>[]，否则 defineTool 的 execute 返回类型推导会报不兼容。

import type { JsonValue } from '@deepseek-ai/dsh-session'

export async function httpJson<T = unknown>(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) {
    throw new Error(`适配器 HTTP ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

// ---- 任务型：启动 + 轮询 --------------------------------------------------

export type TaskEnvelope = {
  task_id: string
  status: string // pending | running | done | failed
  result?: JsonValue
  error?: string
  note?: string
}

/** 轮询直到 done/failed，超时返回 running 信封（可拿 task_id 续查）。 */
export async function pollTask(
  baseUrl: string,
  taskId: string,
  opts: { maxPollMs?: number; intervalMs?: number } = {},
): Promise<TaskEnvelope> {
  const maxPollMs = opts.maxPollMs ?? 180_000
  const intervalMs = opts.intervalMs ?? 3_000
  const deadline = Date.now() + maxPollMs
  for (;;) {
    const st = await taskStatus(baseUrl, taskId)
    if (st.status === 'done') {
      const result = await taskResult(baseUrl, taskId)
      return { task_id: taskId, status: 'done', result }
    }
    if (st.status === 'failed') {
      return { task_id: taskId, status: 'failed', error: st.error ?? '任务失败' }
    }
    if (Date.now() >= deadline) {
      return {
        task_id: taskId,
        status: 'running',
        note: `任务仍在运行（已轮询 ${Math.round(maxPollMs / 1000)}s），可用 tc_task_status 传入 task_id=${taskId} 续查`,
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function startAnalyze(
  baseUrl: string,
  body: { ticker: string; date?: string; market?: string; research_depth?: string; risk_profile?: string },
): Promise<{ task_id: string }> {
  return httpJson(baseUrl, '/analyze', 'POST', body)
}

export function startHoldingsAnalyze(
  baseUrl: string,
  body: { holdings?: Array<{ ticker: string; quantity: number; cost_price: number }>; mode?: string; use_saved?: boolean; risk_profile?: string },
): Promise<{ task_id: string }> {
  return httpJson(baseUrl, '/holdings/analyze', 'POST', body)
}

export function startBrief(
  baseUrl: string,
  body: { period?: string; scope?: string; tickers?: string[]; risk_profile?: string },
): Promise<{ task_id: string }> {
  return httpJson(baseUrl, '/brief', 'POST', body)
}

export function startBacktest(
  baseUrl: string,
  body: { code?: string; force?: boolean; eval_window_days?: number; min_age_days?: number; limit?: number; stop_loss_pct?: number; take_profit_pct?: number; neutral_band_pct?: number },
): Promise<{ task_id: string }> {
  return httpJson(baseUrl, '/backtest/run', 'POST', body)
}

export function startStrategyRun(
  baseUrl: string,
  body: { strategy_id: string; lookback_years?: number; oos_frac?: number; initial_capital?: number; min_oos_trades?: number },
): Promise<{ task_id: string }> {
  return httpJson(baseUrl, '/strategies/run', 'POST', body)
}

export function startShadowRun(
  baseUrl: string,
  body: { force?: boolean; strategy_id?: string },
): Promise<{ task_id: string }> {
  return httpJson(baseUrl, '/shadow/run', 'POST', body)
}

export function taskStatus(
  baseUrl: string,
  taskId: string,
): Promise<{ task_id: string; task_type?: string; status: string; error?: string }> {
  return httpJson(baseUrl, `/analyze/${encodeURIComponent(taskId)}`)
}

export function taskResult(baseUrl: string, taskId: string): Promise<JsonValue> {
  return httpJson(baseUrl, `/analyze/${encodeURIComponent(taskId)}/result`)
}

// ---- 同步：自选 / 持仓 ----------------------------------------------------

export function getWatchlist(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/watchlist')
}

export function setWatchlist(baseUrl: string, tickers: string[]): Promise<{ saved: number }> {
  return httpJson(baseUrl, '/watchlist', 'POST', { tickers })
}

export function getHoldings(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/holdings')
}

export function saveHoldings(
  baseUrl: string,
  holdings: Array<{ ticker: string; quantity: number; cost_price: number }>,
): Promise<{ saved: number }> {
  return httpJson(baseUrl, '/holdings/save', 'POST', { holdings })
}

// ---- 同步：策略 / 影子 / 风险 / 卡片 / 进化 --------------------------------

export function listStrategies(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/strategies')
}

export function shadowStatus(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/shadow/status')
}

export function riskAlerts(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/risk/alerts')
}

export function newsCards(baseUrl: string, limit?: number): Promise<Record<string, unknown>> {
  const qs = limit !== undefined ? `?limit=${limit}` : ''
  return httpJson(baseUrl, `/personalized/cards${qs}`)
}

export function personalizedProfile(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/personalized/profile')
}

export function evolutionStatus(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/evolution/status')
}

export function evolutionAttribution(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/evolution/attribution')
}

export function latestBrief(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/brief/latest')
}

export function riskProfile(baseUrl: string): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, '/risk_profile')
}
