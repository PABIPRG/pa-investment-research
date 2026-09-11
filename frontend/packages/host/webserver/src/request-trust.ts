import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'

export interface BrowserTrustRequest {
  headers: IncomingHttpHeaders | Headers | Record<string, string | undefined>
  method?: string | undefined
  socket?: { remoteAddress?: string | undefined }
}

/** Server-side transport resource whose lifetime can be bound to a Web session. */
export interface WebRequestLifecycleResource {
  destroy(): void
  once(event: 'close', listener: () => void): unknown
}

/** Structural authentication authority accepted by protected Web routes. */
export interface WebRequestAuthorizer {
  authorize(request: BrowserTrustRequest): WebRequestAuthorizationDecision
}

/** Stable allow/reject shape shared by protected static, SSE, and API routes. */
export type WebRequestAuthorizationDecision = {
  ok: true
  /** Bind a server-side transport to the authorized session without exposing its credential. */
  bindLifecycle?: (resource: WebRequestLifecycleResource) => boolean
} | {
  ok: false
  status: 401 | 403 | 429 | 503
  code: string
}

/** Normalized protected-route result; success always carries a lifecycle binder. */
export type ProtectedWebRequestAuthorizationDecision = {
  ok: true
  bindLifecycle: (resource: WebRequestLifecycleResource) => boolean
} | Exclude<WebRequestAuthorizationDecision, { ok: true }>

function header(headers: BrowserTrustRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}

function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part))
    && Number(octets[0]) === 127 && octets.every(part => Number(part) <= 255)
}

function normalizeIpAddress(address: string): string | undefined {
  const withoutZone = address.split('%', 1)[0] ?? address
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutZone)?.[1]
  const candidate = mapped ?? withoutZone
  const version = isIP(candidate)
  if (version === 0) return undefined
  if (version === 4) return candidate.split('.').map(part => String(Number(part))).join('.')
  try {
    return new URL(`http://[${candidate}]`).hostname.slice(1, -1).toLowerCase()
  } catch { return undefined }
}

/** Validate one exact reverse-proxy socket address. */
export function assertTrustedProxyAddress(address: string): void {
  if (normalizeIpAddress(address) === address.toLowerCase()) return
  throw new Error(`webserver: trusted proxy ${JSON.stringify(address)} is not a canonical IP address`)
}

function socketPeerAddress(request: BrowserTrustRequest): string | undefined {
  const address = request.socket?.remoteAddress
  return address === undefined ? undefined : normalizeIpAddress(address)
}

/** Resolve the client IP, stripping only explicitly trusted proxy hops from the right. */
export function requestClientAddress(
  request: BrowserTrustRequest,
  trustedProxyAddresses: readonly string[] = [],
): string | undefined {
  const peer = socketPeerAddress(request)
  if (peer === undefined) return undefined
  const trusted = new Set(trustedProxyAddresses.map(address => normalizeIpAddress(address)).filter(Boolean))
  if (!trusted.has(peer)) return peer
  const forwarded = header(request.headers, 'x-forwarded-for')
  if (forwarded === undefined) return undefined
  const chain = forwarded.split(',').map(value => normalizeIpAddress(value.trim()))
  if (chain.length === 0 || chain.some(address => address === undefined)) return undefined
  let index = chain.length - 1
  while (index >= 0) {
    const address = chain[index]
    if (address === undefined || !trusted.has(address)) break
    index -= 1
  }
  return index >= 0 ? chain[index] : undefined
}

/**
 * Whether the raw socket is a direct loopback client rather than a configured
 * proxy. Forwarded headers never grant local-machine privilege.
 */
export function isLoopbackRequestPeer(
  request: BrowserTrustRequest,
  trustedProxyAddresses: readonly string[] = [],
): boolean {
  const peer = socketPeerAddress(request)
  return peer !== undefined && isLoopbackHostname(peer)
    && !trustedProxyAddresses.some(address => normalizeIpAddress(address) === peer)
}

/** Accept HTTPS forwarding only from an explicitly trusted direct proxy. */
export function isTrustedForwardedHttps(
  request: BrowserTrustRequest,
  trustedProxyAddresses: readonly string[],
): boolean {
  const peer = socketPeerAddress(request)
  if (peer === undefined || !trustedProxyAddresses.some(address => normalizeIpAddress(address) === peer)) return false
  return requestClientAddress(request, trustedProxyAddresses) !== undefined
    && header(request.headers, 'x-forwarded-proto')?.toLowerCase() === 'https'
}

/** Validate a deployment trust entry before it can authorize an HTTP authority. */
export function assertTrustedAuthority(entry: string): void {
  const parsed = parseAuthority(entry)
  if (parsed !== undefined && canonicalAuthority(entry, parsed) === entry.toLowerCase()) return
  throw new Error(`client-connection: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const parsed = parseAuthority(entry)
    if (parsed === undefined) return false
    return canonicalAuthority(entry, parsed) === parsed.hostname
      ? parsed.hostname === hostUrl.hostname
      : parsed.host === hostUrl.host
  })
}

/** Enforce Host, Fetch-Metadata, and same-origin browser request trust. */
export function isTrustedApiRequest(
  request: BrowserTrustRequest,
  trustedHosts: readonly string[],
  trustedProxyAddresses: readonly string[] = [],
): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const loopbackAuthority = isLoopbackHostname(hostUrl.hostname)
  const hostAccepted = loopbackAuthority
    ? isLoopbackRequestPeer(request, trustedProxyAddresses)
    : isTrustedAuthority(hostUrl, trustedHosts)
  if (!hostAccepted) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    const originUrl = new URL(origin)
    if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.host !== hostUrl.host) return false
    return loopbackAuthority || !isTrustedForwardedHttps(request, trustedProxyAddresses)
      || originUrl.protocol === 'https:'
  } catch { return false }
}

/** Apply shared browser request trust and an optional/required auth authority. */
export function authorizeProtectedWebRequest(
  request: BrowserTrustRequest,
  trustedHosts: readonly string[],
  trustedProxyAddresses: readonly string[],
  authorizer: WebRequestAuthorizer | undefined,
  requireAuthorizer: boolean,
): ProtectedWebRequestAuthorizationDecision {
  if (!isTrustedApiRequest(request, trustedHosts, trustedProxyAddresses)) {
    return { ok: false, status: 403, code: 'request-untrusted' }
  }
  if (authorizer === undefined) {
    return requireAuthorizer
      ? { ok: false, status: 503, code: 'auth-unavailable' }
      : { ok: true, bindLifecycle: () => true }
  }
  const decision = authorizer.authorize(request)
  if (!decision.ok) return decision
  // A legacy/custom authority that cannot bind a long-lived resource may
  // authorize ordinary finite requests, but an SSE/WebSocket carrier can
  // fail closed by observing the false lifecycle result.
  return { ok: true, bindLifecycle: decision.bindLifecycle ?? (() => false) }
}
