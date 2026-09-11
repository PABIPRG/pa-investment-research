/**
 * Node half of the HMR plugin: bundle watches follow the graph, stat changes
 * report through clientModuleHost.rebuilt, and everything dies with the fiber.
 */
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebBootGraph, ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, EVENTS_ENDPOINT, inject } from '../src/index.ts'

const POLL_MS = 20

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/**
 * Controllable clientModuleHost fake over a mutable id → bundle-path table.
 * Structural (Pick+cast): the plugin only touches the read/notify surface;
 * the service class carries private scan state a literal need not reproduce.
 */
type FakeHost = ClientModuleRegistry & { rebuiltCalls: string[]; fireGraphChanged(): void }
interface FakeHostOptions {
  beforeGraphRead?: () => void
  rebuilt?: (id: string) => string | undefined
}

function fakeClientModuleHost(rows: Map<string, string>, options: FakeHostOptions = {}): FakeHost {
  const graphListeners = new Set<() => void>()
  const rebuiltCalls: string[] = []
  const fake: Pick<FakeHost, 'graph' | 'clientPath' | 'rebuilt' | 'onRebuilt' | 'onGraphChanged' | 'rebuiltCalls' | 'fireGraphChanged'> = {
    rebuiltCalls,
    fireGraphChanged: () => { for (const l of graphListeners) l() },
    graph: (): WebBootGraph => {
      options.beforeGraphRead?.()
      return {
        rev: 'r',
        entries: [...rows.keys()].map(id => ({ id, url: `/plugins/${id}/client.js?rev=r`, rev: 'r' })),
      }
    },
    clientPath: id => rows.get(id),
    rebuilt: (id) => {
      rebuiltCalls.push(id)
      return options.rebuilt?.(id) ?? 'r2'
    },
    onRebuilt: () => () => {},
    onGraphChanged: (listener) => {
      graphListeners.add(listener)
      return () => { graphListeners.delete(listener) }
    },
  }
  return fake as FakeHost
}

// Structural fake: the plugin only touches register(); the service class
// carries private state a literal cannot (and need not) reproduce.
function fakeHttpServer(routes: WebRoute[]): WebServer {
  const fake: Pick<WebServer, 'register' | 'tapIndex' | 'port'> = {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
  return fake as WebServer
}

interface WebAuthStub {
  authorize(request: IncomingMessage):
    | { ok: true }
    | { ok: false; status: 401 | 403 | 429 | 503; code: string }
}

async function mount(
  clientModuleHost: FakeHost,
  webServer: WebServer,
  config: Partial<Config> = {},
  webAuth?: WebAuthStub,
) {
  const ctx = new Context()
  ctx.provide('clientModules', clientModuleHost)
  ctx.provide('webServer', webServer)
  if (webAuth !== undefined) ctx.provide('webAuth', webAuth as never)
  const fiber = ctx.plugin(
    { inject: [...inject], Config, apply },
    { pollIntervalMs: POLL_MS, ...config },
  )
  await fiber.await()
  return fiber
}

function routeRequest(
  headers: Record<string, string>,
  method = 'GET',
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url: EVENTS_ENDPOINT, method, headers, socket: { remoteAddress } })
  return request
}

interface ResponseState {
  status: number | undefined
  headers: Record<string, string>
  body: string
  ended: boolean
  destroyed: boolean
}

