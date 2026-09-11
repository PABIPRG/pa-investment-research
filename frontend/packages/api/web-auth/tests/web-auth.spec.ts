import { mkdtempSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WebAuthService,
  apply as applyWebAuth,
  hashPassword,
  inject,
  verifyPassword,
  type WebAuthConfig,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function configured(overrides: Partial<WebAuthConfig> = {}): WebAuthConfig {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-web-auth-'))
  const passwordHashFile = join(directory, 'password.hash')
  writeFileSync(passwordHashFile, hashPassword('correct horse battery staple'), { mode: 0o600 })
  return {
    mode: 'required',
    username: 'admin',
    passwordHashFile,
    secureCookies: false,
    idleTimeoutMs: 30_000,
    absoluteTimeoutMs: 120_000,
    loginWindowMs: 60_000,
    loginMaxAttempts: 3,
    ...overrides,
  }
}

function service(config: WebAuthConfig): WebAuthService {
  const ctx = new Context()
  contexts.push(ctx)
  return new WebAuthService(ctx, config)
}

function facts(
  remoteAddress = '127.0.0.1',
  headers: Record<string, string> = {},
  method?: string,
) {
  return { headers, socket: { remoteAddress }, ...(method === undefined ? {} : { method }) }
}

function forwarded(address: string, method?: string) {
  return facts('127.0.0.1', {
    host: 'harness.internal',
    'x-forwarded-for': address,
    'x-forwarded-proto': 'https',
  }, method)
}

function routeRequest(
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url: path, method, headers, socket: { remoteAddress } })
  return request
}

