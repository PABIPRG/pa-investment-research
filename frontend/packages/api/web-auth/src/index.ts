import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isTrustedApiRequest } from '@deepseek-ai/dsh-host-webserver/request-trust'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' { interface Context { webAuth?: WebAuthService } }

export const name = 'web-auth'
export const inject = ['webServer']
const MAX_LOGIN_BODY_BYTES = 16 * 1024
const PASSWORD_PREFIX = 'dsh-scrypt-v1'
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELISM = 1
const SCRYPT_KEY_BYTES = 32
const GLOBAL_ATTEMPT_KEY = '__global__'

export interface WebAuthConfig {
  mode: 'disabled' | 'required'
  username?: string
  passwordHashFile?: string
  secureCookies?: boolean
  trustedHosts?: string[]
  idleTimeoutMs?: number
  absoluteTimeoutMs?: number
  loginWindowMs?: number
  loginMaxAttempts?: number
}

export const Config: z<WebAuthConfig> = z.object({
  mode: z.union([z.const('disabled'), z.const('required')]).default('disabled'),
  username: z.string(),
  passwordHashFile: z.string(),
  secureCookies: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  idleTimeoutMs: z.natural().min(1_000).default(30 * 60_000),
  absoluteTimeoutMs: z.natural().min(1_000).default(12 * 60 * 60_000),
  loginWindowMs: z.natural().min(1_000).default(60_000),
  loginMaxAttempts: z.natural().min(1).default(5),
})

interface RequestFacts {
  headers: IncomingMessage['headers'] | Headers | Record<string, string | undefined>
  method?: string | undefined
}

interface SocketLike {
  destroy(): void
  once(event: 'close', listener: () => void): unknown
}

interface SessionRecord {
  username: string
  csrfToken: string
  createdAt: number
  lastSeenAt: number
  timer: ReturnType<typeof setTimeout>
  sockets: Set<SocketLike>
}

interface SessionView { username: string; csrfToken: string; expiresAt: number }

export type WebAuthSessionState =
  | { state: 'disabled' }
  | { state: 'unavailable'; reason: 'configuration' }
  | { state: 'signed-out' }
  | ({ state: 'signed-in' } & SessionView)

export type WebAuthDecision = { ok: true; sessionId?: string } | {
  ok: false
  status: 401 | 403 | 429 | 503
  code: 'auth-required' | 'auth-unavailable' | 'csrf-invalid' | 'invalid-credentials' | 'rate-limited'
}

export type WebAuthLoginResult = WebAuthDecision & Partial<{
  cookieName: string
  token: string
  session: SessionView
}>

/** Produce a salted, versioned password record suitable for a protected file. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM, maxmem: 64 * 1024 * 1024,
  })
  return [PASSWORD_PREFIX, SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELISM,
    salt.toString('base64url'), derived.toString('base64url')].join('$')
}

/** Verify one password without throwing on malformed or unsupported records. */
export function verifyPassword(password: string, encoded: string): boolean {
  const parsed = parsePasswordRecord(encoded)
  if (parsed === undefined) return false
  try {
    const actual = scryptSync(password, parsed.salt, parsed.expected.length, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM, maxmem: 64 * 1024 * 1024,
    })
    return timingSafeEqual(actual, parsed.expected)
  } catch { return false }
}

function parsePasswordRecord(encoded: string): { salt: Buffer; expected: Buffer } | undefined {
  const [prefix, rawN, rawR, rawP, rawSalt, rawDerived, ...extra] = encoded.trim().split('$')
  if (prefix !== PASSWORD_PREFIX || extra.length > 0 || rawSalt === undefined || rawDerived === undefined
    || Number(rawN) !== SCRYPT_COST || Number(rawR) !== SCRYPT_BLOCK_SIZE
    || Number(rawP) !== SCRYPT_PARALLELISM) return undefined
  try {
    const salt = Buffer.from(rawSalt, 'base64url'); const expected = Buffer.from(rawDerived, 'base64url')
    return salt.length === 16 && expected.length === SCRYPT_KEY_BYTES ? { salt, expected } : undefined
  } catch { return undefined }
}

