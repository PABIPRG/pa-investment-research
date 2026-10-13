import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebAuthService, hashPassword, verifyPassword } from '../src/index.ts'
import type { WebAuthConfig } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const oldPassword = 'old testing password'
const nextPassword = 'new testing password'
const request = (headers: Record<string, string> = {}, method = 'POST') => ({ headers, method, socket: { remoteAddress: '127.0.0.1' } })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'password-change-')); roots.push(directory)
  const passwordHashFile = join(directory, 'password.hash')
  writeFileSync(passwordHashFile, hashPassword(oldPassword), { mode: 0o600 })
  const config: WebAuthConfig = { mode: 'required', username: 'alice', passwordHashFile, passwordChangeEnabled: true, secureCookies: false }
  return { config, passwordHashFile, directory }
}
function service(config: WebAuthConfig) { const ctx = new Context(); contexts.push(ctx); return new WebAuthService(ctx, config) }
async function signed(auth: WebAuthService) {
  const login = await auth.login('alice', oldPassword, request())
  expect(login.ok).toBe(true)
  return request({ cookie: `${auth.cookieName}=${login.token}`, 'x-dsh-csrf': login.session!.csrfToken })
}
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('self-service password change', () => {
  it('persists a new password, revokes every old session and closes bound connections', async () => {
    const { config, passwordHashFile } = fixture(); const auth = service(config)
    const first = await signed(auth); const second = await signed(auth)
    const destroy = vi.fn(); auth.trackSocket({ ...second, method: 'GET' }, { destroy, once() {} })
    expect(await auth.changePassword(oldPassword, nextPassword, nextPassword, first)).toEqual({ ok: true })
    expect(destroy).toHaveBeenCalledOnce()
    expect(auth.authorize(first).ok).toBe(false); expect(auth.authorize(second).ok).toBe(false)
    expect(verifyPassword(nextPassword, readFileSync(passwordHashFile, 'utf8'))).toBe(true)
    expect(statSync(passwordHashFile).mode & 0o077).toBe(0)
    expect((await auth.login('alice', oldPassword, request())).ok).toBe(false)
    expect((await service(config).login('alice', nextPassword, request())).ok).toBe(true)
  })
  it('rejects missing session, missing CSRF, wrong current password and invalid new values without a write', async () => {
    const { config, passwordHashFile } = fixture(); const auth = service(config); const signedIn = await signed(auth)
    const before = readFileSync(passwordHashFile, 'utf8')
    expect(await auth.changePassword(oldPassword, nextPassword, nextPassword, request())).toMatchObject({ status: 401 })
    expect(await auth.changePassword(oldPassword, nextPassword, nextPassword, request({ cookie: signedIn.headers.cookie! }))).toMatchObject({ code: 'csrf-invalid' })
    expect(await auth.changePassword('wrong', nextPassword, nextPassword, signedIn)).toMatchObject({ code: 'current-password-invalid' })
    expect(await auth.changePassword(oldPassword, 'short', 'short', signedIn)).toMatchObject({ code: 'password-weak' })
    expect(await auth.changePassword(oldPassword, nextPassword, 'different', signedIn)).toMatchObject({ code: 'password-mismatch' })
    expect(await auth.changePassword(oldPassword, oldPassword, oldPassword, signedIn)).toMatchObject({ code: 'password-unchanged' })
    expect(readFileSync(passwordHashFile, 'utf8')).toBe(before)
    expect(auth.authorize(signedIn).ok).toBe(true)
  })
  it('does not change credentials in disabled or read-only deployments', async () => {
    const { config } = fixture(); const auth = service({ ...config, passwordChangeEnabled: false })
    expect(await auth.changePassword(oldPassword, nextPassword, nextPassword, await signed(auth))).toMatchObject({ code: 'password-change-disabled' })
    expect(await service({ mode: 'disabled' }).changePassword(oldPassword, nextPassword, nextPassword, request())).toMatchObject({ code: 'password-change-disabled' })
  })
  it('keeps old credentials and sessions on unsafe storage failure', async () => {
    const { config, directory, passwordHashFile } = fixture(); const auth = service(config); const signedIn = await signed(auth)
    chmodSync(directory, 0o755)
    expect(await auth.changePassword(oldPassword, nextPassword, nextPassword, signedIn)).toMatchObject({ code: 'password-save-failed' })
    expect(auth.authorize(signedIn).ok).toBe(true)
    expect(verifyPassword(oldPassword, readFileSync(passwordHashFile, 'utf8'))).toBe(true)
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves the old record when the private directory is not writable', async () => {
    const { config, directory, passwordHashFile } = fixture(); const auth = service(config); const signedIn = await signed(auth)
    chmodSync(directory, 0o500)
    try {
      expect(await auth.changePassword(oldPassword, nextPassword, nextPassword, signedIn)).toMatchObject({ code: 'password-save-failed' })
      expect(auth.authorize(signedIn).ok).toBe(true)
      expect(verifyPassword(oldPassword, readFileSync(passwordHashFile, 'utf8'))).toBe(true)
    } finally { chmodSync(directory, 0o700) }
  })
  it('serializes competing changes and rejects logins while changing', async () => {
    const { config } = fixture(); const auth = service(config); const signedIn = await signed(auth)
    const changing = auth.changePassword(oldPassword, nextPassword, nextPassword, signedIn)
    expect(await auth.changePassword(oldPassword, 'another new password', 'another new password', signedIn)).toMatchObject({ code: 'rate-limited' })
    expect((await auth.login('alice', oldPassword, request())).ok).toBe(false)
    expect(await changing).toEqual({ ok: true })
  })
  it('limits current-password guesses across re-logins and leaves other instances untouched', async () => {
    const a = service(fixture().config); const b = service(fixture().config)
    const aSession = await signed(a); const bSession = await signed(b)
    for (let i = 0; i < 5; i++) await a.changePassword('wrong', nextPassword, nextPassword, aSession)
    expect(await a.changePassword(oldPassword, nextPassword, nextPassword, aSession)).toMatchObject({ code: 'rate-limited' })
    expect(b.authorize(bSession).ok).toBe(true)
    expect(await b.changePassword(oldPassword, nextPassword, nextPassword, bSession)).toEqual({ ok: true })
  })
  it('rejects in-flight old logins and a change whose session was logged out', async () => {
    const { config, passwordHashFile } = fixture(); const auth = service(config); const signedIn = await signed(auth)
    const loggingIn = auth.login('alice', oldPassword, request())
    const changing = auth.changePassword(oldPassword, nextPassword, nextPassword, signedIn)
    expect((await loggingIn).ok).toBe(false)
    expect(await changing).toEqual({ ok: true })
    const auth2 = service(config)
    const login = await auth2.login('alice', nextPassword, request())
    const session = request({ cookie: `${auth2.cookieName}=${login.token}`, 'x-dsh-csrf': login.session!.csrfToken })
    const pending = auth2.changePassword(nextPassword, 'third test password', 'third test password', session)
    auth2.logout(session)
    expect(await pending).toMatchObject({ code: 'password-change-expired' })
    expect(verifyPassword(nextPassword, readFileSync(passwordHashFile, 'utf8'))).toBe(true)
  })

})
