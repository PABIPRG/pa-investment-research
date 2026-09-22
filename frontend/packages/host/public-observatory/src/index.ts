/** Login-free, exact-origin, read-only gateway for the public observatory. */

import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  assertTrustedAuthority,
  assertTrustedOrigin,
  assertTrustedProxyAddress,
  isTrustedPublicReadRequest,
  requestClientAddress,
  type BrowserTrustRequest,
} from '@deepseek-ai/dsh-host-webserver/request-trust'
import type {} from '@deepseek-ai/dsh-investment-python-runtime'
import z from '@deepseek-ai/schemastery'

export const name = 'host-public-observatory'
export const inject = ['webServer', 'investmentPythonRuntime']
export const PUBLIC_OBSERVATORY_PREFIX = '/api/public/performance/v1'

export interface PublicObservatoryConfig {
  enabled?: boolean
  allowedOrigins?: string[]
  trustedHosts?: string[]
  trustedProxyAddresses?: string[]
  timeoutMs?: number
  maxResponseBytes?: number
  requestsPerMinute?: number
  totalRequestsPerMinute?: number
  maxConcurrentRequests?: number
}

export const Config: z<PublicObservatoryConfig> = z.object({
  enabled: z.boolean().default(false),
  allowedOrigins: z.array(String).default([]),
  trustedHosts: z.array(String).default([]),
  trustedProxyAddresses: z.array(String).default([]),
  timeoutMs: z.natural().min(100).max(30_000).default(5_000),
  maxResponseBytes: z.natural().min(1_024).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
  requestsPerMinute: z.natural().min(1).max(10_000).default(120),
  totalRequestsPerMinute: z.natural().min(1).max(10_000).default(600),
  maxConcurrentRequests: z.natural().min(1).max(32).default(8),
})

type RunningEndpoint = Readonly<{
  baseUrl: string
}>

type RunningEndpointReader = (signal: AbortSignal) => Promise<RunningEndpoint>
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface ResolvedConfig {
  enabled: boolean
  allowedOrigins: readonly string[]
  trustedHosts: readonly string[]
  trustedProxyAddresses: readonly string[]
  timeoutMs: number
  maxResponseBytes: number
}

function jsonResponse(status: number, value: unknown, headers?: HeadersInit): Response {
  const result = new Headers(headers)
  result.set('content-type', 'application/json; charset=utf-8')
  result.set('x-content-type-options', 'nosniff')
  return new Response(JSON.stringify(value), {
    status,
    headers: result,
  })
}

function corsHeaders(origin: string | null, allowedOrigins: readonly string[]): Headers {
  const headers = new Headers({ vary: 'Origin' })
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers.set('access-control-allow-origin', origin)
  }
  return headers
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  origin: string | null,
  allowedOrigins: readonly string[],
): Response {
  const headers = corsHeaders(origin, allowedOrigins)
  headers.set('cache-control', 'no-store')
  return jsonResponse(status, { code, message }, headers)
}

