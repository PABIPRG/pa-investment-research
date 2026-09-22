/** Real YAML Loader + HTTP carrier proof of public and private route isolation. */
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Observatory from '../src/index.ts'
import { BackupService } from '../../../investment-research/python-runtime/src/backup-service.ts'
import type { BackupBackendRequest } from '../../../investment-research/python-runtime/src/backup-service.ts'

const origin = 'https://pair-observe.xiexin.dev'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function composition(options: { requests?: number; total?: number; concurrent?: number; timeout?: number; large?: boolean; endpoint?: string } = {}) {
  let upstreamCalls = 0
  let pending: (() => void) | undefined
  let hold = false
  let available = true
  let large = options.large ?? false
  const backend = createServer((_req, res) => {
    upstreamCalls += 1
    const respond = (): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ availability: available ? 'available' : 'unavailable', data_revision: available ? 1 : null, ...(large ? { padding: 'x'.repeat(6 * 1024 * 1024) } : {}) }))
    }
    if (hold) pending = respond
    else respond()
  })
  await new Promise<void>((resolve, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())) })
  const endpoint = options.endpoint ?? `http://127.0.0.1:${(backend.address() as AddressInfo).port}`
  const acquire = vi.fn(() => { throw new Error('public requests must never acquire') })
  const getRunning = vi.fn(async () => ({ id: 'trading-core', baseUrl: endpoint }))
  class RuntimeFixture extends Service {
    constructor(ctx: Context) { super(ctx, 'investmentPythonRuntime') }
    acquire = acquire
    getRunningBackend = getRunning
  }
  const root = await mkdtemp(join(tmpdir(), 'observatory-loader-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config: { host: 127.0.0.1, port: 0 }',
    '- name: test:runtime',
    "- id: observatory\n  name: '@deepseek-ai/dsh-host-public-observatory'",
    '  config:',
    '    enabled: true',
    `    allowedOrigins: ['${origin}']`,
    '    trustedHosts: !!js \'["127.0.0.1:" + ctx.webServer.port]\'',
    `    requestsPerMinute: ${options.requests ?? 120}`,
    `    totalRequestsPerMinute: ${options.total ?? 600}`,
    `    maxConcurrentRequests: ${options.concurrent ?? 8}`,
    `    timeoutMs: ${options.timeout ?? 5000}`,
    '    maxResponseBytes: 8388608',
    '',
  ].join('\n'))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['test:runtime', RuntimeFixture],
    ['@deepseek-ai/dsh-host-public-observatory', Observatory],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected module: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && !entry.fiber).map(entry => entry.options.name)).toEqual([])
  ctx.webServer.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(401); res.end('auth-required') } })
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const request = (path = '/overview?date=2026-09-18', init: RequestInit = {}) => fetch(`${base}${Observatory.PUBLIC_OBSERVATORY_PREFIX}${path}`, { ...init, headers: { origin, ...init.headers } })
  return { ctx, base, request, acquire, getRunning, calls: () => upstreamCalls,
    hold: () => { hold = true }, resume: () => { hold = false; pending?.() },
    revoke: () => { available = false },
    small: () => { large = false },
  }
}

