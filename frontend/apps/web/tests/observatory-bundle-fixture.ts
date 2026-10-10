import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type Page } from 'playwright'
import { preview, type PreviewServer } from 'vite'

const appRoot = fileURLToPath(new URL('../../public-observatory/', import.meta.url))
const backendRoot = fileURLToPath(new URL('../../../../backend/dsh-trading-core/', import.meta.url))
export const evidenceDir = process.env.OBSERVATORY_UAT_DIR ?? '/private/tmp/observatory-f6a0-uat'
const port = Number(process.env.OBSERVATORY_UAT_PORT ?? 3418)
const apiPort = Number(process.env.OBSERVATORY_UAT_API_PORT ?? 3419)
export const origin = `http://127.0.0.1:${port}`
export const apiOrigin = `http://127.0.0.1:${apiPort}`
let backend: ChildProcess
let app: PreviewServer
let browser: Browser
export let page: Page
export const requests: string[] = []
export const errors: string[] = []
export const control = async (value: object) => { const response = await fetch(`${apiOrigin}/__fixture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); if (!response.ok) throw new Error('fixture control failed') }
export const settled = async () => { await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator]').length > 0 && document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0) }
export const seek = () => page.getByRole('slider', { name: '跳转历史播放日期' })
export async function start() {
  await mkdir(evidenceDir, { recursive: true })
  backend = spawn(process.env.OBSERVATORY_TEST_PYTHON ?? 'python3', ['tests/fixtures/observatory_bundle_server.py', String(apiPort), String(port)], { cwd: backendRoot, env: { PATH: process.env.PATH, PYTHONPATH: backendRoot, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  backend.stdout?.on('data', (chunk) => { log += String(chunk) }); backend.stderr?.on('data', (chunk) => { log += String(chunk) })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (backend.exitCode !== null) throw new Error(`fixture exited: ${log}`)
    try { ready = (await fetch(`${apiOrigin}/__fixture`)).ok } catch { /* Wait for this local fixture only. */ }
    if (ready) break
    await delay(100)
  }
  if (!ready) throw new Error(`fixture not ready: ${log}`)
  app = await preview({ root: appRoot, preview: { host: '127.0.0.1', port, strictPort: true } })
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1024, height: 879 }, reducedMotion: 'reduce', colorScheme: 'light' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', (request) => { if (request.url().includes('/api/public/')) requests.push(request.url()) })
  await page.route('**/*', route => [origin, apiOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
  await page.clock.install({ time: new Date('2026-10-10T06:00:00Z') })
  await page.goto(origin); await settled()
}
export async function stop(suite = 'timeline') {
  await writeFile(join(evidenceDir, `requests-${suite}.json`), JSON.stringify({ requests, errors }, null, 2))
  await browser?.close()
  if (app) await new Promise<void>(resolve => app.httpServer.close(() => { resolve() }))
  if (backend && backend.exitCode === null) { const done = once(backend, 'exit'); backend.kill('SIGTERM'); await done }
}

export async function refresh(label = '刷新数据') {
  await Promise.all([page.waitForResponse(response => response.url().includes('/bundle?')), page.getByRole('button', { name: label, exact: true }).click()])
  await settled()
}
