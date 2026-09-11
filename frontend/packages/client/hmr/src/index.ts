/**
 * HMR plugin, node half: the host end of the dev reload chain. One interval
 * stat-polls every graph row's client bundle (polling by design: network
 * mounts deliver no inotify events), reports content changes through
 * `clientModuleHost.rebuilt(id)`, and serves the `/plugins/events` SSE channel
 * broadcasting graph/rebuilt frames to the browser half (src/client/).
 * The web bundle mounts this row unconditionally: without a rebuild
 * watcher rewriting client bundles, the poll observes no changes and the
 * chain stays idle.
 */
import { statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  authorizeProtectedWebRequest,
  assertTrustedAuthority,
  assertTrustedProxyAddress,
  type WebRequestAuthorizer,
  type WebRequestLifecycleResource,
} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
// Empty type imports carry the clientModuleHost/webServer Context merges.
import type {} from '@deepseek-ai/dsh-client-modules'
import type { PluginsEventFrame } from './events.ts'
import { EVENTS_ENDPOINT } from './events.ts'

export type { PluginsEventFrame } from './events.ts'
export { EVENTS_ENDPOINT } from './events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the web plugin table and the route registry. */
export const inject = ['clientModules', 'webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
  /** Exact public authorities accepted by the shared browser request trust fence. */
  trustedHosts?: string[]
  /** Direct proxy socket addresses allowed to supply forwarded client and transport facts. */
  trustedProxyAddresses?: string[]
  /** Fail closed when the composing Web product expects the WebAuth service. */
  requireWebAuth?: boolean
  /** Maximum number of simultaneously open HMR event streams. */
  maxSseConnections?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
  trustedHosts: z.array(String).default([]),
  trustedProxyAddresses: z.array(String).default([]),
  requireWebAuth: z.boolean().default(false),
  maxSseConnections: z.natural().min(1).max(1_024).default(64),
})

