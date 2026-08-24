import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import InvestmentPythonRuntime from '../src/index.ts'
import * as StockAnalysis from '../../stock-analysis/src/index.ts'
import * as MarketWatch from '../../market-watch/src/index.ts'

const enabled = process.env.DSH_INVESTMENT_ENGINE_SMOKE === '1'
const frontendRoot = fileURLToPath(new URL('../../../../', import.meta.url))
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate engine smoke port')
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  }))
  return address.port
}

describe.skipIf(!enabled)('managed investment engines', () => {
  it('boots both real backends through the managed Profile and disposes without business requests', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh investment engine '))
    const [tradingPort, marketPort] = await Promise.all([freePort(), freePort()])
    const base = [{ insert: [
      { id: 'agent', name: '@deepseek-ai/dsh-agent' },
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
    ] }]
    const bundleFiles = [
      '../../../bundle/investment-runtime/cordis.patch.yml',
      '../../../bundle/investment-stock-analysis/cordis.patch.yml',
      '../../../bundle/investment-market-watch/cordis.patch.yml',
    ]
    const rows = composeEntries([
      base,
      ...bundleFiles.map(file => loadOverlayPatches('dsh-investment-engine-smoke', fileURLToPath(new URL(file, import.meta.url)))),
    ])
    const byId = new Map(rows.map(row => [row.id, row]))
    Object.assign(byId.get('investment-python-runtime')!, { config: {
      dshHome: join(root, 'home'),
      startupTimeoutMs: 60_000,
      healthPollMs: 100,
      shutdownGraceMs: 5_000,
    } })
    Object.assign(byId.get('investment-stock-analysis')!, { config: {
      backendMode: 'managed',
      backendBaseUrl: `http://127.0.0.1:${tradingPort}`,
      backendProjectDir: join(frontendRoot, '..', 'backend', 'dsh-trading-core'),
    } })
    Object.assign(byId.get('investment-market-watch')!, { config: {
      backendMode: 'managed',
      backendBaseUrl: `http://127.0.0.1:${marketPort}`,
      backendProjectDir: join(frontendRoot, '..', 'backend', 'market-watch'),
    } })
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify(rows))

    const { default: LocalSubprocessRuntime } = await import('../../../subprocess/subprocess-local/src/index.ts')
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-investment-python-runtime', InvestmentPythonRuntime],
      ['@deepseek-ai/dsh-investment-stock-analysis', StockAnalysis],
      ['@deepseek-ai/dsh-investment-market-watch', MarketWatch],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    expect(context.tools.schemas()).toHaveLength(20)
    expect(context.investmentPythonRuntime.invariantSnapshot().active).toHaveLength(2)
  }, 120_000)
})
