import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvestmentPythonRuntime from '@deepseek-ai/dsh-investment-python-runtime'
import * as MarketWatch from '../src/index.ts'

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
  root = await mkdtemp(join(tmpdir(), 'dsh-investment-market-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@test/subprocess'",
    "- name: '@deepseek-ai/dsh-investment-python-runtime'",
    "- name: '@deepseek-ai/dsh-investment-market-watch'",
    '  config:',
    '    backendMode: external',
    '    backendBaseUrl: http://127.0.0.1:18100',
    '',
  ].join('\n'))

  context = new Context()
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    service: 'market-watch',
    ok: true,
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@test/subprocess', StubSubprocessRuntime],
    ['@deepseek-ai/dsh-investment-python-runtime', InvestmentPythonRuntime],
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
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('market-watch through a real Loader composition', () => {
  it('loads all eleven schemas by package name and removes them when its Loader fiber disposes', async () => {
    const ctx = await loadComposition()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'add_alert',
      'daily_brief',
      'list_alerts',
      'news_express',
      'remove_alert',
      'scan_movers',
      'tech_signal',
      'watch_add',
      'watch_list',
      'watch_overview',
      'watch_remove',
    ])

    const entry = [...ctx.loader.entries()].find(candidate =>
      candidate.options.name === '@deepseek-ai/dsh-investment-market-watch')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  })
})
