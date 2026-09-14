import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebAuthService, hashPassword, type WebAuthConfig } from '../src/index.ts'
import { createCaptcha, verifyCaptcha } from '../src/captcha.ts'

// Mock only nondeterministic digit selection, preserving real entropy for opaque IDs.
vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>()
  return { ...original, randomInt: (min: number, max?: number) => max === 10 ? 2 : max === undefined ? 0 : min }
})
const contexts: Context[] = []
const directory = mkdtempSync(join(tmpdir(), 'dsh-captcha-test-'))
const passwordHashFile = join(directory, 'password.hash')
writeFileSync(passwordHashFile, hashPassword('correct horse battery staple'), { mode: 0o600 })
const facts = (address = '192.0.2.1') => ({ socket: { remoteAddress: '127.0.0.1' },
  headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': address } })
function service(extra: Partial<WebAuthConfig> = {}) {
  const ctx = new Context(); contexts.push(ctx)
  return new WebAuthService(ctx, { mode: 'required', username: 'admin', passwordHashFile,
    trustedProxyAddresses: ['127.0.0.1'], ...extra })
}
afterEach(async () => { vi.useRealTimers(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
async function requireCaptcha(auth: WebAuthService, address = '192.0.2.1') {
  expect(await auth.login('admin', 'wrong', facts(address))).toMatchObject({ code: 'invalid-credentials' })
  const result = await auth.login('unknown', 'wrong', facts(address))
  expect(result).toMatchObject({ code: 'invalid-credentials', captcha: { image: expect.stringMatching(/^data:image\/png;base64,/) } })
  return result.captcha!
}

describe('adaptive local captcha', () => {
  it('issues opaque unpredictable single-use PNG challenges without plaintext metadata', () => {
    const first = createCaptcha(); const second = createCaptcha()
    expect(first.view.id).not.toBe(second.view.id)
    expect(Object.keys(first.view).sort()).toEqual(['expiresAt', 'id', 'image'])
    expect(JSON.stringify(first)).not.toContain('222222')
    const bytes = Buffer.from(first.view.image.split(',')[1]!, 'base64')
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(bytes.includes(Buffer.from('tEXt'))).toBe(false)
    expect(verifyCaptcha(first.record, { id: first.view.id, answer: '222222' })).toBe(true)
    expect(verifyCaptcha(first.record, { id: second.view.id, answer: '222222' })).toBe(false)
  })

  it('requires a challenge after two failures even for correct credentials, then clears state on success', async () => {
    const auth = service()
    expect(auth.sessionState(facts())).toEqual({ state: 'signed-out' })
    const first = await requireCaptcha(auth)
    expect(auth.sessionState(facts())).toMatchObject({ captchaRequired: true })
    const missing = await auth.login('admin', 'correct horse battery staple', facts())
    expect(missing).toMatchObject({ code: 'captcha-required' })
    expect(missing.captcha!.id).not.toBe(first.id)
    const old = await auth.login('admin', 'correct horse battery staple', facts(), { id: first.id, answer: '222222' })
    expect(old).toMatchObject({ code: 'captcha-invalid' })
    const success = await auth.login('admin', 'correct horse battery staple', facts(), { id: old.captcha!.id, answer: '222222' })
    expect(success.ok).toBe(true)
    expect(auth.sessionState(facts())).toEqual({ state: 'signed-out' })
    expect(auth.challenge(facts())).toEqual({ ok: true })
  })

  it('binds proofs to trusted client IP and rejects mismatched answers without password work', async () => {
    const auth = service()
    const a = await requireCaptcha(auth)
    await requireCaptcha(auth, '192.0.2.2')
    const wrongIP = await auth.login('admin', 'correct horse battery staple', facts('192.0.2.2'), { id: a.id, answer: '222222' })
    expect(wrongIP).toMatchObject({ code: 'captcha-invalid' })
    const wrong = await auth.login('admin', 'correct horse battery staple', facts(), { id: a.id, answer: '333333' })
    expect(wrong).toMatchObject({ code: 'captcha-invalid' })
    expect((await auth.login('admin', 'correct horse battery staple', facts(), { id: a.id, answer: '222222' })))
      .toMatchObject({ code: 'captcha-invalid' })
  })

  it('rotates on refresh and password failure, throttles refresh, and expires proactively', async () => {
    vi.useFakeTimers()
    const auth = service()
    const a = await requireCaptcha(auth)
    expect(auth.challenge(facts())).toMatchObject({ code: 'rate-limited' })
    vi.advanceTimersByTime(1_001)
    const b = auth.challenge(facts()).captcha!
    expect(b.id).not.toBe(a.id)
    const invalid = await auth.login('admin', 'wrong', facts(), { id: b.id, answer: '222222' })
    expect(invalid).toMatchObject({ code: 'invalid-credentials' })
    expect(invalid.captcha!.id).not.toBe(b.id)
    vi.advanceTimersByTime(120_001)
    expect(await auth.login('admin', 'correct horse battery staple', facts(), { id: invalid.captcha!.id, answer: '222222' }))
      .toMatchObject({ code: 'captcha-expired' })
    vi.advanceTimersByTime(600_001)
    expect(auth.sessionState(facts())).toEqual({ state: 'signed-out' })
  })

  it('counts captcha rejects toward five attempts per minute and cannot reset the observation window by refreshing', async () => {
    vi.useFakeTimers()
    const auth = service()
    await requireCaptcha(auth)
    for (let n = 0; n < 3; n++) expect(await auth.login('admin', 'wrong', facts())).toMatchObject({ code: 'captcha-required' })
    expect(await auth.login('admin', 'wrong', facts())).toMatchObject({ code: 'rate-limited' })
    vi.advanceTimersByTime(60_001)
    expect(await auth.login('admin', 'correct horse battery staple', facts())).toMatchObject({ code: 'captcha-required' })
  })

  it('reserves client capacity and serializes an identity before asynchronous verification', async () => {
    const auth = service({ loginMaxTrackedAddresses: 1 })
    const first = auth.login('admin', 'wrong', facts())
    expect(await auth.login('admin', 'wrong', facts())).toMatchObject({ code: 'rate-limited' })
    expect(await auth.login('admin', 'wrong', facts('192.0.2.2'))).toMatchObject({ code: 'rate-limited' })
    await first
    const second = auth.login('admin', 'wrong', facts())
    expect(await auth.login('admin', 'correct horse battery staple', facts())).toMatchObject({ code: 'rate-limited' })
    await second
    expect(await auth.login('admin', 'correct horse battery staple', facts())).toMatchObject({ code: 'captcha-required' })
  })

  it('allows at most four simultaneous KDFs and consumes a proof before the await', async () => {
    const auth = service()
    const captcha = await requireCaptcha(auth)
    const pending = auth.login('admin', 'correct horse battery staple', facts(), { id: captcha.id, answer: '222222' })
    expect(await auth.login('admin', 'correct horse battery staple', facts(), { id: captcha.id, answer: '222222' }))
      .toMatchObject({ code: 'rate-limited' })
    const others = [2, 3, 4].map(n => auth.login('admin', 'wrong', facts(`192.0.2.${n}`)))
    expect(await auth.login('admin', 'wrong', facts('192.0.2.5'))).toMatchObject({ code: 'rate-limited' })
    expect((await pending).ok).toBe(true)
    await Promise.all(others)
  })

  it('does not create a session when the authentication plugin is disposed during verification', async () => {
    const auth = service()
    const pending = auth.login('admin', 'correct horse battery staple', facts())
    await contexts.at(-1)!.fiber.dispose()
    expect(await pending).toMatchObject({ code: 'auth-unavailable' })
    expect(await auth.login('admin', 'correct horse battery staple', facts())).toMatchObject({ code: 'auth-unavailable' })
  })

})
