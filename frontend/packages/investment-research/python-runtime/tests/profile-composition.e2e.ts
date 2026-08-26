import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { composeEntries, loadOverlayPatches, renderConfigDump } from '@deepseek-ai/dsh-app-boot'
import InvestmentPythonRuntime, { checkBackendHealth } from '../src/index.ts'
import type { InvestmentBackendId } from '../src/types.ts'
import * as StockAnalysis from '../../stock-analysis/src/index.ts'
import * as MarketWatch from '../../market-watch/src/index.ts'

const python = process.env.DSH_INVESTMENT_TEST_PYTHON
const fixture = fileURLToPath(new URL('./fixtures/fake-project/', import.meta.url))
const execFileAsync = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []
const DEEPSEEK_API_KEY = 'DEEPSEEK_API_KEY' as CredentialRef
const CANARY = 'sk-dsh-secret-canary-profile-restart'

class TestCredentials extends CredentialProvider {
  readonly resolveCalls: CredentialRef[] = []
  readonly describeCalls: CredentialRef[] = []

  constructor(ctx: Context, private value: string | undefined) {
    super(ctx)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    this.resolveCalls.push(ref)
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'test' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    this.describeCalls.push(ref)
    return Promise.resolve({
      configured: this.value !== undefined,
      ...(this.value === undefined ? {} : { source: 'test' }),
      writable: true,
    })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.value = value
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.value = undefined
    this.notifyUpdated(ref)
    return Promise.resolve()
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function importLocalRuntime(): Promise<typeof import('../../../subprocess/subprocess-local/src/index.ts')> {
  const dlopen: typeof process.dlopen = process.dlopen.bind(process)
  process.dlopen = ((module, filename, flags) => {
    if (filename.includes('node-pty') && filename.endsWith('.node')) {
      (module as { exports: unknown }).exports = {}
      return
    }
    dlopen(module, filename, flags)
  })
  try {
    return await import('../../../subprocess/subprocess-local/src/index.ts')
  } finally {
    process.dlopen = dlopen
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate port')
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  }))
  return address.port
}

async function createProject(root: string, name: string): Promise<string> {
  if (python === undefined) throw new Error('DSH_INVESTMENT_TEST_PYTHON is required')
  const project = join(root, name)
  await cp(fixture, project, { recursive: true })
  await execFileAsync(python, ['-m', 'venv', join(project, 'env')])
  return project
}

