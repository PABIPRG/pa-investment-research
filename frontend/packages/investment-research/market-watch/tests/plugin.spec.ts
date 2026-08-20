import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'

type RegisteredTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { render?: (args: unknown, value: unknown) => Array<{ text: string }> }
  presentCall?: (args: unknown) => unknown
  presentResult?: (args: unknown, result: unknown) => unknown
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

afterEach(() => vi.unstubAllGlobals())

function install(config: Plugin.Config = { adapterBaseUrl: 'http://market.test' }): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  Plugin.apply({
    effect(callback: () => () => void) { callback() },
    tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} } },
  } as never, config)
  return tools
}

describe('market-watch function plugin', () => {
  it('has the preserved named function-plugin API', () => {
    const config: Plugin.Config = {}
    expect(Plugin.name).toBe('investment-market-watch')
    expect(Plugin.inject).toEqual(['tools'])
    expect(Plugin.apply).toBeTypeOf('function')
    expect(config).toEqual({})
  })

  it('keeps all eleven schemas and maps tool arguments to the existing JSON adapter routes', async () => {
    const calls: Array<[string, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init?.body as string | undefined])
      return new Response('{"ok":true,"code":"600519","name":"茅台","items":[],"count":0,"removed":true,"id":"a1"}')
    }))
    const byName = new Map(install().map(tool => [tool.name, tool]))
    expect(byName).toHaveLength(11)
    expect([...byName.values()].every(tool => tool.description.length > 0)).toBe(true)

    const presentationArgs: Record<string, Record<string, unknown>> = {
      watch_add: { code: '600519' },
      watch_remove: { code: '600519' },
      watch_list: {},
      add_alert: { name: '规则', conditions: [] },
      list_alerts: {},
      remove_alert: { id: 'a1' },
      scan_movers: {},
      watch_overview: {},
      tech_signal: { code: '600519' },
      news_express: {},
      daily_brief: {},
    }
    for (const tool of byName.values()) {
      const args = presentationArgs[tool.name]!
      tool.presentCall?.(args)
      tool.presentResult?.(args, { meta: '完成' })
      tool.presentResult?.(args, {})
      tool.output.render?.(args, { ok: true, code: '600519', name: '茅台', removed: true, id: 'a1', items: [], count: 0 })
    }
    const outputValues: Record<string, unknown> = {
      watch_add: { code: '600519', name: '茅台' },
      watch_remove: { code: '600519', removed: false },
      watch_list: {},
      add_alert: { id: 'a1' },
      list_alerts: {},
      remove_alert: { id: 'a1', removed: false },
      scan_movers: {},
      watch_overview: {},
      tech_signal: {},
      news_express: {},
      daily_brief: {},
    }
    for (const [toolName, value] of Object.entries(outputValues)) {
      byName.get(toolName)!.output.render?.(presentationArgs[toolName]!, value)
    }

    await byName.get('watch_add')!.execute({ code: '600519', name: '茅台' })
    await byName.get('watch_remove')!.execute({ code: '600519' })
    await byName.get('watch_list')!.execute({})
    await byName.get('add_alert')!.execute({ name: '突破', ticker: '600519', combine: 'and', conditions: [{ field: 'price', operator: '>', value: 1 }], cooldown_min: 1, daily_cap: 2 })
    await byName.get('list_alerts')!.execute({})
    await byName.get('remove_alert')!.execute({ id: 'a1' })
    await byName.get('scan_movers')!.execute({ kind: 'amount', top_n: 3, min_amount_yi: 2 })
    await byName.get('watch_overview')!.execute({})
    await byName.get('tech_signal')!.execute({ code: '600519', lookback: 30 })
    await byName.get('news_express')!.execute({})
    await byName.get('daily_brief')!.execute({ period: 'post', manual: true })

    const defaults = new Map(install({}).map(tool => [tool.name, tool]))
    await defaults.get('watch_add')!.execute({ code: '600519' })
    await defaults.get('add_alert')!.execute({ name: '默认规则', conditions: [] })
    await defaults.get('scan_movers')!.execute({})
    await defaults.get('tech_signal')!.execute({ code: '600519' })
    await defaults.get('daily_brief')!.execute({})

    expect(calls.slice(0, 11).map(([url]) => url.replace('http://market.test', ''))).toEqual([
      '/watchlist/add', '/watchlist/remove', '/watchlist', '/alerts', '/alerts', '/alerts/a1', '/scan', '/overview', '/tech-signal', '/news/express', '/brief/generate',
    ])
    expect(calls).toContainEqual(['http://market.test/scan', '{"kind":"amount","top_n":3,"min_amount_yi":2}'])
  })

  it('keeps success, empty and error result rendering within the tool presentation', () => {
    const byName = new Map(install().map(tool => [tool.name, tool]))
    expect(byName.get('watch_add')!.output.render?.({}, { name: '茅台', code: '600519' })[0]!.text).toContain('已加入自选')
    expect(byName.get('watch_remove')!.output.render?.({}, { code: '600519', removed: false })[0]!.text).toContain('不在自选')
    expect(byName.get('remove_alert')!.output.render?.({}, { id: 'a1', removed: true })[0]!.text).toContain('已删除规则')
  })
})