function header(facts: RequestFacts, name: string): string | undefined {
  if (facts.headers instanceof Headers) return facts.headers.get(name) ?? undefined
  const value = facts.headers[name]
  return typeof value === 'string' ? value : undefined
}

function cookieValue(facts: RequestFacts, name: string): string | undefined {
  const cookie = header(facts, 'cookie')
  if (cookie === undefined) return undefined
  for (const part of cookie.split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

function digest(token: string): string { return createHash('sha256').update(token).digest('base64url') }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Process-local, fail-closed Web authentication authority. */
export class WebAuthService extends Service {
  readonly enabled: boolean
  readonly available: boolean
  readonly cookieName: string
  private readonly username: string | undefined
  private readonly passwordHash: string | undefined
  private readonly secureCookies: boolean
  private readonly idleTimeoutMs: number
  private readonly absoluteTimeoutMs: number
  private readonly loginWindowMs: number
  private readonly loginMaxAttempts: number
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly attempts = new Map<string, number[]>()

  constructor(ctx: Context, config: WebAuthConfig) {
    super(ctx, 'webAuth')
    this.enabled = config.mode === 'required'
    this.username = config.username
    this.secureCookies = config.secureCookies ?? true
    this.cookieName = this.secureCookies ? '__Host-dsh-session' : 'dsh-dev-session'
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30 * 60_000
    this.absoluteTimeoutMs = config.absoluteTimeoutMs ?? 12 * 60 * 60_000
    this.loginWindowMs = config.loginWindowMs ?? 60_000
    this.loginMaxAttempts = config.loginMaxAttempts ?? 5
    let loaded: string | undefined
    if (this.enabled && config.passwordHashFile !== undefined) {
      try { loaded = readFileSync(config.passwordHashFile, 'utf8').trim() } catch { loaded = undefined }
    }
    this.passwordHash = loaded
    this.available = !this.enabled || (this.username !== undefined && this.username !== ''
      && loaded !== undefined && parsePasswordRecord(loaded) !== undefined)
    ctx.effect(() => () => {
      for (const id of [...this.sessions.keys()]) this.revoke(id)
      this.attempts.clear()
    }, 'web-auth: session cleanup')
  }

  /**
   * Return the public session state without extending its idle deadline.
   * @param facts - optional request carrying the opaque session cookie.
   * @returns the disabled, unavailable, signed-out, or signed-in public view.
   */
  sessionState(facts?: RequestFacts): WebAuthSessionState {
    if (!this.enabled) return { state: 'disabled' }
    if (!this.available) return { state: 'unavailable', reason: 'configuration' }
    const found = facts === undefined ? undefined : this.find(facts, false)
    return found === undefined ? { state: 'signed-out' } : { state: 'signed-in', ...this.view(found.record) }
  }

  /**
   * Authorize one HTTP request and enforce CSRF on state-changing methods.
   * @param facts - request headers and method at the transport boundary.
   * @returns an allow decision or a stable HTTP rejection.
   */
  authorize(facts: RequestFacts): WebAuthDecision {
    if (!this.enabled) return { ok: true }
    if (!this.available) return { ok: false, status: 503, code: 'auth-unavailable' }
    const found = this.find(facts, true)
    if (found === undefined) return { ok: false, status: 401, code: 'auth-required' }
    if (facts.method !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(facts.method.toUpperCase())) {
      const csrf = header(facts, 'x-dsh-csrf')
      if (csrf === undefined || !safeEqual(csrf, found.record.csrfToken)) {
        return { ok: false, status: 403, code: 'csrf-invalid' }
      }
    }
    return { ok: true, sessionId: found.id }
  }

  /**
   * Validate administrator credentials and create a process-local session.
   * @param username - submitted administrator identifier.
   * @param password - submitted password, retained only for this verification call.
   * @param address - transport source used by the per-address limiter.
   * @returns a rejection or the new opaque token and public session view.
   */
  login(username: string, password: string, address: string): WebAuthLoginResult {
    if (!this.enabled) return { ok: true }
    if (!this.available) return { ok: false, status: 503, code: 'auth-unavailable' }
    if (this.rateLimited(address)) return { ok: false, status: 429, code: 'rate-limited' }
    // Always pay the password-verification cost so a remote caller cannot use
    // response timing to distinguish a valid administrator identifier.
    const usernameMatches = safeEqual(username, this.username as string)
    const passwordMatches = verifyPassword(password, this.passwordHash as string)
    if (!usernameMatches || !passwordMatches) {
      this.recordFailure(address)
      return { ok: false, status: 401, code: 'invalid-credentials' }
    }
    this.attempts.delete(address)
    const token = randomBytes(32).toString('base64url')
    const id = digest(token)
    const now = Date.now()
    const record: SessionRecord = {
      username, csrfToken: randomBytes(32).toString('base64url'), createdAt: now, lastSeenAt: now,
      timer: undefined as unknown as ReturnType<typeof setTimeout>, sockets: new Set(),
    }
    this.sessions.set(id, record)
    this.schedule(id, record)
    return { ok: true, cookieName: this.cookieName, token, session: this.view(record) }
  }

  /**
   * Authorize and revoke the session carried by a logout request.
   * @param facts - request carrying the session cookie and CSRF proof.
   * @returns an allow decision after revocation or a stable rejection.
   */
  logout(facts: RequestFacts): WebAuthDecision {
    const decision = this.authorize(facts)
    if (!decision.ok || decision.sessionId === undefined) return decision
    this.revoke(decision.sessionId)
    return { ok: true }
  }

  /**
   * Associate an authorized WebSocket with its session for later revocation.
   * @param facts - upgrade request carrying the session cookie.
   * @param socket - accepted transport socket to close when the session ends.
   * @returns whether the upgrade may continue.
   */
  trackSocket(facts: RequestFacts, socket: SocketLike): boolean {
    const decision = this.authorize(facts)
    if (!decision.ok) return false
    if (decision.sessionId === undefined) return true
    const record = this.sessions.get(decision.sessionId)
    if (record === undefined) return false
    record.sockets.add(socket)
    socket.once('close', () => { record.sockets.delete(socket) })
    return true
  }

  /**
   * Serialize the configured session cookie attributes for a new token.
   * @param token - high-entropy token returned only at session creation.
   * @returns one Set-Cookie header value.
   */
  cookieHeader(token: string): string {
    return `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/${this.secureCookies ? '; Secure' : ''}`
  }

  /**
   * Serialize an expired cookie that clears the configured session name.
   * @returns one clearing Set-Cookie header value.
   */
  clearCookieHeader(): string {
    return `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secureCookies ? '; Secure' : ''}`
  }

  private find(facts: RequestFacts, touch: boolean): { id: string; record: SessionRecord } | undefined {
    const token = cookieValue(facts, this.cookieName)
    if (token === undefined) return undefined
    const id = digest(token); const record = this.sessions.get(id)
    if (record === undefined) return undefined
    const now = Date.now()
    if (now - record.lastSeenAt >= this.idleTimeoutMs || now - record.createdAt >= this.absoluteTimeoutMs) {
      this.revoke(id); return undefined
    }
    if (touch) { record.lastSeenAt = now; this.schedule(id, record) }
    return { id, record }
  }

  private view(record: SessionRecord): SessionView {
    return { username: record.username, csrfToken: record.csrfToken,
      expiresAt: Math.min(record.lastSeenAt + this.idleTimeoutMs, record.createdAt + this.absoluteTimeoutMs) }
  }

  private schedule(id: string, record: SessionRecord): void {
    clearTimeout(record.timer)
    const delay = Math.max(0, Math.min(record.lastSeenAt + this.idleTimeoutMs,
      record.createdAt + this.absoluteTimeoutMs) - Date.now())
    record.timer = setTimeout(() => { this.revoke(id) }, delay)
    record.timer.unref()
  }

  private revoke(id: string): void {
    const record = this.sessions.get(id)
    if (record === undefined) return
    this.sessions.delete(id); clearTimeout(record.timer)
    for (const socket of record.sockets) socket.destroy()
    record.sockets.clear()
  }

  private recent(address: string): number[] {
    const cutoff = Date.now() - this.loginWindowMs
    const recent = (this.attempts.get(address) ?? []).filter(at => at > cutoff)
    if (recent.length === 0) this.attempts.delete(address); else this.attempts.set(address, recent)
    return recent
  }
  private rateLimited(address: string): boolean {
    return this.recent(address).length >= this.loginMaxAttempts
      || this.recent(GLOBAL_ATTEMPT_KEY).length >= this.loginMaxAttempts * 10
  }
  private recordFailure(address: string): void {
    const now = Date.now()
    this.attempts.set(address, [...this.recent(address), now])
    this.attempts.set(GLOBAL_ATTEMPT_KEY, [...this.recent(GLOBAL_ATTEMPT_KEY), now])
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

async function readLoginBody(req: IncomingMessage): Promise<{ username: string; password: string } | undefined> {
  let size = 0; const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length
    if (size > MAX_LOGIN_BODY_BYTES) return undefined
    chunks.push(new Uint8Array(bytes))
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const body = parsed as Record<string, unknown>
    return typeof body.username === 'string' && typeof body.password === 'string'
      ? { username: body.username, password: body.password } : undefined
  } catch { return undefined }
}

/** Mount authentication routes and provide the authority to the transport. */
export function apply(ctx: Context, config: WebAuthConfig): void {
  if (ctx.webServer.host !== '127.0.0.1' && config.mode !== 'required') {
    throw new Error('web-auth: a non-loopback Web server requires authentication')
  }
  if (config.mode === 'required' && config.secureCookies === false && ctx.webServer.host !== '127.0.0.1') {
    throw new Error('web-auth: insecure cookies are allowed only on the loopback Web server')
  }
  const auth = new WebAuthService(ctx, config)
  const trustedHosts = config.trustedHosts ?? []
  const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('web-auth: webServer service unavailable')
    ctx.effect(() => webServer.register({ kind: 'exact', path, handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) { writeJson(res, 403, { code: 'request-untrusted' }); return }
      await handler(req, res)
    } }), `web-auth: ${path}`)
  }
  route('/auth/session', (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    const state = auth.sessionState(req); writeJson(res, state.state === 'unavailable' ? 503 : 200, state)
  })
  route('/auth/login', async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const body = await readLoginBody(req)
    if (body === undefined) { writeJson(res, 400, { code: 'invalid-request' }); return }
    const result = auth.login(body.username, body.password, req.socket.remoteAddress ?? 'unknown')
    if (!result.ok) { writeJson(res, result.status, { code: result.code }); return }
    if (result.session === undefined || result.token === undefined) { writeJson(res, 200, { state: 'disabled' }); return }
    writeJson(res, 200, { state: 'signed-in', ...result.session }, { 'set-cookie': auth.cookieHeader(result.token) })
  })
  route('/auth/logout', (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const result = auth.logout(req)
    if (!result.ok) { writeJson(res, result.status, { code: result.code }); return }
    writeJson(res, 200, { state: 'signed-out' }, { 'set-cookie': auth.clearCookieHeader() })
  })
  route('/healthz', (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    writeJson(res, auth.available ? 200 : 503, { status: auth.available ? 'ok' : 'not-ready' })
  })
}
