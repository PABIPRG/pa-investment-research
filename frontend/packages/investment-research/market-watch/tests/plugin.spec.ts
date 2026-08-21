import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'

type RegisteredTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render?: (args: unknown, value: unknown) => Array<{ text: string }> }
  presentCall?: (args: unknown) => unknown
  presentResult?: (args: unknown, result: unknown) => unknown
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

function input(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function output(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, properties }
}

const MARKET_CONTRACTS = [
  { name: 'watch_add', description: '添加一只 A 股到盯盘自选列表（模块独立自选，不与 trading-core 的持仓/自选耦合）。code 传 6 位代码（如 600519）；name 可省，缺省从行情快照自动补。', parameters: input({ code: { type: 'string', description: '6 位股票代码，如 600519' }, name: { type: 'string', description: '股票名称，可选，缺省自动补' } }, ['code']), schema: output({ ok: { type: 'boolean' }, duplicate: { type: 'boolean' }, code: { type: 'string' }, name: { type: 'string' } }) },
  { name: 'watch_remove', description: '从盯盘自选列表移除一只股票。', parameters: input({ code: { type: 'string', description: '6 位股票代码' } }, ['code']), schema: output({ ok: { type: 'boolean' }, removed: { type: 'boolean' }, code: { type: 'string' } }) },
  { name: 'watch_list', description: '列出当前盯盘自选列表。', parameters: input({}), schema: output({ items: { description: '自选 [{code, name, added_at}]' }, count: { type: 'number' } }) },
  { name: 'add_alert', description: '创建一条盯盘触发规则。conditions 字段可选 price(现价) / pct_change(涨跌幅%) / volume_ratio(量比) / amount(成交额·亿) / turnover(换手率%)；operator 用 > >= < <=；combine=and 需全部满足、or 任一满足。ticker 留空则对全部自选生效，也可指定单只（不在自选也行）。触发后由适配器调度器推送（可配 LLM 解读）。', parameters: input({ name: { type: 'string', description: '规则名，如「放量大涨」' }, ticker: { type: 'string', description: '可空=全部自选；或指定 6 位代码盯单只' }, combine: { type: 'string', enum: ['and', 'or'], description: 'and=全部满足 / or=任一满足，默认 or' }, conditions: { description: '条件数组 [{field, operator, value}]，如 [{field:"pct_change", operator:">=", value:5}]' }, cooldown_min: { type: 'number', description: '两次触发最小间隔(分钟)，0=不限' }, daily_cap: { type: 'number', description: '每日最多触发次数，0=不限' } }, ['name', 'conditions']), schema: output({ ok: { type: 'boolean' }, id: { type: 'string' }, rule: {} }) },
  { name: 'list_alerts', description: '列出全部盯盘规则（含启用状态 / 冷却 / 每日上限）。', parameters: input({}), schema: output({ items: {}, count: { type: 'number' } }) },
  { name: 'remove_alert', description: '删除一条盯盘规则（id 来自 list_alerts）。', parameters: input({ id: { type: 'string', description: '规则 id' } }, ['id']), schema: output({ ok: { type: 'boolean' }, removed: { type: 'boolean' }, id: { type: 'string' } }) },
  { name: 'scan_movers', description: '盘中异动扫描（实时快照，秒级）。kind 可选 gainers 涨幅榜 / volume_ratio 量比异动 / limit 涨跌停 / turnover 换手异动 / amount 成交额榜。默认只扫沪深。top_n 控制返回条数；amount 榜可用 min_amount_yi 过滤最小成交额(亿)。', parameters: input({ kind: { type: 'string', enum: ['gainers', 'volume_ratio', 'limit', 'turnover', 'amount'], description: '扫描类型，默认 gainers' }, top_n: { type: 'number', description: '返回条数，默认 10' }, min_amount_yi: { type: 'number', description: '仅 amount：最小成交额(亿元)' } }), schema: output({ kind: { type: 'string' }, trade_date: { type: 'string' }, as_of: { type: 'string' }, items: { description: '非 limit 类返回：异动榜' }, limit_up: { description: 'limit 类：涨停股榜' }, limit_down: { description: 'limit 类：跌停股榜' } }) },
  { name: 'watch_overview', description: '盯盘面板：自选实时行情（现价/涨跌幅/量比/换手/成交额/主力净流入）+ 每条规则命中(hit)与逼近(near)状态。适合用户问「今天盯得怎么样」时给出一张实时状态卡。', parameters: input({}), schema: output({ as_of: { type: 'string' }, trade_date: { type: 'string' }, items: { description: '逐自选状态 + hit/near 规则' } }) },
  { name: 'tech_signal', description: '单只股票技术信号（前复权日线）：MA(5/10/20/60 多头/空头/缠绕)、MACD(金叉/死叉)、RSI(超买/超卖)、KDJ(金叉/死叉)、BOLL(上/中/下轨与突破状态)、近60根支撑压力、量价形态(放量突破/缩量回调)。秒级返回。', parameters: input({ code: { type: 'string', description: '6 位股票代码' }, lookback: { type: 'number', description: 'K线根数，默认 120，范围 30-500' } }, ['code']), schema: output({ code: { type: 'string' }, name: { type: 'string' }, as_of: { type: 'string' }, bars: { type: 'number' }, last: { description: '最新一根 K 线 OHLCV' }, indicators: {}, signals: {} }) },
  { name: 'news_express', description: '新闻速递：财联社市场要闻 + 每只自选股东财新闻（各 top 3），LLM 生成中文摘要 digest。适合用户问「今天有什么要闻 / 我的自选有什么消息」。', parameters: input({}), schema: output({ id: { type: 'string' }, generated_at: { type: 'string' }, trade_date: { type: 'string' }, digest: { type: 'string' }, items: {}, global_count: { type: 'number' }, stock_count: { type: 'number' } }) },
  { name: 'daily_brief', description: '生成盘前/盘后 LLM 简报。period=pre：指数状态 + 自选涨跌 + 要闻 → 「今日关注点」；period=post：自选当日表现 + 当日触发 + 资金流 + 要闻 → 「复盘 + 明日关注」。LLM 不可用时降级为数据模板。', parameters: input({ period: { type: 'string', enum: ['pre', 'post'], description: 'pre=盘前 / post=盘后，默认 pre' }, manual: { type: 'boolean', description: 'true 绕过交易日守卫（测试用），默认 false' } }), schema: output({ id: { type: 'string' }, period: { type: 'string' }, generated_at: { type: 'string' }, trade_date: { type: 'string' }, content: { type: 'string' }, llm_used: { type: 'boolean' } }) },
] as const

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
    const calls: Array<[string, string | undefined, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, init?.body as string | undefined])
      return new Response('{"ok":true,"code":"600519","name":"茅台","items":[],"count":0,"removed":true,"id":"a1"}')
    }))
    const byName = new Map(install().map(tool => [tool.name, tool]))
    expect(
      [...byName.values()].map(
        ({ name, description, parameters, output: { schema } }) => ({ name, description, parameters, schema }),
      ),
    ).toEqual(MARKET_CONTRACTS)

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
    const presentationTitles = {
      watch_add: '加入自选', watch_remove: '移除自选', watch_list: '自选列表', add_alert: '新建盯盘规则',
      list_alerts: '规则列表', remove_alert: '删除规则', scan_movers: '异动扫描', watch_overview: '盯盘面板',
      tech_signal: '技术信号', news_express: '新闻速递', daily_brief: '简报',
    }
    for (const tool of byName.values()) {
      const args = presentationArgs[tool.name]!
      expect(tool.presentCall?.(args)).toEqual({ card: 'generic', title: presentationTitles[tool.name as keyof typeof presentationTitles], kind: 'other', rawInput: args })
      expect(tool.presentResult?.(args, { meta: '完成' })).toEqual({ card: 'generic', title: presentationTitles[tool.name as keyof typeof presentationTitles], content: [{ type: 'text', text: '完成' }] })
      expect(tool.presentResult?.(args, {})).toEqual({ card: 'generic', title: presentationTitles[tool.name as keyof typeof presentationTitles], content: [{ type: 'text', text: presentationTitles[tool.name as keyof typeof presentationTitles] }] })
      expect(tool.output.render?.(args, { ok: true, code: '600519', name: '茅台', removed: true, id: 'a1', items: [], count: 0 })?.[0]).toMatchObject({ type: 'text' })
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
    const renderedText = {
      watch_add: '✅ 已加入自选 茅台（600519）', watch_remove: '600519 不在自选',
      watch_list: '**自选列表为空**，用 `watch_add` 添加。', add_alert: '✅ 规则已创建：a1',
      list_alerts: '**暂无盯盘规则**，用 `add_alert` 创建。', remove_alert: '规则 a1 不存在',
      scan_movers: '**undefined** · 交易日 -\n\n> 快照 -', watch_overview: '**盯盘面板为空**，先 `watch_add` 添加自选。',
      tech_signal: '**技术信号** · （）· - 根K线\n\n数据不足，无可用信号',
      news_express: '**新闻速递** · 交易日 -\n\n本次无新闻返回（数据源暂不可用）',
      daily_brief: '**盘前关注** · -（数据模板）\n\n',
    }
    for (const [toolName, value] of Object.entries(outputValues)) {
      expect(byName.get(toolName)!.output.render?.(presentationArgs[toolName]!, value)).toEqual([{ type: 'text', text: renderedText[toolName as keyof typeof renderedText] }])
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

    expect(calls.slice(0, 11).map(([url, method, body]) => [url.replace('http://market.test', ''), method, body])).toEqual([
      ['/watchlist/add', 'POST', '{"code":"600519","name":"茅台"}'],
      ['/watchlist/remove', 'POST', '{"code":"600519"}'],
      ['/watchlist', 'GET', undefined],
      ['/alerts', 'POST', '{"name":"突破","ticker":"600519","combine":"and","conditions":[{"field":"price","operator":">","value":1}],"cooldown_min":1,"daily_cap":2}'],
      ['/alerts', 'GET', undefined],
      ['/alerts/a1', 'DELETE', undefined],
      ['/scan', 'POST', '{"kind":"amount","top_n":3,"min_amount_yi":2}'],
      ['/overview', 'GET', undefined],
      ['/tech-signal', 'POST', '{"code":"600519","lookback":30}'],
      ['/news/express', 'POST', undefined],
      ['/brief/generate', 'POST', '{"period":"post","manual":true}'],
    ])
  })

  it('keeps success, empty and error result rendering within the tool presentation', () => {
    const byName = new Map(install().map(tool => [tool.name, tool]))
    expect(byName.get('watch_add')!.output.render?.({}, { name: '茅台', code: '600519' })).toEqual([{ type: 'text', text: '✅ 已加入自选 茅台（600519）' }])
    expect(byName.get('watch_remove')!.output.render?.({}, { code: '600519', removed: false })).toEqual([{ type: 'text', text: '600519 不在自选' }])
    expect(byName.get('remove_alert')!.output.render?.({}, { id: 'a1', removed: true })).toEqual([{ type: 'text', text: '🗑 已删除规则 a1' }])
  })
})