async function mount(config: string, credential?: string): Promise<Context> {
  const root = roots.at(-1)
  if (root === undefined) throw new Error('a profile test root must be created before mounting')
  const configPath = join(root, `cordis-${contexts.length}.yml`)
  await writeFile(configPath, config)
  const { default: LocalSubprocessRuntime } = await importLocalRuntime()
  const ctx = new Context()
  contexts.push(ctx)
  new TestCredentials(ctx, credential)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-investment-python-runtime', InvestmentPythonRuntime],
    ['@deepseek-ai/dsh-investment-stock-analysis', StockAnalysis],
    ['@deepseek-ai/dsh-investment-market-watch', MarketWatch],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function backendReadiness(ctx: Context, backendId: InvestmentBackendId) {
  const backend = ctx.investmentPythonRuntime.readiness().backends.find(candidate => candidate.backendId === backendId)
  if (backend === undefined) throw new Error(`missing readiness for ${backendId}`)
  return backend
}

function composition(options: {
  home: string
  tradingUrl: string
  marketUrl: string
  mode: 'managed' | 'external'
  tradingProject?: string
  marketProject?: string
}): string {
  return [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-investment-python-runtime'",
    '  config:',
    `    dshHome: ${JSON.stringify(options.home)}`,
    '    startupTimeoutMs: 10000',
    '    healthPollMs: 20',
    '    shutdownGraceMs: 2000',
    "- name: '@deepseek-ai/dsh-investment-stock-analysis'",
    '  config:',
    `    backendMode: ${options.mode}`,
    `    backendBaseUrl: ${options.tradingUrl}`,
    ...options.tradingProject === undefined ? [] : [`    backendProjectDir: ${JSON.stringify(options.tradingProject)}`],
    "- name: '@deepseek-ai/dsh-investment-market-watch'",
    '  config:',
    `    backendMode: ${options.mode}`,
    `    backendBaseUrl: ${options.marketUrl}`,
    ...options.marketProject === undefined ? [] : [`    backendProjectDir: ${JSON.stringify(options.marketProject)}`],
    '',
  ].join('\n')
}

async function listen(service: 'trading-core' | 'market-watch' | 'industry-chain' | 'unknown'): Promise<string> {
  const server = createServer((request, response) => {
    const health = service === 'trading-core'
      ? { service, status: 'ok' }
      : service === 'market-watch' || service === 'industry-chain' ? { service, ok: true } : { service }
    const payload = request.url === '/health'
      ? health
      : service === 'trading-core'
        ? { tickers: ['AAPL'] }
        : { items: [{ code: '000001', name: '平安银行' }], count: 1 }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to listen')
  return `http://127.0.0.1:${address.port}`
}

describe.skipIf(python === undefined)('investment profile composition', () => {
  it('mounts two managed projects, executes both tool families, and removes one business bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh profile 投研 '))
    roots.push(root)
    const [tradingProject, marketProject] = await Promise.all([
      createProject(root, 'trading project'),
      createProject(root, 'market project'),
    ])
    const [tradingPort, marketPort] = await Promise.all([freePort(), freePort()])
    const config = composition({
      home: join(root, 'dsh home'),
      tradingUrl: `http://127.0.0.1:${tradingPort}`,
      marketUrl: `http://127.0.0.1:${marketPort}`,
      mode: 'managed',
      tradingProject,
      marketProject,
    })
    const ctx = await mount(config)

    expect(ctx.tools.schemas()).toHaveLength(21)
    const tradingReadiness = backendReadiness(ctx, 'trading-core')
    const marketReadiness = backendReadiness(ctx, 'market-watch')
    expect(tradingReadiness.backendStatus).toBe('healthy-owned')
    expect(tradingReadiness.capability?.toolCount).toBe(10)
    expect(tradingReadiness.capability?.status).toBe('unavailable')
    expect(tradingReadiness.restartRequired).toBe(false)
    expect(marketReadiness.backendStatus).toBe('healthy-owned')
    expect(marketReadiness.capability?.toolCount).toBe(11)
    expect(marketReadiness.capability?.status).toBe('market-template-only')
    expect(marketReadiness.restartRequired).toBe(false)
    const signal = new AbortController().signal
    await expect(ctx.tools.execute({ signal, callId: CallId('stock-watchlist'), name: 'get_watchlist', arguments: {} }))
      .resolves.toMatchObject({ isError: false, value: { tickers: ['AAPL'] } })
    await expect(ctx.tools.execute({ signal, callId: CallId('market-watchlist'), name: 'watch_list', arguments: {} }))
      .resolves.toMatchObject({
        isError: false,
        value: { items: [{ code: '000001', name: '平安银行' }], count: 1 },
      })

    const credentials = ctx.credentials as TestCredentials
    await credentials.set(DEEPSEEK_API_KEY, CANARY)
    expect(backendReadiness(ctx, 'trading-core').restartRequired).toBe(true)
    expect(backendReadiness(ctx, 'trading-core').capability?.status).toBe('unavailable')
    expect(backendReadiness(ctx, 'market-watch').restartRequired).toBe(true)
    expect(backendReadiness(ctx, 'market-watch').capability?.status).toBe('unavailable')
    const stockBlocked = await ctx.tools.execute({
      signal,
      callId: CallId('stock-restart-required'),
      name: 'analyze_stock',
      arguments: { ticker: '000001' },
    })
    expect(stockBlocked.isError).toBe(true)
    if (!stockBlocked.isError) throw new Error('expected stock analysis to be blocked until restart')
    expect(stockBlocked.error.message).toMatch(/restart/i)
    expect(JSON.stringify(stockBlocked)).not.toContain(CANARY)

    contexts.splice(contexts.indexOf(ctx), 1)
    await ctx.fiber.dispose()
    const restarted = await mount(config, CANARY)
    expect(restarted.tools.schemas()).toHaveLength(21)
    const restartedTrading = backendReadiness(restarted, 'trading-core')
    const restartedMarket = backendReadiness(restarted, 'market-watch')
    expect(restartedTrading.capability?.toolCount).toBe(10)
    expect(restartedTrading.capability?.status).toBe('stock-full')
    expect(restartedTrading.restartRequired).toBe(false)
    expect(restartedMarket.capability?.toolCount).toBe(11)
    expect(restartedMarket.capability?.status).toBe('market-full')
    expect(restartedMarket.restartRequired).toBe(false)
    expect(JSON.stringify(restarted.investmentPythonRuntime.readiness())).not.toContain(CANARY)

    const stock = [...restarted.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-investment-stock-analysis')
    if (stock?.fiber === undefined) throw new Error('stock analysis plugin fiber was not mounted')
    await stock.fiber.dispose()
    expect(restarted.tools.schemas()).toHaveLength(11)
    expect([...restarted.loader.entries()].some(entry => entry.options.name === '@deepseek-ai/dsh-investment-python-runtime')).toBe(true)
    expect(restarted.tools.schemas().some(schema => schema.name === 'watch_list')).toBe(true)
  }, 60_000)

  it('attaches to external identities and rejects an occupied port with the wrong identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh profile external '))
    roots.push(root)
    const [tradingUrl, marketUrl, unknownUrl] = await Promise.all([
      listen('trading-core'),
      listen('market-watch'),
      listen('unknown'),
    ])
    const ctx = await mount(composition({
      home: join(root, 'dsh home'),
      tradingUrl,
      marketUrl,
      mode: 'external',
    }))
    expect(ctx.tools.schemas()).toHaveLength(21)
    expect((ctx.credentials as TestCredentials).resolveCalls).toEqual([])
    expect((ctx.credentials as TestCredentials).describeCalls).toEqual([])
    expect(ctx.investmentPythonRuntime.readiness().backends.map(backend => backend.backendStatus).sort())
      .toEqual(['external', 'external'])
    const attached = await mount(composition({
      home: join(root, 'attached home'),
      tradingUrl,
      marketUrl,
      mode: 'managed',
    }), CANARY)
    expect((attached.credentials as TestCredentials).resolveCalls).toEqual([])
    expect((attached.credentials as TestCredentials).describeCalls).toEqual([])
    expect(attached.investmentPythonRuntime.readiness().backends.map(backend => backend.backendStatus).sort())
      .toEqual(['healthy-attached', 'healthy-attached'])
    expect(JSON.stringify(attached.investmentPythonRuntime.readiness())).not.toContain(CANARY)
    await expect(checkBackendHealth({
      id: 'trading-core',
      service: 'trading-core',
      mode: 'external',
      baseUrl: unknownUrl,
      repositoryPath: ['unused'],
      module: 'adapter.app:app',
      healthPath: '/health',
      healthOk: { status: 'ok' },
      initCommand: { posix: './init.sh', windows: 'init.bat' },
    })).resolves.toMatchObject({ status: 'occupied' })
  })

  it('renders a portable five-layer Profile dump with runtime before both business bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh profile dump '))
    roots.push(root)
    const base = join(root, 'cordis.yml')
    await writeFile(base, '[]\n')
    const patches = [
      ['base', '../../../bundle/base/cordis.patch.yml'],
      ['web-app', '../../../bundle/web-app/cordis.patch.yml'],
      ['investment-runtime', '../../../bundle/investment-runtime/cordis.patch.yml'],
      ['investment-stock-analysis', '../../../bundle/investment-stock-analysis/cordis.patch.yml'],
      ['investment-market-watch', '../../../bundle/investment-market-watch/cordis.patch.yml'],
    ] as const
    const layers = patches.map(([label, relative]) => ({
      label,
      patches: loadOverlayPatches('dsh-investment-profile-test', fileURLToPath(new URL(relative, import.meta.url))),
    }))
    const rows = composeEntries(layers.map(layer => layer.patches))
    expect(rows.some(row => row.id === 'investment-python-runtime')).toBe(true)
    expect(rows.some(row => row.id === 'client-investment-research-runtime')).toBe(true)
    expect(rows.some(row => row.id === 'client-ui-investment-research')).toBe(true)
    expect(rows.some(row => row.id === 'client-ui-settings-investment-research')).toBe(true)
    const dump = renderConfigDump('dsh-investment-profile-test', base, layers)
    expect(dump.indexOf('investment-python-runtime')).toBeLessThan(dump.indexOf('investment-stock-analysis'))
    expect(dump.indexOf('investment-python-runtime')).toBeLessThan(dump.indexOf('investment-market-watch'))
    expect(dump).not.toMatch(/file:\/\/(?:[A-Za-z]:)?\//u)
    expect(dump).not.toContain(CANARY)
  })
})
