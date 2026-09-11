import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'

export interface BrowserTrustRequest {
  headers: IncomingHttpHeaders | Headers | Record<string, string | undefined>
  socket?: { remoteAddress?: string | undefined }
}

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

/** Whether the effective client, after trusted-proxy resolution, is loopback. */
export function isLoopbackRequestPeer(
  request: BrowserTrustRequest,
  trustedProxyAddresses: readonly string[] = [],
): boolean {
  const address = requestClientAddress(request, trustedProxyAddresses)
  return address !== undefined && isLoopbackHostname(address)
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
  const hostAccepted = isLoopbackHostname(hostUrl.hostname)
    ? isLoopbackRequestPeer(request, trustedProxyAddresses)
    : isTrustedAuthority(hostUrl, trustedHosts)
  if (!hostAccepted) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}