function exactKeys(params: URLSearchParams, allowed: readonly string[]): boolean {
  const keys = [...params.keys()]
  if (new Set(keys).size !== keys.length) return false
  return keys.every(key => allowed.includes(key)) && allowed.every(key => params.has(key))
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTH = /^\d{4}-\d{2}$/
const SNAPSHOT_ID = /^[a-f0-9]{32}$/
const PUBLIC_ID = /^[a-f0-9]{24}$/
const CURSOR = /^[A-Za-z0-9_-]{1,128}$/

function validDate(value: string): boolean {
  if (!DATE.test(value) || value.startsWith('0000')) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

function backendTarget(requestUrl: URL): string | undefined {
  const path = requestUrl.pathname
  const params = requestUrl.searchParams
  if (path === `${PUBLIC_OBSERVATORY_PREFIX}/overview`) {
    return exactKeys(params, ['date']) && validDate(params.get('date') ?? '')
      ? `/public/performance/v1/overview?${params.toString()}` : undefined
  }
  if (path === `${PUBLIC_OBSERVATORY_PREFIX}/calendar`) {
    return exactKeys(params, ['month']) && MONTH.test(params.get('month') ?? '') && validDate(`${params.get('month')}-01`)
      ? `/public/performance/v1/calendar?${params.toString()}` : undefined
  }
  if (path === `${PUBLIC_OBSERVATORY_PREFIX}/equity`) {
    const from = params.get('from') ?? ''
    const to = params.get('to') ?? ''
    return exactKeys(params, ['from', 'to'])
      && validDate(from) && validDate(to) && from <= to && Date.parse(to) - Date.parse(from) < 366 * 86_400_000
      ? `/public/performance/v1/equity?${params.toString()}` : undefined
  }
  if (path === `${PUBLIC_OBSERVATORY_PREFIX}/holdings`) {
    return exactKeys(params, ['snapshot_id']) && SNAPSHOT_ID.test(params.get('snapshot_id') ?? '')
      ? `/public/performance/v1/holdings?${params.toString()}` : undefined
  }
  if (path === `${PUBLIC_OBSERVATORY_PREFIX}/activities`) {
    const allowed = ['as_of', 'category', 'status', 'cursor', 'limit']
    const keys = [...params.keys()]
    const category = params.get('category') ?? 'all'
    const status = params.get('status') ?? 'all'
    const cursor = params.get('cursor')
    const rawLimit = params.get('limit') ?? '20'
    const limit = Number(rawLimit)
    const valid = new Set(keys).size === keys.length && keys.every(key => allowed.includes(key))
      && params.has('as_of')
      && validDate(params.get('as_of') ?? '')
      && ['all', 'research', 'operation', 'system'].includes(category)
      && ['all', 'completed', 'failed'].includes(status)
      && (cursor === null || CURSOR.test(cursor))
      && /^\d+$/.test(rawLimit) && limit >= 1 && limit <= 50
    return valid ? `/public/performance/v1/activities?${params.toString()}` : undefined
  }
  const detail = new RegExp(`^${PUBLIC_OBSERVATORY_PREFIX}/activities/([a-f0-9]{24})$`).exec(path)
  if (detail !== null && PUBLIC_ID.test(detail[1] ?? '') && [...params.keys()].length === 0) {
    return `/public/performance/v1/activities/${detail[1]}`
  }
  return undefined
}

function isKnownPath(path: string): boolean {
  return path === `${PUBLIC_OBSERVATORY_PREFIX}/overview`
    || path === `${PUBLIC_OBSERVATORY_PREFIX}/calendar`
    || path === `${PUBLIC_OBSERVATORY_PREFIX}/equity`
    || path === `${PUBLIC_OBSERVATORY_PREFIX}/holdings`
    || path === `${PUBLIC_OBSERVATORY_PREFIX}/activities`
    || new RegExp(`^${PUBLIC_OBSERVATORY_PREFIX}/activities/[^/]+$`).test(path)
}

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

class ResponseTooLarge extends Error {}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maximum) {
    void response.body?.cancel().catch(() => {}) // Cancellation is best effort after rejecting the response.
    throw new ResponseTooLarge()
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await waitFor(reader.read(), signal)
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maximum) throw new ResponseTooLarge()
      chunks.push(chunk.value)
    }
    const body = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return body
  }
  catch (error) {
    void reader.cancel().catch(() => {}) // Do not let a broken upstream delay the public deadline.
    throw error
  }
  finally {
    reader.releaseLock()
  }
}