function routeResponse(): { response: ServerResponse; state: { status: number | undefined; body: string } } {
  const state = { status: undefined as number | undefined, body: '' }
  const response = Object.assign(new EventEmitter(), {
    writeHead(status: number) { state.status = status; return this },
    end(value?: string | Uint8Array) {
      state.body = value === undefined ? '' : Buffer.from(value).toString('utf8')
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

describe('password hashing', () => {
  it('uses a versioned salted scrypt record and rejects a wrong password', () => {
    const encoded = hashPassword('long-enough-secret')
    expect(encoded).toMatch(/^dsh-scrypt-v2\$/)
    expect(verifyPassword('long-enough-secret', encoded)).toBe(true)
    expect(verifyPassword('wrong', encoded)).toBe(false)
    expect(verifyPassword('long-enough-secret', 'not-a-record')).toBe(false)
    expect(() => hashPassword('too-short')).toThrow(/at least 12 characters/)
    expect(() => hashPassword('            ')).toThrow(/password strength/)
    expect(() => hashPassword('aaaaaaaaaaaa')).toThrow(/password strength/)
    expect(() => hashPassword('🔒'.repeat(12))).toThrow(/password strength/)
  })
})

describe('WebAuthService', () => {
  it('keeps the compatibility mode open without manufacturing a session', () => {
    const auth = service({ mode: 'disabled' })
    expect(auth.sessionState()).toEqual({ state: 'disabled' })
    const decision = auth.authorize({ headers: {}, method: 'POST' })
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.bindLifecycle?.({ destroy() {}, once() {} })).toBe(true)
  })

  it('fails closed when required credentials are missing', () => {
    const auth = service({ mode: 'required' })
    expect(auth.sessionState()).toEqual({ state: 'unavailable', reason: 'configuration' })
    expect(auth.authorize({ headers: {}, method: 'GET' })).toEqual({
      ok: false,
      status: 503,
      code: 'auth-unavailable',
    })
  })

  it('treats malformed hash configuration as unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-web-auth-bad-'))
    const passwordHashFile = join(directory, 'password.hash')
    writeFileSync(passwordHashFile, 'dsh-scrypt-v1$broken')
    expect(service({ mode: 'required', username: 'admin', passwordHashFile }).sessionState())
      .toEqual({ state: 'unavailable', reason: 'configuration' })
  })

  it('accepts a rotated hash only after a fresh authority starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-web-auth-rotate-'))
    const passwordHashFile = join(directory, 'password.hash')
    writeFileSync(passwordHashFile, hashPassword('old-password'), { mode: 0o600 })
    const first = service({ mode: 'required', username: 'admin', passwordHashFile, secureCookies: false })
    expect((await first.login('admin', 'old-password', facts())).ok).toBe(true)
    writeFileSync(passwordHashFile, hashPassword('new-password'), { mode: 0o600 })
    const rotated = service({ mode: 'required', username: 'admin', passwordHashFile, secureCookies: false })
    expect(await rotated.login('admin', 'old-password', facts())).toMatchObject({ ok: false, status: 401 })
    expect((await rotated.login('admin', 'new-password', facts())).ok).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects readable-by-group password files without exposing their contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-web-auth-mode-'))
    const passwordHashFile = join(directory, 'password.hash')
    writeFileSync(passwordHashFile, hashPassword('protected-password'), { mode: 0o644 })
    expect(service({ mode: 'required', username: 'admin', passwordHashFile }).sessionState())
      .toEqual({ state: 'unavailable', reason: 'configuration' })
  })

  it('creates a server-side session, requires CSRF for mutations, and revokes it on logout', async () => {
    const auth = service(configured())
    const login = await auth.login('admin', 'correct horse battery staple', facts())
    expect(login.ok).toBe(true)
    if (!login.ok || login.session === undefined || login.cookieName === undefined || login.token === undefined) return
    const cookie = `${login.cookieName}=${login.token}`
    const socket = { destroy: vi.fn(), once: vi.fn() }
    const authorized = auth.authorize(facts('127.0.0.1', { cookie }, 'GET'))
    expect(authorized.ok).toBe(true)
    if (!authorized.ok) return
    expect(auth.authorize(facts('127.0.0.1', { cookie }, 'POST'))).toEqual({
      ok: false,
      status: 403,
      code: 'csrf-invalid',
    })
    expect(auth.authorize(facts('127.0.0.1', {
      cookie, 'x-dsh-csrf': login.session.csrfToken,
    }, 'POST')).ok).toBe(true)
    expect(authorized.bindLifecycle?.(socket)).toBe(true)
    expect(auth.logout(facts('127.0.0.1', {
      cookie, 'x-dsh-csrf': login.session.csrfToken,
    }, 'POST')).ok).toBe(true)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(auth.authorize(facts('127.0.0.1', { cookie }, 'GET')).ok).toBe(false)
  })

  it('rate limits repeated login failures without revealing which field was wrong', async () => {
    const auth = service(configured({
      secureCookies: true,
      trustedProxyAddresses: ['127.0.0.1'],
      loginMaxAttempts: 2,
    }))
    expect(await auth.login('admin', 'bad', forwarded('10.0.0.2'))).toMatchObject({ ok: false, status: 401, code: 'invalid-credentials' })
    expect(await auth.login('unknown', 'bad', forwarded('10.0.0.2'))).toMatchObject({ ok: false, status: 401, code: 'invalid-credentials' })
    expect(await auth.login('admin', 'correct horse battery staple', forwarded('10.0.0.2'))).toMatchObject({
      ok: false,
      status: 429,
      code: 'rate-limited',
    })
  })

  it('trusts forwarded transport and client identity only from an explicit proxy', async () => {
    const auth = service(configured({ secureCookies: true, trustedProxyAddresses: ['127.0.0.1'] }))
    expect((await auth.login('admin', 'correct horse battery staple', forwarded('10.0.0.2'))).ok).toBe(true)
    expect(await auth.login('admin', 'correct horse battery staple', facts('10.0.0.9', {
      host: 'harness.internal',
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-proto': 'https',
    }))).toMatchObject({ ok: false, status: 403, code: 'secure-transport-required' })
  })

  it('bounds tracked limiter addresses and frees expired entries', async () => {
    vi.useFakeTimers()
    const auth = service(configured({
      secureCookies: true,
      trustedProxyAddresses: ['127.0.0.1'],
      loginMaxAttempts: 10,
      loginMaxTrackedAddresses: 2,
    }))
    expect(await auth.login('admin', 'bad', forwarded('10.0.0.1'))).toMatchObject({ status: 401 })
    expect(await auth.login('admin', 'bad', forwarded('10.0.0.2'))).toMatchObject({ status: 401 })
    expect(await auth.login('admin', 'bad', forwarded('10.0.0.3'))).toMatchObject({ status: 429, code: 'rate-limited' })
    vi.advanceTimersByTime(60_001)
    expect(await auth.login('admin', 'bad', forwarded('10.0.0.3'))).toMatchObject({ status: 401, code: 'invalid-credentials' })
  })

  it('lets a valid administrator recover after failures from many other addresses', async () => {
    const auth = service(configured({
      secureCookies: true,
      trustedProxyAddresses: ['127.0.0.1'],
      loginMaxAttempts: 1,
    }))
    for (let index = 1; index <= 10; index += 1) {
      expect(await auth.login('admin', 'bad', forwarded(`10.0.0.${String(index)}`)))
        .toMatchObject({ status: 401, code: 'invalid-credentials' })
    }
    expect((await auth.login('admin', 'correct horse battery staple', forwarded('10.0.1.1'))).ok).toBe(true)
  })

  it('rejects excess password verification work without building an unbounded queue', async () => {
    const auth = service(configured({
      secureCookies: true,
      trustedProxyAddresses: ['127.0.0.1'],
      loginMaxConcurrentVerifications: 1,
    }))
    const inFlight = auth.login('admin', 'bad', forwarded('10.0.0.1'))
    expect(await auth.login('admin', 'correct horse battery staple', forwarded('10.0.0.2')))
      .toMatchObject({ status: 429, code: 'rate-limited' })
    expect(await inFlight).toMatchObject({ status: 401, code: 'invalid-credentials' })
    expect((await auth.login('admin', 'correct horse battery staple', forwarded('10.0.0.2'))).ok).toBe(true)
  })

  it('expires idle sessions and destroys their bound lifecycle resources', async () => {
    vi.useFakeTimers()
    const auth = service(configured({ idleTimeoutMs: 1_000, absoluteTimeoutMs: 5_000 }))
    const login = await auth.login('admin', 'correct horse battery staple', facts())
    expect(login.ok).toBe(true)
    if (!login.ok || login.cookieName === undefined || login.token === undefined) return
    const socket = { destroy: vi.fn(), once: vi.fn() }
    const cookie = `${login.cookieName}=${login.token}`
    const authorized = auth.authorize(facts('127.0.0.1', { cookie }, 'GET'))
    expect(authorized.ok).toBe(true)
    if (!authorized.ok) return
    expect(authorized.bindLifecycle?.(socket)).toBe(true)
    vi.advanceTimersByTime(1_001)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(auth.authorize(facts('127.0.0.1', { cookie }, 'GET')).ok).toBe(false)
  })

  it('enforces the absolute lifetime even when activity keeps extending the idle deadline', async () => {
    vi.useFakeTimers()
    const auth = service(configured({ idleTimeoutMs: 1_000, absoluteTimeoutMs: 2_000 }))
    const login = await auth.login('admin', 'correct horse battery staple', facts())
    expect(login.ok).toBe(true)
    if (!login.ok || login.cookieName === undefined || login.token === undefined) return
    const socket = { destroy: vi.fn(), once: vi.fn() }
    const requestFacts = facts('127.0.0.1', { cookie: `${login.cookieName}=${login.token}` }, 'GET')
    const authorized = auth.authorize(requestFacts)
    expect(authorized.ok).toBe(true)
    if (!authorized.ok) return
    expect(authorized.bindLifecycle?.(socket)).toBe(true)
    vi.advanceTimersByTime(800)
    expect(auth.authorize(requestFacts).ok).toBe(true)
    vi.advanceTimersByTime(800)
    expect(auth.authorize(requestFacts).ok).toBe(true)
    vi.advanceTimersByTime(401)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(auth.authorize(requestFacts).ok).toBe(false)
  })
})

