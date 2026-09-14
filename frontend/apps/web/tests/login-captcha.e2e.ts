import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Real published CLI + shipped Web profile, isolated process and data. No model calls.
const cli = fileURLToPath(new URL('../../cli/lib/bin.js', import.meta.url))
const snapshot = fileURLToPath(new URL('./snapshots/login-captcha/ui.expected.md', import.meta.url))
const origin = 'http://127.0.0.1:3281'
const password = 'Captcha-UAT-2026-local'
let root: string
let child: ChildProcess
let browser: Browser
let page: Page
let log = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-login-captcha-e2e-'))
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(root, 'home'),
    XDG_CACHE_HOME: join(root, 'cache'), DSH_DEPLOYMENT_SURFACE: 'cloud-web', DSH_WEB_AUTH: 'required',
    DSH_WEB_INSECURE_COOKIES: '1', DSH_WEB_ADMIN_USERNAME: 'uat-admin', DSH_WEB_ADMIN_PASSWORD_HASH_FILE: join(root, 'password.hash') }
  const hash = spawnSync(process.execPath, [cli, 'web-password-hash'], { input: password, env, encoding: 'utf8' })
  expect(hash.status, hash.stderr).toBe(0)
  await writeFile(env.DSH_WEB_ADMIN_PASSWORD_HASH_FILE, hash.stdout.trim(), { mode: 0o600 })
  const overlay = join(root, 'quiet.yml')
  await writeFile(overlay, '- id: session-telemetry-otel\n  disabled: true\n')
  child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', overlay, '--port', '3281', '--host', '127.0.0.1'], { cwd: root, env })
  child.stdout?.on('data', chunk => { log += String(chunk) })
  child.stderr?.on('data', chunk => { log += String(chunk) })
  await vi.waitFor(async () => {
    if (child.exitCode !== null) throw new Error(log)
    expect(log).toContain(origin)
    expect((await fetch(`${origin}/healthz`)).status).toBe(200)
  }, { timeout: 60_000, interval: 250 })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
})

afterAll(async () => {
  await browser?.close()
  if (child !== undefined && child.exitCode === null) {
    const closed = once(child, 'exit')
    child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await closed; clearTimeout(timeout)
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('cloud-web adaptive captcha through the published entry', () => {
  it('preserves keyboard login, trusted session, CSRF and logout before triggering the captcha', async () => {
    await page.goto(origin)
    await page.getByLabel('用户名', { exact: true }).fill('uat-admin')
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByLabel('密码', { exact: true }).press('Enter')
    await expect.poll(async () => await page.getByRole('heading', { name: '管理员登录' }).count()).toBe(0)
    const session = await page.request.get(`${origin}/auth/session`)
    const state = await session.json() as { state: string; csrfToken: string }
    expect(state.state).toBe('signed-in')
    expect((await page.request.post(`${origin}/auth/logout`)).status()).toBe(403)
    expect((await page.request.post(`${origin}/auth/logout`, { headers: { 'x-dsh-csrf': state.csrfToken } })).status()).toBe(200)
    await page.reload()
    await page.getByRole('heading', { name: '管理员登录' }).waitFor()
  })

  it('shows the challenge after two failures, refreshes with keyboard, and persists the requirement across reload', async () => {
    await page.getByLabel('用户名', { exact: true }).fill('uat-admin')
    await page.getByLabel('密码', { exact: true }).fill('wrong-password')
    await page.getByLabel('密码', { exact: true }).press('Enter')
    await page.getByText('用户名或密码不正确，请重试。', { exact: true }).waitFor()
    expect(await page.getByLabel('验证码', { exact: true }).count()).toBe(0)
    await page.getByLabel('密码', { exact: true }).press('Enter')
    await page.getByLabel('验证码', { exact: true }).waitFor()
    await expect.poll(() => page.getByLabel('验证码', { exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
    const image = page.getByRole('img', { name: '登录验证码，6 位数字' })
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(216)
    const oldImage = await image.getAttribute('src')
    const aria = await page.locator('main').ariaSnapshot()
    const normalized = `${aria.trim()}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await mkdir(fileURLToPath(new URL('./snapshots/login-captcha', import.meta.url)), { recursive: true })
      await writeFile(snapshot, normalized)
    } else expect(normalized).toBe(await readFile(snapshot, 'utf8'))
    // Refresh admission interval is an intentional server security control.
    await new Promise(resolve => setTimeout(resolve, 1_050))
    await page.getByLabel('验证码', { exact: true }).press('Shift+Tab')
    expect(await page.getByRole('button', { name: '换一张' }).evaluate(el => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await expect.poll(() => image.getAttribute('src')).not.toBe(oldImage)
    await expect.poll(() => page.getByLabel('验证码', { exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
    await page.getByLabel('验证码', { exact: true }).fill('000000')
    await page.getByLabel('验证码', { exact: true }).press('Enter')
    await page.getByText('验证码不正确，图片已更新，请重试。', { exact: true }).waitFor()
    expect((await page.request.get(`${origin}/auth/boot`)).status()).toBe(401)
    await new Promise(resolve => setTimeout(resolve, 1_050))
    await page.reload()
    await page.getByLabel('验证码', { exact: true }).waitFor()
    await expect.poll(() => page.getByRole('img', { name: '登录验证码，6 位数字' }).count()).toBe(1)
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.getByRole('button', { name: '换一张' }).isVisible()).toBe(true)
    }
    for (let n = 0; n < 2; n++) await page.request.post(`${origin}/auth/login`, { data: { username: 'uat-admin', password } })
    expect((await page.request.post(`${origin}/auth/login`, { data: { username: 'uat-admin', password } })).status()).toBe(429)
  })

  it('renders light and dark captcha states across supported widths and exposes expiry', async () => {
    const evidence = process.env.DSH_CAPTCHA_EVIDENCE_DIR
    if (evidence !== undefined) await mkdir(evidence, { recursive: true })
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme, locale: 'zh-CN' })
      const visual = await context.newPage()
      await visual.clock.install()
      try {
        await new Promise(resolve => setTimeout(resolve, 1_050))
        await visual.goto(origin)
        await visual.getByRole('img', { name: '登录验证码，6 位数字' }).waitFor()
        expect(await visual.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
        for (const width of [1440, 1024, 768, 390]) {
          await visual.setViewportSize({ width, height: 1000 })
          expect(await visual.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          if (evidence !== undefined) await visual.screenshot({ path: join(evidence, `${colorScheme}-${width}.png`), fullPage: true })
        }
        await visual.clock.fastForward(120_001)
        await visual.getByText('验证码已过期，请使用新图片；若未更新，请点击换一张。', { exact: true }).waitFor()
        expect(await visual.getByRole('button', { name: '登录', exact: true }).isEnabled()).toBe(false)
      } finally { await context.close() }
    }
  })

})