/** Serialize one frame as an SSE data line. */
function sseData(frame: PluginsEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

interface WatchedBundle {
  path: string
  mtimeMs: number
  size: number
  dirty: boolean
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  'connection': 'keep-alive',
  'x-content-type-options': 'nosniff',
} as const

function writeJsonError(res: ServerResponse, status: number, code: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(JSON.stringify({ code }))
}

/**
 * Mount the dev chain: bundle watches, rebuilt reporting, and the SSE channel.
 * @param ctx - host plugin context carrying clientModuleHost and webServer.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field is set after validation.
  const pollIntervalMs = config.pollIntervalMs as number
  const trustedHosts = config.trustedHosts ?? []
  const trustedProxyAddresses = config.trustedProxyAddresses ?? []
  const requireWebAuth = config.requireWebAuth ?? false
  const maxSseConnections = config.maxSseConnections ?? 64
  for (const authority of trustedHosts) assertTrustedAuthority(authority)
  for (const address of trustedProxyAddresses) assertTrustedProxyAddress(address)

  // --- bundle watch: one HMR-owned stat poll ------------------------------
  const watched = new Map<string, WatchedBundle>()

  const rehash = (id: string, watch: WatchedBundle, current: { mtimeMs: number; size: number }): void => {
    try {
      // rebuilt() re-hashes; an unchanged hash stays silent (clientModuleHost
      // fires onRebuilt only on a real rev change).
      ctx.clientModules.rebuilt(id)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        watch.dirty = true
        return
      }
      ctx.logger.warn(error)
    }
    watch.mtimeMs = current.mtimeMs
    watch.size = current.size
    watch.dirty = false
  }

  const watchRow = (id: string, path: string): void => {
    let baseline: { mtimeMs: number; size: number }
    try {
      baseline = statSync(path)
    } catch (error) {
      watched.set(id, { path, mtimeMs: 0, size: 0, dirty: true })
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
      return
    }
    const watch = { path, mtimeMs: baseline.mtimeMs, size: baseline.size, dirty: false }
    watched.set(id, watch)
    // The module host hashed before publishing the graph. Re-hash immediately
    // after capturing this baseline so a write in between cannot become an
    // already-current baseline paired with a stale graph rev.
    rehash(id, watch, baseline)
  }

  const pollWatches = (): void => {
    for (const [id, watch] of watched) {
      let current: { mtimeMs: number; size: number }
      try {
        current = statSync(watch.path)
      } catch (error) {
        watch.dirty = true
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
        continue
      }
      if (!watch.dirty && current.mtimeMs === watch.mtimeMs && current.size === watch.size) continue
      // Stat-before-hash preserves a detectable older baseline for writes that
      // land during hashing. Repeated stat changes heal a torn read.
      rehash(id, watch, current)
    }
  }

  // Diff the watch set against the current graph: drop watches for removed
  // rows (or rows whose bundle path moved), add watches for new rows.
  const syncWatches = (): void => {
    const rows = new Map<string, string>()
    for (const row of ctx.clientModules.graph().entries) {
      const path = ctx.clientModules.clientPath(row.id)
      if (path !== undefined) rows.set(row.id, path)
    }
    for (const [id, watch] of watched) {
      if (rows.get(id) === watch.path) continue
      watched.delete(id)
    }
    for (const [id, path] of rows) {
      if (!watched.has(id)) watchRow(id, path)
    }
  }

  ctx.effect(() => {
    // Initial sync covers rows already in the graph; the subscription covers
    // rows arriving later (boot-window activations, including this plugin's
    // own row — no self-exemption, a modules/hmr rebuild rides the same chain).
    syncWatches()
    const unsubscribe = ctx.clientModules.onGraphChanged(syncWatches)
    const timer = setInterval(pollWatches, pollIntervalMs)
    timer.unref()
    return () => {
      unsubscribe()
      clearInterval(timer)
      watched.clear()
    }
  }, 'client-hmr: bundle watches')

  // --- /plugins/events SSE channel ----------------------------------------
  const connections = new Set<ServerResponse>()

  const connect = (
    res: ServerResponse,
    bindLifecycle: (resource: WebRequestLifecycleResource) => boolean,
  ): boolean => {
    if (!bindLifecycle(res)) return false
    connections.add(res)
    const release = (): void => { connections.delete(res) }
    res.once('close', release)
    res.once('error', release)
    try {
      res.writeHead(200, SSE_HEADERS)
      // Comment line on open so clients/proxies see a live channel even when
      // no rebuild ever happens; EventSource frame parsing skips it naturally.
      const openWritable = res.write(': connected\n\n')
      const graphWritable = res.write(sseData({ type: 'graph', graph: ctx.clientModules.graph() }))
      if (!openWritable || !graphWritable) res.destroy()
    } catch {
      release()
      res.destroy()
    }
    return true
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (req, res) => {
        const auth = ctx.get('webAuth') as WebRequestAuthorizer | undefined
        const decision = authorizeProtectedWebRequest(
          req, trustedHosts, trustedProxyAddresses, auth, requireWebAuth,
        )
        if (!decision.ok) {
          writeJsonError(res, decision.status, decision.code)
          return
        }
        // Named routes match ahead of the carrier's method gate; keep the old
        // global 405 semantics for non-GET hits on this endpoint.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, SSE_HEADERS)
          res.end()
          return
        }
        if (connections.size >= maxSseConnections) {
          writeJsonError(res, 429, 'sse-capacity-exhausted', { 'retry-after': '5' })
          return
        }
        if (!connect(res, decision.bindLifecycle)) {
          writeJsonError(res, 401, 'auth-required')
        }
      },
    })
    const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => {
      const line = sseData({ type: 'rebuilt', id, rev })
      for (const res of connections) {
        if (res.destroyed) {
          connections.delete(res)
          continue
        }
        try {
          if (!res.write(line)) res.destroy()
        } catch {
          connections.delete(res)
          res.destroy()
        }
      }
    })
    return () => {
      unsubscribe()
      disposeRoute()
      for (const res of connections) res.destroy()
      connections.clear()
    }
  }, 'client-hmr: /plugins/events channel')
}
