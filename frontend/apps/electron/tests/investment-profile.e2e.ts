import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import InvestmentPythonRuntime from '../../../packages/investment-research/python-runtime/src/index.ts'
import * as StockAnalysis from '../../../packages/investment-research/stock-analysis/src/index.ts'
import * as MarketWatch from '../../../packages/investment-research/market-watch/src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function importLocalRuntime(): Promise<typeof import('../../../packages/subprocess/subprocess-local/src/index.ts')> {
  const dlopen: typeof process.dlopen = process.dlopen.bind(process)
  process.dlopen = ((module, filename, flags) => {
    if (filename.includes('node-pty') && filename.endsWith('.node')) {
      (module as { exports: unknown }).exports = {}
      return
    }
    dlopen(module, filename, flags)
  })
  try {
    return await import('../../../packages/subprocess/subprocess-local/src/index.ts')
  } finally {
    process.dlopen = dlopen
  }
}

async function adapter(service: 'trading-core' | 'market-watch'): Promise<string> {
  const server = createServer((request, response) => {
    const payload = request.url === '/health'
      ? service === 'trading-core' ? { service, status: 'ok' } : { service, ok: true }
      : service === 'trading-core' ? { tickers: ['AAPL'] } : { items: [], count: 0 }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('adapter has no port')
  return `http://127.0.0.1:${address.port}`
}

function shippedRows() {
  const files = [
    '../../../packages/bundle/base/cordis.patch.yml',
    '../../../packages/bundle/web-app/cordis.patch.yml',
    '../../../packages/bundle/investment-runtime/cordis.patch.yml',
    '../../../packages/bundle/investment-stock-analysis/cordis.patch.yml',
    '../../../packages/bundle/investment-market-watch/cordis.patch.yml',
    '../electron.patch.yml',
  ]
  return composeEntries(files.map(file => loadOverlayPatches(
    'dsh-electron-investment-test',
    fileURLToPath(new URL(file, import.meta.url)),
  )))
}

function NativeMarker(): void {}

class KeylessCredentials extends Service {
  readonly resolveCalls: string[] = []
  readonly describeCalls: string[] = []

  constructor(ctx: Context) { super(ctx, 'credentials') }

  resolve(ref: string): Promise<undefined> {
    this.resolveCalls.push(ref)
    return Promise.resolve(undefined)
  }

  describe(ref: string): Promise<{ configured: false; writable: true }> {
    this.describeCalls.push(ref)
    return Promise.resolve({ configured: false, writable: true })
  }
}

describe('Electron investment Profile composition', () => {
  it('replaces every browser carrier and keeps the runtime plus twenty investment tools without opening a window', async () => {
    const effective = shippedRows()
    const byId = new Map(effective.map(row => [row.id, row]))
    for (const id of ['web-startup', 'webserver', 'web-runtime', 'directory-picker', 'connection']) {
      expect(byId.get(id)).toEqual(expect.objectContaining({ disabled: true }))
    }
    expect(byId.get('directory-picker-native')?.name).toBe('@deepseek-ai/dsh-host-directory-picker-native')
    expect(byId.get('ui-directory-picker-native')?.name).toBe('@deepseek-ai/dsh-client-ui-directory-picker-native')
    expect(byId.get('electron-connection')?.name).toBe('@deepseek-ai/dsh-electron')
    expect(byId.get('client-investment-research-runtime')?.name)
      .toBe('@deepseek-ai/dsh-client-investment-research-runtime')
    expect(byId.get('client-ui-investment-research')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-investment-research')
    expect(byId.get('client-ui-settings-investment-research')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-settings-investment-research')

    const root = await mkdtemp(join(tmpdir(), 'dsh electron investment '))
    roots.push(root)
    const [tradingUrl, marketUrl] = await Promise.all([adapter('trading-core'), adapter('market-watch')])
    const configPath = join(root, 'cordis.yml')
    const rows = [
      { name: '@deepseek-ai/dsh-agent' },
      { name: '@deepseek-ai/dsh-system-prompt' },
      { name: '@deepseek-ai/dsh-tools' },
      { name: '@deepseek-ai/dsh-subprocess-local' },
      { name: '@test/credentials' },
      { id: 'investment-python-runtime', name: byId.get('investment-python-runtime')?.name, config: { dshHome: join(root, 'home') } },
      { id: 'investment-stock-analysis', name: byId.get('investment-stock-analysis')?.name, config: { backendMode: 'external', backendBaseUrl: tradingUrl } },
      { id: 'investment-market-watch', name: byId.get('investment-market-watch')?.name, config: { backendMode: 'external', backendBaseUrl: marketUrl } },
      byId.get('directory-picker-native'),
      byId.get('ui-directory-picker-native'),
      byId.get('electron-connection'),
    ]
    await writeFile(configPath, JSON.stringify(rows))
    const { default: LocalSubprocessRuntime } = await importLocalRuntime()
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const imported: string[] = []
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@test/credentials', KeylessCredentials],
      ['@deepseek-ai/dsh-investment-python-runtime', InvestmentPythonRuntime],
      ['@deepseek-ai/dsh-investment-stock-analysis', StockAnalysis],
      ['@deepseek-ai/dsh-investment-market-watch', MarketWatch],
      ['@deepseek-ai/dsh-host-directory-picker-native', NativeMarker],
      ['@deepseek-ai/dsh-client-ui-directory-picker-native', NativeMarker],
      ['@deepseek-ai/dsh-electron', NativeMarker],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        imported.push(specifier)
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    expect(ctx.tools.schemas()).toHaveLength(20)
    expect((ctx.credentials as unknown as KeylessCredentials).resolveCalls).toEqual([])
    expect((ctx.credentials as unknown as KeylessCredentials).describeCalls).toEqual([])
    expect(imported).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-investment-python-runtime',
      '@deepseek-ai/dsh-investment-stock-analysis',
      '@deepseek-ai/dsh-investment-market-watch',
      '@test/credentials',
      '@deepseek-ai/dsh-host-directory-picker-native',
      '@deepseek-ai/dsh-client-ui-directory-picker-native',
      '@deepseek-ai/dsh-electron',
    ]))
    expect(imported).not.toContain('electron')
  })
})