/** Pure request handler used by the Node carrier and focused security tests. */
export async function handlePublicObservatoryRequest(
  request: Request,
  facts: BrowserTrustRequest,
  config: ResolvedConfig,
  getRunningBackend: RunningEndpointReader,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  const origin = request.headers.get('origin')
  if (!config.enabled) {
    return errorResponse(404, 'not-found', '页面不存在。', origin, config.allowedOrigins)
  }
  if (!isKnownPath(new URL(request.url).pathname)) {
    return errorResponse(404, 'not-found', '页面不存在。', origin, config.allowedOrigins)
  }
  const method = request.method.toUpperCase()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return errorResponse(405, 'method-not-allowed', '该接口只允许读取。', origin, config.allowedOrigins)
  }
  if (!isTrustedPublicReadRequest(
    facts, config.trustedHosts, config.allowedOrigins, config.trustedProxyAddresses,
  )) {
    return errorResponse(403, 'request-untrusted', '请求来源不受信任。', origin, config.allowedOrigins)
  }
  if (method === 'OPTIONS') {
    const headers = corsHeaders(origin, config.allowedOrigins)
    headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS')
    headers.set('access-control-max-age', '600')
    return new Response(null, { status: 204, headers })
  }
  const target = backendTarget(new URL(request.url))
  if (target === undefined) {
    return errorResponse(422, 'invalid-query', '请求参数无效。', origin, config.allowedOrigins)
  }

  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('public request timed out')), config.timeoutMs)
  const signal = AbortSignal.any([request.signal, deadline.signal])
  try {
    signal.throwIfAborted()
    const endpoint = await waitFor(getRunningBackend(signal), signal)
    signal.throwIfAborted()
    const pending = fetchImpl(new URL(target, endpoint.baseUrl), {
      method: 'GET',
      signal,
      redirect: 'error',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    })
    void pending.then((response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => {})
    }, () => {}) // The awaited operation below owns fetch failures.
    const response = await waitFor(pending, signal)
    if (!response.ok) void response.body?.cancel().catch(() => {})
    if (response.status === 404) {
      return errorResponse(404, 'data-not-found', '指定的公开数据不存在。', origin, config.allowedOrigins)
    }
    if (response.status === 409) {
      return errorResponse(409, 'cursor-expired', '记录范围已更新，请重新读取。', origin, config.allowedOrigins)
    }
    if (response.status === 422) {
      return errorResponse(422, 'invalid-query', '请求参数无效。', origin, config.allowedOrigins)
    }
    if (!response.ok) {
      return errorResponse(503, 'temporarily-unavailable', '公开数据暂时不可用，请稍后重试。', origin, config.allowedOrigins)
    }
    const body = await readBounded(response, config.maxResponseBytes, signal)
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid upstream type')
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`
    const headers = corsHeaders(origin, config.allowedOrigins)
    headers.set('content-type', 'application/json; charset=utf-8')
    headers.set('cache-control', 'no-store')
    headers.set('x-content-type-options', 'nosniff')
    headers.set('etag', etag)
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(method === 'HEAD' ? null : body, { status: 200, headers })
  }
  catch (error) {
    return errorResponse(503, error instanceof ResponseTooLarge ? 'response-too-large' : 'temporarily-unavailable', '公开数据暂时不可用，请稍后重试。', origin, config.allowedOrigins)
  }
  finally {
    clearTimeout(timer)
  }
}

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result.set(name, value)
    else if (Array.isArray(value)) for (const item of value) result.append(name, item)
  }
  return result
}

async function sendResponse(res: ServerResponse, response: Response, timeoutMs: number): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  const body = response.body === null ? undefined : Buffer.from(await response.arrayBuffer())
  if (res.destroyed) return
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer)
      res.off('finish', done)
      res.off('close', done)
      res.off('error', done)
      resolve()
    }
    const timer = setTimeout(() => { res.destroy(); done() }, timeoutMs)
    res.once('finish', done)
    res.once('close', done)
    res.once('error', done)
    try {
      res.writeHead(response.status, headers)
      res.end(body)
    }
    catch (error) {
      reject(error)
      done()
    }
  })
}

class FixedWindowLimiter {
  private readonly clients = new Map<string, { startedAt: number; count: number }>()

  constructor(private readonly maximum: number) {}

  accept(client: string, now = Date.now()): boolean {
    const current = this.clients.get(client)
    if (current === undefined || now - current.startedAt >= 60_000) {
      this.clients.set(client, { startedAt: now, count: 1 })
      if (this.clients.size > 2_048) this.clients.delete(this.clients.keys().next().value as string)
      return true
    }
    current.count += 1
    return current.count <= this.maximum
  }
}

/** Register the exact public prefix without changing protected API routes. */
export function apply(ctx: Context, rawConfig?: PublicObservatoryConfig): void {
  rawConfig = Config(rawConfig ?? {})
  const config: ResolvedConfig = {
    enabled: rawConfig?.enabled ?? false,
    allowedOrigins: rawConfig?.allowedOrigins ?? [],
    trustedHosts: rawConfig?.trustedHosts ?? [],
    trustedProxyAddresses: rawConfig?.trustedProxyAddresses ?? [],
    timeoutMs: rawConfig?.timeoutMs ?? 5_000,
    maxResponseBytes: rawConfig?.maxResponseBytes ?? 2 * 1024 * 1024,
  }
  for (const origin of config.allowedOrigins) assertTrustedOrigin(origin)
  for (const authority of config.trustedHosts) assertTrustedAuthority(authority)
  for (const address of config.trustedProxyAddresses) assertTrustedProxyAddress(address)
  if (config.enabled && config.allowedOrigins.length === 0) {
    throw new Error('public-observatory: enabled mode requires at least one allowed origin')
  }
  const limiter = new FixedWindowLimiter(rawConfig?.requestsPerMinute ?? 120)
  const totalLimiter = new FixedWindowLimiter(rawConfig?.totalRequestsPerMinute ?? 600)
  const maxConcurrentRequests = rawConfig?.maxConcurrentRequests ?? 8
  let activeRequests = 0
  ctx.effect(() => {
    const lifetime = new AbortController()
    const unregister = ctx.webServer.register({
    kind: 'prefix',
    path: PUBLIC_OBSERVATORY_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const client = requestClientAddress(req, config.trustedProxyAddresses) ?? 'unknown'
      if (!totalLimiter.accept('all') || !limiter.accept(client) || activeRequests >= maxConcurrentRequests) {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
        const response = errorResponse(429, 'rate-limited', '请求过于频繁，请稍后重试。', origin, config.allowedOrigins)
        response.headers.set('retry-after', '60')
        await sendResponse(res, response, config.timeoutMs)
        return
      }
      activeRequests += 1
      const disconnected = new AbortController()
      const onClose = (): void => { if (!res.writableEnded) disconnected.abort() }
      req.once('aborted', onClose)
      res.once('close', onClose)
      try {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) {
          const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
          await sendResponse(res, errorResponse(405, 'method-not-allowed', '该接口只允许读取。', origin, config.allowedOrigins), config.timeoutMs)
          return
        }
        const headers = headersFromIncoming(req.headers)
        const request = new Request(new URL(req.url ?? '/', 'http://public-gateway.invalid'), {
          method: req.method ?? 'GET',
          headers,
          signal: AbortSignal.any([disconnected.signal, lifetime.signal]),
        })
        const response = await handlePublicObservatoryRequest(
          request, req, config,
          signal => ctx.investmentPythonRuntime.getRunningBackend('trading-core', signal),
        )
        if (!res.destroyed) await sendResponse(res, response, config.timeoutMs)
      }
      finally {
        req.off('aborted', onClose)
        res.off('close', onClose)
        activeRequests -= 1
      }
    },
    })
    return () => { lifetime.abort(); unregister() }
  }, 'host-public-observatory: public read routes')
}
