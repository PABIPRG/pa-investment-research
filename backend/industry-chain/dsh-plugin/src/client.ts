// industry-chain 适配器 JSON 客户端（全部只读 GET，秒级同步返回）
// 纯 Node fetch，与 dsh 解耦，可独立测试。返回类型与 index.ts 的 output.schema 对齐。
// 中文 keyword 由 URLSearchParams 自动 UTF-8 编码，避免 GBK 乱码。

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

// ---- 公司搜索 ------------------------------------------------------------

export function chainSearch(
  baseUrl: string,
  body: { keyword?: string; limit?: number },
  signal?: AbortSignal,
): Promise<{ items: Array<{ code: string; name: string; industry?: string; exchange?: string; is_subject?: boolean }>; count: number }> {
  const qs = new URLSearchParams()
  if (body.keyword) qs.set('keyword', body.keyword)
  if (body.limit !== undefined) qs.set('limit', String(body.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return httpJson(baseUrl, `/companies${suffix}`, 'GET', undefined, signal)
}

// ---- 公司档案 ------------------------------------------------------------

export function chainProfile(
  baseUrl: string,
  code: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, `/companies/${encodeURIComponent(code)}`, 'GET', undefined, signal)
}

// ---- 单公司 5 列产业链 ---------------------------------------------------

export function chainGraph(
  baseUrl: string,
  code: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return httpJson(baseUrl, `/graph/single/${encodeURIComponent(code)}`, 'GET', undefined, signal)
}

// ---- 产业链多层展开 ------------------------------------------------------

export interface ChainExpandInput {
  code: string
  depth_up?: number
  depth_down?: number
  top_up?: number
  top_down?: number
}

export function chainExpand(
  baseUrl: string,
  body: ChainExpandInput,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams()
  if (body.depth_up !== undefined) qs.set('depth_up', String(body.depth_up))
  if (body.depth_down !== undefined) qs.set('depth_down', String(body.depth_down))
  if (body.top_up !== undefined) qs.set('top_up', String(body.top_up))
  if (body.top_down !== undefined) qs.set('top_down', String(body.top_down))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return httpJson(baseUrl, `/graph/chain/${encodeURIComponent(body.code)}${suffix}`, 'GET', undefined, signal)
}
