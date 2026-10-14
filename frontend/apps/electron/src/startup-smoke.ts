/** Opt-in acceptance of the installed application, using only a disposable smoke home. */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import type { InvestmentPythonRuntime } from '@deepseek-ai/dsh-investment-python-runtime'

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

/**
 * Configure an isolated application home before Electron takes its instance lock.
 * @returns explicitly opted-in smoke directory, or undefined for normal launches.
 */
export function configureStartupSmoke(): string | undefined {
  if (process.env.DSH_DESKTOP_SMOKE !== '1') return undefined
  const root = process.env.DSH_DESKTOP_SMOKE_ROOT
  assert(root && isAbsolute(root), 'desktop smoke requires an absolute temporary root')
  assert.equal(process.env.DSH_HOME, join(root, 'dsh-home'), 'desktop smoke must use its own DSH_HOME')
  for (const name of ['userData', 'logs']) {
    const directory = join(root, name)
    mkdirSync(directory, { recursive: true })
    app.setPath(name, directory)
  }
  return root
}

/**
 * Persist a smoke startup milestone immediately, even if the process later hangs.
 * @param root - isolated root returned by configureStartupSmoke; undefined disables tracing.
 * @param stage - fixed application lifecycle milestone, never environment or business data.
 */
export function recordStartupSmokePhase(root: string | undefined, stage: string): void {
  if (root === undefined) return
  appendFileSync(join(root, 'startup-phases.log'), `${JSON.stringify({
    at: new Date().toISOString(), pid: process.pid,
    iteration: process.env.DSH_DESKTOP_SMOKE_ITERATION, stage,
  })}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Exercise real bundled backends and persisted data after the real renderer loads.
 * @param root - isolated acceptance root selected before application startup.
 * @param window - production application window.
 * @param ctx - production profile context.
 */
export async function runStartupSmoke(root: string, window: BrowserWindow, ctx: Context): Promise<void> {
  assert(app.isPackaged, 'desktop acceptance must run the packaged executable')
  const runtime: InvestmentPythonRuntime | undefined = ctx.get('investmentPythonRuntime')
  assert(runtime, 'investment runtime is missing')
  const readiness = runtime.readiness()
  assert.equal(readiness.runtimeAsset.status, 'bundled-ready')
  const backends: unknown[] = []
  for (const id of ['trading-core', 'market-watch', 'industry-chain'] as const) {
    const lease = await runtime.acquire(id)
    try {
      assert.equal(lease.ownership, 'owned', `${id} was attached to another process`)
      const response = await fetch(`${lease.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) })
      assert(response.ok)
      const health = record(await response.json())
      assert.equal(health.service, id)
      assert.equal(typeof health.runtimeInstance, 'string')
      const state = record(JSON.parse(await readFile(join(root, 'dsh-home', 'investment-research', id, 'runtime.json'), 'utf8')))
      backends.push({ id, baseUrl: lease.baseUrl, pid: state.pid, runtimeInstance: health.runtimeInstance, projectDir: state.projectDir })
    } finally { await lease.release() }
  }
  const requests = []
  for (const operation of ['trading-core.reports', 'market-watch.watchlist', 'industry-chain.data-status'] as const) {
    requests.push({ operation, result: await runtime.requestData({ operation }) })
  }
  const market = await runtime.acquire('market-watch')
  const iteration = process.env.DSH_DESKTOP_SMOKE_ITERATION
  try {
    const response = await fetch(`${market.baseUrl}/alerts`, { signal: AbortSignal.timeout(5_000) })
    assert(response.ok)
    const alerts = await response.json() as { items: { name: string; id: string }[] }
    const marker = alerts.items.find(item => item.name === '桌面启动验收')
    if (iteration === '1') {
      assert.equal(marker, undefined, 'first launch must use empty test data')
      const saved = await fetch(`${market.baseUrl}/alerts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ name: '桌面启动验收', enabled: false, conditions: [{ field: 'price', operator: '>', value: 1 }] }),
      })
      assert(saved.ok, 'disabled alert persistence failed')
    } else {
      assert.equal(iteration, '2')
      assert(marker, 'second launch lost persisted user data')
    }
  } finally { await market.release() }
  const deadline = Date.now() + 20_000
  let rendered = false
  while (Date.now() < deadline) {
    rendered = await window.webContents.executeJavaScript('document.body.innerText.includes("研究工作台")') as boolean
    if (rendered) break
    await delay(100)
  }
  assert(rendered, 'investment renderer did not mount its navigation')
  await writeFile(join(root, `window-${iteration}.png`), (await window.webContents.capturePage()).toPNG())
  await writeFile(join(root, `result-${iteration}.json`), JSON.stringify({
    status: 'passed', version: app.getVersion(), url: window.webContents.getURL(),
    readiness, backends, requests, iteration,
  }, null, 2))
}
