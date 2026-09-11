import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WebAuthService,
  hashPassword,
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

describe('password hashing', () => {
  it('uses a versioned salted scrypt record and rejects a wrong password', () => {
    const encoded = hashPassword('secret')
    expect(encoded).toMatch(/^dsh-scrypt-v1\$/)
    expect(verifyPassword('secret', encoded)).toBe(true)
    expect(verifyPassword('wrong', encoded)).toBe(false)
    expect(verifyPassword('secret', 'not-a-record')).toBe(false)
  })
})

describe('WebAuthService', () => {
  it('keeps the compatibility mode open without manufacturing a session', () => {
    const auth = service({ mode: 'disabled' })
    expect(auth.sessionState()).toEqual({ state: 'disabled' })
    expect(auth.authorize({ headers: {}, method: 'POST' })).toEqual({ ok: true })
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

  it('accepts a rotated hash only after a fresh authority starts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-web-auth-rotate-'))
    const passwordHashFile = join(directory, 'password.hash')
    writeFileSync(passwordHashFile, hashPassword('old-password'))
    const first = service({ mode: 'required', username: 'admin', passwordHashFile, secureCookies: false })
    expect(first.login('admin', 'old-password', 'local').ok).toBe(true)
    writeFileSync(passwordHashFile, hashPassword('new-password'))
    const rotated = service({ mode: 'required', username: 'admin', passwordHashFile, secureCookies: false })
    expect(rotated.login('admin', 'old-password', 'local')).toMatchObject({ ok: false, status: 401 })
    expect(rotated.login('admin', 'new-password', 'local').ok).toBe(true)
  })

  it('creates a server-side session, requires CSRF for mutations, and revokes it on logout', () => {
    const auth = service(configured())
    const login = auth.login('admin', 'correct horse battery staple', '127.0.0.1')
    expect(login.ok).toBe(true)
    if (!login.ok || login.session === undefined || login.cookieName === undefined || login.token === undefined) return
    const cookie = `${login.cookieName}=${login.token}`
    const socket = { destroy: vi.fn(), once: vi.fn() }
    expect(auth.authorize({ headers: { cookie }, method: 'GET' }).ok).toBe(true)
    expect(auth.authorize({ headers: { cookie }, method: 'POST' })).toEqual({
      ok: false,
      status: 403,
      code: 'csrf-invalid',
    })
    expect(auth.authorize({
      headers: { cookie, 'x-dsh-csrf': login.session.csrfToken },
      method: 'POST',
    }).ok).toBe(true)
    expect(auth.trackSocket({ headers: { cookie }, method: 'GET' }, socket)).toBe(true)
    expect(auth.logout({ headers: { cookie, 'x-dsh-csrf': login.session.csrfToken }, method: 'POST' }).ok).toBe(true)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(auth.authorize({ headers: { cookie }, method: 'GET' }).ok).toBe(false)
  })

  it('rate limits repeated login failures without revealing which field was wrong', () => {
    const auth = service(configured({ loginMaxAttempts: 2 }))
    expect(auth.login('admin', 'bad', '10.0.0.2')).toMatchObject({ ok: false, status: 401, code: 'invalid-credentials' })
    expect(auth.login('unknown', 'bad', '10.0.0.2')).toMatchObject({ ok: false, status: 401, code: 'invalid-credentials' })
    expect(auth.login('admin', 'correct horse battery staple', '10.0.0.2')).toMatchObject({
      ok: false,
      status: 429,
      code: 'rate-limited',
    })
  })

  it('expires idle sessions and destroys their tracked sockets', () => {
    vi.useFakeTimers()
    const auth = service(configured({ idleTimeoutMs: 1_000, absoluteTimeoutMs: 5_000 }))
    const login = auth.login('admin', 'correct horse battery staple', '127.0.0.1')
    expect(login.ok).toBe(true)
    if (!login.ok || login.cookieName === undefined || login.token === undefined) return
    const socket = { destroy: vi.fn(), once: vi.fn() }
    const cookie = `${login.cookieName}=${login.token}`
    expect(auth.trackSocket({ headers: { cookie }, method: 'GET' }, socket)).toBe(true)
    vi.advanceTimersByTime(1_001)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(auth.authorize({ headers: { cookie }, method: 'GET' }).ok).toBe(false)
  })

  it('enforces the absolute lifetime even when activity keeps extending the idle deadline', () => {
    vi.useFakeTimers()
    const auth = service(configured({ idleTimeoutMs: 1_000, absoluteTimeoutMs: 2_000 }))
    const login = auth.login('admin', 'correct horse battery staple', '127.0.0.1')
    expect(login.ok).toBe(true)
    if (!login.ok || login.cookieName === undefined || login.token === undefined) return
    const socket = { destroy: vi.fn(), once: vi.fn() }
    const facts = { headers: { cookie: `${login.cookieName}=${login.token}` }, method: 'GET' }
    expect(auth.trackSocket(facts, socket)).toBe(true)
    vi.advanceTimersByTime(800)
    expect(auth.authorize(facts).ok).toBe(true)
    vi.advanceTimersByTime(800)
    expect(auth.authorize(facts).ok).toBe(true)
    vi.advanceTimersByTime(401)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(auth.authorize(facts).ok).toBe(false)
  })
})
