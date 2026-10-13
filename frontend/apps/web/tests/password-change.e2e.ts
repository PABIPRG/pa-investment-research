import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// Boot the shipped Loader/CLI without model calls or external integrations.
const cli = fileURLToPath(new URL('../../cli/lib/bin.js', import.meta.url))
const oldPassword = 'Initial-Test-Password-2026'
const nextPassword = 'Changed-Test-Password-2026'
const resetPassword = 'Recovery-Test-Password-2026'
let root: string
let home: string
let hash: string
let port: number
let env: NodeJS.ProcessEnv
let child: ChildProcess | undefined
let log = ''
async function start() {
  child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', join(home, 'overlay.yml'), '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env })
  child.stdout?.on('data', (chunk) => { log += String(chunk) })
  child.stderr?.on('data', (chunk) => { log += String(chunk) })
  await vi.waitFor(async () => {
    if (child?.exitCode !== null) throw new Error(log)
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)
  }, { timeout: 60_000, interval: 250 })
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'exit'); child.kill('SIGTERM')
  const timer = setTimeout(() => child?.kill('SIGKILL'), 5_000)
  await closed; clearTimeout(timer)
}
interface Session { cookie: string; csrf: string }
async function request(path: string, body?: unknown, session?: Session) {
  const origin = `http://127.0.0.1:${port}`
  return fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    origin, 'content-type': 'application/json', ...(session === undefined ? {} : { cookie: session.cookie, 'x-dsh-csrf': session.csrf }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function login(password = oldPassword): Promise<Session> {
  const response = await request('/auth/login', { username: 'local-test', password })
  expect(response.status).toBe(200)
  const state = await response.json() as { state: string; csrfToken: string; passwordChangeEnabled: boolean }
  expect(state.state).toBe('signed-in'); expect(state.passwordChangeEnabled).toBe(true)
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: state.csrfToken }
}
function encoded(password: string): string {
  const result = spawnSync(process.execPath, [cli, 'web-password-hash'], { input: password, env, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-password-e2e-')); home = join(root, 'home'); hash = join(home, 'web-auth/password.hash')
  const probe = createServer()
  probe.listen(Number(process.env.DSH_PASSWORD_TEST_PORT ?? 0), '127.0.0.1')
  await once(probe, 'listening')
  port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve() }))
  await mkdir(join(home, 'web-auth'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'overlay.yml'), JSON.stringify([
    { id: 'session-telemetry-otel', disabled: true }, { id: 'public-observatory', disabled: true },
  ]))
  env = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, XDG_CACHE_HOME: join(root, 'cache'),
    DSH_WEB_AUTH: 'required', DSH_WEB_INSECURE_COOKIES: '1', DSH_WEB_ADMIN_USERNAME: 'local-test',
    DSH_WEB_ADMIN_PASSWORD_HASH_FILE: hash, DSH_WEB_PASSWORD_CHANGE_ENABLED: '1', DSH_DEPLOYMENT_SURFACE: 'cloud-web' }
  await writeFile(hash, encoded(oldPassword), { mode: 0o600 })
  await start()
}, 120_000)
afterAll(async () => { await stop(); if (root) await rm(root, { recursive: true, force: true }) })
async function rpc<T = unknown>(method: string, payload: unknown, session: Session) {
  const response = await request(`/api/${method}`, { type: 'client-request', rpcId: crypto.randomUUID(), method, payload }, session)
  expect(response.status).toBe(200)
  const body = await response.json() as { result: { ok: boolean; value: T } }
  expect(body.result.ok).toBe(true)
  return body.result.value
}
it('preserves research sessions through password change, restart and administrator recovery', async () => {
  const first = await login(); const second = await login()
  const created = await rpc<{ sessionId: string }>('session.create', {}, first)
  await rpc('session.rename', { sessionId: created.sessionId, title: '改密持久化验证' }, first)
  const change = { currentPassword: oldPassword, newPassword: nextPassword, confirmation: nextPassword }
  expect((await request('/auth/password', change)).status).toBe(401)
  expect((await request('/auth/password', change, { ...first, csrf: 'invalid' })).status).toBe(403)
  expect((await request('/auth/password', { ...change, currentPassword: 'wrong' }, first)).status).toBe(400)
  const changed = await request('/auth/password', change, first)
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchInlineSnapshot(`
    {
      "reason": "password-changed",
      "state": "signed-out",
    }
  `)
  expect((await request('/auth/session', undefined, second).then(r => r.json() as Promise<{ state: string }>)).state).toBe('signed-out')
  expect((await request('/auth/login', { username: 'local-test', password: oldPassword })).status).toBe(401)
  await stop(); await start()
  const restarted = await login(nextPassword)
  expect(JSON.stringify(await rpc('session.list', {}, restarted))).toContain(created.sessionId)
  await stop()
  const reset = await import(/* @vite-ignore */ pathToFileURL(fileURLToPath(new URL('../../../../containers/reset-web-password.mjs', import.meta.url))).href) as {
    resetPasswordRecord(home: string, record: string): Promise<void>
  }
  await reset.resetPasswordRecord(home, encoded(resetPassword))
  await start()
  const recovered = await login(resetPassword)
  expect((await request('/auth/login', { username: 'local-test', password: nextPassword })).status).toBe(401)
  expect(JSON.stringify(await rpc('session.list', {}, recovered))).toContain(created.sessionId)
  const stored = await readFile(hash, 'utf8')
  for (const secret of [oldPassword, nextPassword, resetPassword]) {
    expect(stored).not.toContain(secret); expect(log).not.toContain(secret)
  }
}, 90_000)
