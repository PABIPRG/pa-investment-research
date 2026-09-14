/** Bounded public-HTTPS discovery for remote model administrators. */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request } from 'node:https'
import type { DiscoveredModelView } from './api/llm.ts'

const denied = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) denied.addSubnet(address, prefix)
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
denied.addSubnet('2001::', 23, 'ipv6')
denied.addSubnet('2001:db8::', 32, 'ipv6')
denied.addSubnet('192.88.99.0', 24)
denied.addSubnet('2002::', 16, 'ipv6')
denied.addSubnet('3fff::', 20, 'ipv6')

/** Whether an address may be contacted by remote discovery.
 * @param address - A resolved numeric IPv4 or IPv6 address.
 * @returns Whether the address is public unicast.
 */
export function isPublicModelAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !denied.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6')
}

/** Parse an HTTPS endpoint without URL credentials, query, or fragment. DNS is checked at connection time.
 * @param value - Draft endpoint supplied by the administrator.
 * @returns The parsed endpoint.
 */
export function modelEndpoint(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('云端模型端点必须使用不含账号、查询参数或片段的 HTTPS 地址')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicModelAddress(host))) throw new Error('云端模型端点不允许访问本机或内网地址')
  return url
}

/** Discover models without ambient credentials, redirects, DNS rebinding, or unbounded replies.
 * @param baseURL - Public HTTPS provider prefix.
 * @param apiKey - Explicit draft key, never resolved from storage.
 * @param signal - Optional caller cancellation.
 * @returns Candidate model identifiers and names.
 */
export async function discoverPublicModels(baseURL: string, apiKey: string | undefined, signal?: AbortSignal): Promise<DiscoveredModelView[]> {
  const url = modelEndpoint(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`
  const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...signal ? [signal] : []])
  deadline.throwIfAborted()
  const addresses = await Promise.race([
    lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }),
    new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error('模型发现超时或已取消')), { once: true })),
  ])
  if (addresses.length === 0 || addresses.some(entry => !isPublicModelAddress(entry.address))) throw new Error('云端模型端点不允许访问本机或内网地址')
  const selected = addresses[0]!
  const text = await new Promise<string>((resolve, reject) => {
    const req = request(url, {
      signal: deadline,
      // Pin the socket to the validated lookup; TLS still checks the original hostname.
      lookup: (_host, _options, callback) => callback(null, _options.all ? [selected] as never : selected.address, selected.family),
      family: selected.family,
      headers: { accept: 'application/json', ...apiKey ? { authorization: `Bearer ${apiKey}` } : {} },
    }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error('模型端点未返回成功响应；请检查地址及密钥（不允许重定向）')); return }
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 4 * 1024 * 1024) { res.destroy(); reject(new Error('模型列表响应过大')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', () => reject(new Error('模型列表读取失败')))
    })
    req.on('error', () => reject(new Error('模型端点连接失败或超时')))
    req.end()
  })
  const data: unknown = (JSON.parse(text) as { data?: unknown }).data
  if (!Array.isArray(data)) throw new Error('模型端点没有返回模型列表，请手动添加')
  return data.slice(0, 1000).flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    return typeof row['id'] === 'string' && row['id'].length > 0 ? [{ id: row['id'], ...typeof row['name'] === 'string' ? { name: row['name'] } : {} }] : []
  })
}