describe('public observatory Loader + real HTTP', () => {
  it.skipIf(!process.env.OBSERVATORY_TEST_PYTHON)('publishes real verified backups once after a lost ACK and private restart recovery', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'observatory-export-http-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    const coordinator = join(dshHome, 'investment-research', 'transfer-transactions')
    const backendRoot = fileURLToPath(new URL('../../../../../backend/dsh-trading-core/', import.meta.url))
    const fixture = fileURLToPath(new URL('./fixtures/public_backend.py', import.meta.url))
    const child = spawn(process.env.OBSERVATORY_TEST_PYTHON!, ['-B', fixture], {
      cwd: backendRoot,
      env: { ...process.env, PYTHONPATH: backendRoot, OBSERVATORY_TEST_OPERATIONS: '1', OBSERVATORY_TEST_EXPORT_COORDINATOR: coordinator },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanups.push(async () => {
      if (child.exitCode !== null) return
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM') })
    })
    const address = await new Promise<{ baseUrl: string; storePath: string }>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]!)) })
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Python fixture exited before readiness')))
    })
    const app = await composition({ endpoint: address.baseUrl })
    await vi.waitFor(async () => expect((await app.request('/activities?as_of=2026-09-21')).status).toBe(200))
    const before = await readFile(address.storePath)
    let loseAck = true
    const request: BackupBackendRequest = async (_backend, operation, input, signal) => {
      const exporting = operation === 'export'
      const path = exporting ? `/data-transfer/export?categories=${(input.categories as string[]).join(',')}` : `/data-transfer/${operation}`
      const response = await fetch(address.baseUrl + path, {
        method: exporting ? 'GET' : 'POST', headers: { Authorization: 'Bearer fixture-private-export-token', 'Content-Type': 'application/json' },
        ...(!exporting ? { body: JSON.stringify(input) } : {}), ...(signal ? { signal } : {}),
      })
      expect(response.status).toBe(200)
      const result = await response.json()
      if (operation === 'export-completed' && loseAck) throw new Error('simulated network loss after Python persisted')
      return result
    }
    const start = () => new BackupService({ dshHome, appVersion: 'fixture', request, now: () => new Date('2026-09-21T05:00:00Z') })
    const first = start()
    cleanups.push(() => first.dispose())
    await expect(first.create({ categories: ['holdings'], reason: 'pre-reset' })).rejects.toThrow('备份文件已生成')
    const initial = await (await app.request('/activities?as_of=2026-09-21')).json()
    expect(initial.items).toHaveLength(6)
    expect(initial.items[0].title).toBe('完成 · 重置前持仓备份')
    const detail = await (await app.request(`/activities/${initial.items[0].public_id}`)).json()
    expect(detail.summary).toContain('不表示已下载至浏览器')
    expect(detail.holdings_changes).toBeUndefined()
    expect(JSON.stringify([initial, detail])).not.toMatch(/fixture-private|archivePath|sha256|TEST-PRIVATE/)
    expect((await fetch(address.baseUrl + '/data-transfer/export-completed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
    await first.dispose()
    loseAck = false
    const restarted = start()
    cleanups.push(() => restarted.dispose())
    restarted.startExportRecovery(30_000)
    await vi.waitFor(async () => expect(await readdir(join(coordinator, 'export-receipts'))).toEqual([]))
    expect(await (await app.request('/activities?as_of=2026-09-21')).json()).toEqual(initial)
    expect(await readFile(address.storePath)).toEqual(before)
    expect(app.acquire).not.toHaveBeenCalled()
  })

  it.skipIf(!process.env.OBSERVATORY_TEST_PYTHON).each([false, true])('reads real Python projection (operations=%s) without leaking private data or changing the store', async (operations) => {
    const fixture = fileURLToPath(new URL('./fixtures/public_backend.py', import.meta.url))
    const backendRoot = fileURLToPath(new URL('../../../../../backend/dsh-trading-core/', import.meta.url))
    const child = spawn(process.env.OBSERVATORY_TEST_PYTHON!, ['-B', fixture], {
      cwd: backendRoot, env: { ...process.env, PYTHONPATH: backendRoot, OBSERVATORY_TEST_OPERATIONS: operations ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanups.push(async () => {
      if (child.exitCode !== null) return
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM') })
    })
    const address = await new Promise<{ baseUrl: string; storePath: string; snapshotId: string }>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', chunk => {
        output += String(chunk)
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]!))
      })
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Python fixture exited before readiness')))
    })
    const app = await composition({ endpoint: address.baseUrl })
    const before = await readFile(address.storePath, 'utf8')
    if (operations) {
      expect(await (await app.request('/overview?date=2026-09-21')).json()).toMatchObject({ availability: 'unavailable' })
      const activityPage = await (await app.request('/activities?as_of=2026-09-21')).json()
      expect(activityPage.items).toHaveLength(5)
      expect(activityPage.items.map((item: { status: string }) => item.status)).toEqual(['completed', 'failed', 'completed', 'completed', 'completed'])
      const detail = await (await app.request(`/activities/${activityPage.items[0].public_id}`)).json()
      expect(detail.holdings_changes).toEqual([{ ticker: '600519', before_quantity: '2', after_quantity: '0', before_cost_price: '100', after_cost_price: null }])
      expect(JSON.stringify(detail)).not.toContain('TEST-PRIVATE')
      const adjustment = await (await app.request(`/activities/${activityPage.items[4].public_id}`)).json()
      expect(adjustment.title).toBe('完成 · 持仓数据更新')
      expect(adjustment.holdings_changes).toEqual([{ ticker: '600519', before_quantity: '1', after_quantity: '3', before_cost_price: '100', after_cost_price: '100' }])
      const trades = await (await app.request(`/activities/${activityPage.items[3].public_id}`)).json()
      expect(trades.summary).toContain('新增 1 条，移除 0 条')
      expect(JSON.stringify([activityPage, adjustment, trades])).not.toContain('TEST-PRIVATE')
      const first = await (await app.request('/activities?as_of=2026-09-21&limit=2')).json()
      expect(first.items).toEqual(activityPage.items.slice(0, 2))
      const second = await (await app.request(`/activities?as_of=2026-09-21&limit=2&cursor=${first.next_cursor}`)).json()
      expect(second.items).toEqual(activityPage.items.slice(2, 4))
      const changedFilter = await app.request(`/activities?as_of=2026-09-21&status=failed&cursor=${first.next_cursor}`)
      expect(changedFilter.status).toBe(409)
      expect(changedFilter.headers.get('cache-control')).toBe('no-store')
      expect(JSON.stringify(await changedFilter.json())).toContain('cursor-expired')
      child.kill('SIGUSR1') // 私有夹具重建索引，已发出的游标必须过期。
      await vi.waitFor(async () => expect((await app.request(`/activities?as_of=2026-09-21&cursor=${first.next_cursor}`)).status).toBe(409))
      expect((await app.request('/activities?as_of=2026-09-21')).status).toBe(200)
      expect(await readFile(address.storePath, 'utf8')).toBe(before)
      expect(app.acquire).not.toHaveBeenCalled()
      return
    }
    await vi.waitFor(async () => expect((await app.request('/overview?date=2026-09-20')).status).toBe(200))
    const overview = await (await app.request('/overview?date=2026-09-20')).json()
    expect(overview.summary.total_equity).toBe('102480.00')
    expect(JSON.stringify(overview)).not.toContain('TEST-PRIVATE')
    const responses = await Promise.all([
      `/holdings?snapshot_id=${address.snapshotId}`, '/equity?from=2026-09-01&to=2026-09-20',
      '/calendar?month=2026-09', '/activities?as_of=2026-09-20',
    ].map(async path => { const response = await app.request(path); expect(response.status).toBe(200); return response.json() }))
    const activity = responses[3].items[0]
    expect(responses[3].items).toHaveLength(1)
    expect((await app.request(`/activities/${activity.public_id}`)).status).toBe(200)
    expect(JSON.stringify(responses)).not.toContain('TEST-PRIVATE')
    expect((await fetch(`${address.baseUrl}/portfolio/account-snapshots`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect(await readFile(address.storePath, 'utf8')).toBe(before)
    expect(app.acquire).not.toHaveBeenCalled()
  })

  it('loads injected Config, leaves private paths protected, honors revocation, and unregisters on disposal', async () => {
    const app = await composition()
    const initial = await app.request()
    expect(initial.status).toBe(200)
    expect(initial.headers.get('access-control-allow-origin')).toBe(origin)
    expect(initial.headers.get('cache-control')).toBe('no-store')
    expect(await initial.json()).toMatchObject({ availability: 'available' })
    expect((await fetch(`${app.base}/api/private`)).status).toBe(401)
    expect((await app.request('', { method: 'POST' })).status).toBe(405)
    expect((await app.request('/overview?date=2026-09-18', { method: 'POST' })).status).toBe(405)
    expect((await app.request('/overview?date=2026-09-18', { method: 'HEAD' })).status).toBe(200)
    app.revoke()
    const revoked = await app.request('/overview?date=2026-09-18', { headers: { 'if-none-match': initial.headers.get('etag')! } })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ availability: 'unavailable' })
    expect(app.acquire).not.toHaveBeenCalled()
    expect(app.getRunning).toHaveBeenCalled()
    const entry = [...app.ctx.loader.entries()].find(entry => entry.options.id === 'observatory')!
    await entry.fiber!.dispose()
    expect((await app.request()).status).toBe(401)
  })

  it.each([{ requests: 1 }, { total: 1 }])('limits HTTP requests with %j and keeps denial readable', async (options) => {
    const app = await composition(options)
    expect((await app.request()).status).toBe(200)
    const blocked = await app.request()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('access-control-allow-origin')).toBe(origin)
    expect(blocked.headers.get('cache-control')).toBe('no-store')
    expect(app.calls()).toBe(1)
  })

  it('rejects concurrent excess and frees capacity after completion', async () => {
    const app = await composition({ concurrent: 1 })
    app.hold()
    const first = app.request()
    await vi.waitFor(() => expect(app.calls()).toBe(1))
    expect((await app.request()).status).toBe(429)
    app.resume()
    expect((await first).status).toBe(200)
    expect((await app.request()).status).toBe(200)
    expect(app.calls()).toBe(2)
  })

  it('keeps slow response sends within concurrency and closes them on deadline', async () => {
    const app = await composition({ concurrent: 1, timeout: 400, large: true })
    const address = new URL(app.base)
    const socket = connect({ host: address.hostname, port: Number(address.port) })
    cleanups.push(async () => { socket.destroy() })
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    socket.pause()
    socket.write(`GET ${Observatory.PUBLIC_OBSERVATORY_PREFIX}/overview?date=2026-09-18 HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${origin}\r\nConnection: close\r\n\r\n`)
    await vi.waitFor(() => expect(app.calls()).toBe(1))
    await delay(120)
    app.small()
    expect((await app.request()).status).toBe(429)
    await delay(500)
    expect((await app.request()).status).toBe(200)
  })
})
