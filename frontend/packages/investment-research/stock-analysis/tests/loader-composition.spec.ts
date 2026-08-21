import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvestmentPythonRuntime from '@deepseek-ai/dsh-investment-python-runtime'
import * as StockAnalysis from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

class StubSubprocessRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'subprocess') }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-investment-stock-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@test/subprocess'",
    "- name: '@deepseek-ai/dsh-investment-python-runtime'",
    "- name: '@deepseek-ai/dsh-investment-stock-analysis'",
    '  config:',
    '    backendMode: external',
    '    backendBaseUrl: http://127.0.0.1:18000',
    '',
  ].join('\n'))

  context = new Context()
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    service: 'trading-core',
    status: 'ok',
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@test/subprocess', StubSubprocessRuntime],
    ['@deepseek-ai/dsh-investment-python-runtime', InvestmentPythonRuntime],
    ['@deepseek-ai/dsh-investment-stock-analysis', StockAnalysis],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('stock-analysis through a real Loader composition', () => {
  it('loads all nine schemas by package name and removes them when its Loader fiber disposes', async () => {
    const ctx = await loadComposition()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'analyze_holdings',
      'analyze_stock',
      'get_latest_brief',
      'get_risk_profile',
      'get_watchlist',
      'market_brief',
      'set_holdings',
      'set_risk_profile',
      'set_watchlist',
    ])

    const entry = [...ctx.loader.entries()].find(candidate =>
      candidate.options.name === '@deepseek-ai/dsh-investment-stock-analysis')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  })
})
