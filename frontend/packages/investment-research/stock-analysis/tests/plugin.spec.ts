import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'

type RegisteredTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    render?: (args: unknown, value: unknown) => Array<{ text: string }>
    presentationMeta?: (args: unknown, value: unknown) => unknown
  }
  presentCall?: (args: unknown) => unknown
  presentResult?: (args: unknown, result: unknown) => unknown
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: { inject(message: unknown): void } }) => Promise<unknown>
}

afterEach(() => vi.unstubAllGlobals())

function install(config: Plugin.Config = {
  adapterBaseUrl: 'http://adapter.test', streamTimeoutMs: 1_000,
  enableInChatPush: false, pushPollMs: 30_000, pushSessions: [],
}): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  Plugin.apply({
    effect(callback: () => () => void) { callback() },
    tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} } },
    agents: { roots: () => [] },
  } as never, config)
  return tools
}

describe('stock-analysis function plugin', () => {
  it('has only the preserved named function-plugin API', () => {
    const config: Plugin.Config = {}
    expect(Plugin.name).toBe('investment-stock-analysis')
    expect(Plugin.inject).toEqual(['tools', 'agents'])
    expect(Plugin.apply).toBeTypeOf('function')
    expect(config).toEqual({})
  })

  it('keeps schema names and maps every tool argument to the existing adapter endpoint', async () => {
    const requests: Array<[string, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push([url, init?.body as string | undefined])
      if (url.endsWith('/stream')) {
        return new Response('event: result\ndata: {"signal":{},"reports":{},"performance_metrics":{}}\n\nevent: done\ndata: {}\n\n')
      }
      if (init?.method === 'POST' && (url.endsWith('/analyze') || url.endsWith('/holdings/analyze') || url.endsWith('/brief'))) {
        return new Response('{"task_id":"t1"}')
      }
      return new Response('{"saved":1,"tickers":[],"risk_profile":"balanced","label":"稳健","id":"b1"}')
    }))
    const tools = install()
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    expect(tools).toHaveLength(9)
    expect([...byName.values()].every(tool => tool.description.length > 0 && Object.keys(tool.parameters).length >= 0)).toBe(true)
    const exec = { signal: new AbortController().signal }

    const presentationArgs: Record<string, Record<string, unknown>> = {
      analyze_stock: { ticker: '600519' },
      analyze_holdings: {},
      market_brief: {},
      set_watchlist: { tickers: [] },
      set_holdings: { holdings: [] },
      get_watchlist: {},
      set_risk_profile: { risk_profile: 'balanced' },
      get_risk_profile: {},
      get_latest_brief: {},
    }
    for (const tool of tools) {
      const args = presentationArgs[tool.name]!
      tool.presentCall?.(args)
      tool.presentResult?.(args, { meta: '完成' })
      tool.presentResult?.(args, {})
      tool.output.render?.(args, {
        signal: {}, reports: {}, performance_metrics: {}, saved: 1, tickers: [], holdings: [],
        risk_profile: 'balanced', label: '稳健', id: 'b1', period: 'pre_market', trade_date: '2026-08-20', dsh_pushed: false,
      })
    }
    const outputValues: Record<string, unknown> = {
      analyze_stock: { signal: { ticker: '600519' }, reports: {} },
      analyze_holdings: { signal: {}, reports: {} },
      market_brief: { signal: { period: 'now', opportunities: [] }, reports: {} },
      set_watchlist: {},
      set_holdings: {},
      get_watchlist: {},
      set_risk_profile: {},
      get_risk_profile: {},
      get_latest_brief: { id: 'b1', period: 'post_market', dsh_pushed: true },
    }
    for (const [toolName, value] of Object.entries(outputValues)) {
      const tool = byName.get(toolName)!
      const args = presentationArgs[toolName]!
      tool.output.render?.(args, value)
      tool.output.presentationMeta?.(args, value)
    }

    await byName.get('analyze_stock')!.execute({ ticker: '600519', date: '2026-08-20', research_depth: 'deep', config_overrides: { rounds: 2 }, risk_profile: 'balanced' }, exec)
    await byName.get('analyze_holdings')!.execute({ holdings: [{ ticker: '600519', quantity: 1, cost_price: 10 }], mode: 'quick', use_saved: false, risk_profile: 'conservative' }, exec)
    await byName.get('market_brief')!.execute({ period: 'post_market', scope: 'watchlist', tickers: ['600519'], risk_profile: 'aggressive' }, exec)
    await byName.get('set_watchlist')!.execute({ tickers: ['600519'] }, exec)
    await byName.get('set_holdings')!.execute({ holdings: [{ ticker: '600519', quantity: 1, cost_price: 10 }] }, exec)
    await byName.get('get_watchlist')!.execute({}, exec)
    await byName.get('set_risk_profile')!.execute({ risk_profile: 'aggressive' }, exec)
    await byName.get('get_risk_profile')!.execute({}, exec)
    await byName.get('get_latest_brief')!.execute({}, exec)

    const defaults = new Map(install({}).map(tool => [tool.name, tool]))
    await defaults.get('analyze_stock')!.execute({ ticker: '600519' }, exec)
    await defaults.get('analyze_holdings')!.execute({}, exec)
    await defaults.get('market_brief')!.execute({}, exec)
    await defaults.get('set_holdings')!.execute({ holdings: [] }, exec)

    expect(requests.map(([url, body]) => [url.replace('http://adapter.test', ''), body])).toContainEqual(['/analyze', '{"ticker":"600519","date":"2026-08-20","research_depth":"deep","config_overrides":{"rounds":2},"risk_profile":"balanced"}'])
    expect(requests.map(([url]) => url.replace('http://adapter.test', ''))).toEqual(expect.arrayContaining([
      '/holdings/analyze', '/brief', '/watchlist', '/holdings/save', '/risk_profile', '/brief/latest',
    ]))
  })

  it('renders successful and empty adapter values without exposing transport errors as schemas', () => {
    const byName = new Map(install().map(tool => [tool.name, tool]))
    expect(byName.get('set_watchlist')!.output.render?.({}, { saved: 2 })[0]!.text).toBe('已保存 2 只自选股。')
    expect(byName.get('get_watchlist')!.output.render?.({}, { tickers: [] })[0]!.text).toContain('（空）')
    expect(byName.get('get_latest_brief')!.output.render?.({}, {})[0]!.text).toBe('暂无简报')
  })

  it('retains presenter and saved-holdings fallbacks behind the validated public tool wrapper', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-tools', async importOriginal => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-tools')>()
      return { ...actual, defineTool: <T>(definition: T) => definition }
    })
    const rawPlugin = await import('../src/index.ts')
    const rawTools: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"saved":0}')))
    rawPlugin.apply({
      effect(callback: () => () => void) { callback() },
      tools: { register(tool: Record<string, unknown>) { rawTools.push(tool); return () => {} } },
      agents: { roots: () => [] },
    } as never, {})

    const byName = new Map(rawTools.map(tool => [tool.name as string, tool]))
    const analyze = byName.get('analyze_stock')!
    const setHoldings = byName.get('set_holdings')!
    expect((analyze.presentCall as (args: unknown) => { title: string })({}).title).toBe('📈 分析 ')
    await (setHoldings.execute as (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>)(
      { holdings: undefined },
      { signal: new AbortController().signal },
    )
  })
})