function routeResponse(): { response: ServerResponse; state: ResponseState } {
  const state: ResponseState = { status: undefined, headers: {}, body: '', ended: false, destroyed: false }
  const emitter = new EventEmitter()
  const response = Object.assign(emitter, {
    destroyed: false,
    writeHead(status: number, headers: Record<string, string> = {}) {
      state.status = status
      state.headers = headers
      return this
    },
    write(value: string | Uint8Array) {
      state.body += Buffer.from(value).toString('utf8')
      return true
    },
    end(value?: string | Uint8Array) {
      if (value !== undefined) state.body += Buffer.from(value).toString('utf8')
      state.ended = true
      return this
    },
    destroy() {
      if (state.destroyed) return this
      state.destroyed = true
      Object.assign(emitter, { destroyed: true })
      emitter.emit('close')
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

describe('hmr node half', () => {
  it('keeps the exact events route behind request trust and WebAuth instead of bypassing the /plugins prefix', async () => {
    const privateGraphMarker = 'PRIVATE_GRAPH_MARKER'
    const clientModuleHost = fakeClientModuleHost(new Map([[privateGraphMarker, join(dir, 'private.js')]]))
    const routes: WebRoute[] = []
    const authorize = vi.fn<WebAuthStub['authorize']>(request => request.headers.cookie === 'session=valid'
      ? { ok: true }
      : { ok: false, status: 401, code: 'auth-required' })
    const fiber = await mount(clientModuleHost, fakeHttpServer(routes), {
      trustedHosts: ['harness.internal'],
      trustedProxyAddresses: ['127.0.0.1'],
      requireWebAuth: true,
    }, { authorize })
    const route = routes[0]!

    const untrusted = routeResponse()
    await route.handler(routeRequest({ host: 'evil.example' }), untrusted.response)
    expect(untrusted.state).toMatchObject({ status: 403, ended: true })
    expect(untrusted.state.body).not.toContain(privateGraphMarker)
    expect(authorize).not.toHaveBeenCalled()

    const anonymous = routeResponse()
    await route.handler(routeRequest({
      host: 'harness.internal',
      origin: 'https://harness.internal',
      'x-forwarded-for': '10.0.0.8',
      'x-forwarded-proto': 'https',
    }), anonymous.response)
    expect(anonymous.state).toMatchObject({ status: 401, ended: true })
    expect(anonymous.state.body).toContain('auth-required')
    expect(anonymous.state.body).not.toContain(privateGraphMarker)
    expect(authorize).toHaveBeenCalledOnce()

    const authenticated = routeResponse()
    await route.handler(routeRequest({
      host: 'harness.internal',
      origin: 'https://harness.internal',
      'x-forwarded-for': '10.0.0.8',
      'x-forwarded-proto': 'https',
      cookie: 'session=valid',
    }), authenticated.response)
    expect(authenticated.state.status).toBe(200)
    expect(authenticated.state.body).toContain(privateGraphMarker)

    await fiber.dispose()
  })

  it('fails closed without the required authority and rejects non-HTTPS public requests', async () => {
    const clientModuleHost = fakeClientModuleHost(new Map())
    const missingRoutes: WebRoute[] = []
    const missing = await mount(clientModuleHost, fakeHttpServer(missingRoutes), {
      trustedHosts: ['harness.internal'],
      requireWebAuth: true,
    })
    const unavailable = routeResponse()
    await missingRoutes[0]!.handler(routeRequest({ host: 'harness.internal' }), unavailable.response)
    expect(unavailable.state).toMatchObject({ status: 503, ended: true })
    expect(unavailable.state.body).toContain('auth-unavailable')
    await missing.dispose()

    const routes: WebRoute[] = []
    const authorize = vi.fn<WebAuthStub['authorize']>(request => request.headers['x-forwarded-proto'] === 'https'
      ? { ok: true }
      : { ok: false, status: 403, code: 'secure-transport-required' })
    const fiber = await mount(clientModuleHost, fakeHttpServer(routes), {
      trustedHosts: ['harness.internal'],
      trustedProxyAddresses: ['127.0.0.1'],
      requireWebAuth: true,
    }, { authorize })
    const insecure = routeResponse()
    await routes[0]!.handler(routeRequest({
      host: 'harness.internal',
      origin: 'https://harness.internal',
      'x-forwarded-for': '10.0.0.8',
      'x-forwarded-proto': 'http',
    }), insecure.response)
    expect(insecure.state).toMatchObject({ status: 403, ended: true })
    expect(insecure.state.body).toContain('secure-transport-required')
    await fiber.dispose()
  })

  it('bounds authorized SSE connections and releases capacity on close, error, and disposal', async () => {
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-private', join(dir, 'private.js')]]))
    const routes: WebRoute[] = []
    const fiber = await mount(clientModuleHost, fakeHttpServer(routes), {
      maxSseConnections: 1,
      requireWebAuth: true,
    }, { authorize: () => ({ ok: true }) })
    const route = routes[0]!
    const request = routeRequest({ host: '127.0.0.1:3080' })

    const first = routeResponse()
    await route.handler(request, first.response)
    expect(first.state.status).toBe(200)
    expect(first.state.body).toContain('pkg-private')

    const exhausted = routeResponse()
    await route.handler(request, exhausted.response)
    expect(exhausted.state).toMatchObject({ status: 429, ended: true })
    expect(exhausted.state.headers['retry-after']).toBe('5')
    expect(exhausted.state.body).toContain('sse-capacity-exhausted')

    first.response.emit('close')
    const afterClose = routeResponse()
    await route.handler(request, afterClose.response)
    expect(afterClose.state.status).toBe(200)

    afterClose.response.emit('error', new Error('client reset'))
    const afterError = routeResponse()
    await route.handler(request, afterError.response)
    expect(afterError.state.status).toBe(200)

    await fiber.dispose()
    expect(afterError.state.destroyed).toBe(true)
  })

  it('watches graph bundles, reports stat changes, and unwatches on dispose', async () => {
    const bundle = join(dir, 'a.js')
    writeFileSync(bundle, 'v1')
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const routes: WebRoute[] = []
    const fiber = await mount(clientModuleHost, fakeHttpServer(routes))

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'exact', path: EVENTS_ENDPOINT })
    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a'])
    clientModuleHost.rebuiltCalls.length = 0

    // Nudge mtime past stat granularity so the poller sees a content signal.
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-a') }, { timeout: 3_000 })

    await fiber.dispose()
    expect(routes).toHaveLength(0)
    // Watcher gone: further file changes report nothing.
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(bundle, 'v3-even-longer')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 4))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
  })

  it('follows graph changes: rows added after activation get watched', async () => {
    const early = join(dir, 'early.js')
    const late = join(dir, 'late.js')
    writeFileSync(early, 'v1')
    const rows = new Map([['pkg-early', early]])
    const clientModuleHost = fakeClientModuleHost(rows)
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    writeFileSync(late, 'v1')
    rows.set('pkg-late', late)
    clientModuleHost.fireGraphChanged()
    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-late'])
    clientModuleHost.rebuiltCalls.length = 0

    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(late, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-late') }, { timeout: 3_000 })

    rows.delete('pkg-late')
    clientModuleHost.fireGraphChanged()
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(late, 'v3-even-longer')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('rehashes after baseline capture so a construction-window write cannot become the baseline', async () => {
    const bundle = join(dir, 'construction.js')
    writeFileSync(bundle, 'v1')
    let rewrite = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      beforeGraphRead: () => {
        if (!rewrite) return
        rewrite = false
        // The graph carries the hash from before this write. The old
        // fs.watchFile registration asynchronously captured the new file as
        // its first baseline and never requested a re-hash.
        writeFileSync(bundle, 'v2-written-during-watch-construction')
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a'])
    clientModuleHost.rebuiltCalls.length = 0
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('marks a vanished bundle dirty so identical metadata still re-hashes after it reappears', async () => {
    const bundle = join(dir, 'replace.js')
    writeFileSync(bundle, 'seed')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    const baseline = statSync(bundle)
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    unlinkSync(bundle)
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'x'.repeat(baseline.size))
    utimesSync(bundle, fixedTime, fixedTime)
    const restored = statSync(bundle)
    expect({ mtimeMs: restored.mtimeMs, size: restored.size }).toEqual({
      mtimeMs: baseline.mtimeMs,
      size: baseline.size,
    })
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })

  it('retains a dirty baseline when the immediate re-hash races a rename', async () => {
    const bundle = join(dir, 'rename.js')
    writeFileSync(bundle, 'v1')
    let first = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      rebuilt: () => {
        if (!first) return 'r2'
        first = false
        throw Object.assign(new Error('bundle renamed'), { code: 'ENOENT' })
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a', 'pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })
})