describe('Web auth HTTP boundary', () => {
  it('accepts a trusted non-loopback health authority across a bridge and rejects another Host', async () => {
    const routes: WebRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', {
      host: '0.0.0.0', port: 39080,
      register(route: WebRoute) { routes.push(route); return () => {} },
    } as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply: applyWebAuth }, configured({
      secureCookies: true,
      trustedHosts: ['investment.test:39080'],
      trustedProxyAddresses: ['192.0.2.1'],
    }))
    await fiber.await()
    const health = routes.find(route => route.path === '/healthz')!
    const accepted = routeResponse()
    await health.handler(routeRequest(
      '/healthz', { host: 'investment.test:39080' }, 'GET', '172.30.20.1',
    ), accepted.response)
    expect(accepted.state).toEqual({ status: 200, body: '{"status":"ok"}' })
    expect(accepted.state.body).not.toContain('correct horse battery staple')

    const rejected = routeResponse()
    await health.handler(routeRequest(
      '/healthz', { host: 'attacker.test:39080' }, 'GET', '172.30.20.1',
    ), rejected.response)
    expect(rejected.state).toEqual({ status: 403, body: '{"code":"request-untrusted"}' })
    await fiber.dispose()
  })

  it('keeps the boot capability graph private until the session is authorized', async () => {
    const routes: WebRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', {
      host: '127.0.0.1', port: 0,
      register(route: WebRoute) { routes.push(route); return () => {} },
    } as WebServer)
    ctx.provide('clientModules', { graph: () => ({ rev: 'PRIVATE_GRAPH_MARKER', entries: [] }) } as never)
    const config = configured()
    const fiber = ctx.plugin({ inject: [...inject], apply: applyWebAuth }, config)
    await fiber.await()
    const boot = routes.find(route => route.path === '/auth/boot')!
    const anonymous = routeResponse()
    await boot.handler(routeRequest('/auth/boot', { host: '127.0.0.1:3080' }), anonymous.response)
    expect(anonymous.state.status).toBe(401)
    expect(anonymous.state.body).not.toContain('PRIVATE_GRAPH_MARKER')

    const auth = ctx.get('webAuth')!
    const login = await auth.login('admin', 'correct horse battery staple', facts())
    expect(login.ok).toBe(true)
    if (!login.ok || login.cookieName === undefined || login.token === undefined) return
    const authorized = routeResponse()
    await boot.handler(routeRequest('/auth/boot', {
      host: '127.0.0.1:3080', cookie: `${login.cookieName}=${login.token}`,
    }), authorized.response)
    expect(authorized.state.status).toBe(200)
    expect(authorized.state.body).toContain('PRIVATE_GRAPH_MARKER')
    await fiber.dispose()
  })
})
