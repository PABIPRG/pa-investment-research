import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.ts'

type RegisteredTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render?: (args: unknown, value: unknown) => Array<{ text: string }>
    presentationMeta?: (args: unknown, value: unknown) => unknown
  }
  presentCall?: (args: unknown) => unknown
  presentResult?: (args: unknown, result: unknown) => unknown
  execute: (args: Record<string, unknown>, exec: {
    signal: AbortSignal
    agent?: { inject(message: unknown): void; session?: { header: { id: string } } }
  }) => Promise<unknown>
}

const riskProfile = {
  type: 'string',
  description: '风险偏好：conservative(保守)/balanced(稳健)/aggressive(进取)；缺省用已保存偏好',
  enum: ['conservative', 'balanced', 'aggressive'],
}

function input(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function output(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, properties }
}

const STOCK_CONTRACTS = [
  {
    name: 'analyze_stock',
    description: '对 A 股股票进行多智能体 AI 分析，返回买入/持有/卖出决策、目标价、置信度与分步报告。研究档位按延迟从低到高扩展分析覆盖：quick 仅市场，basic 增加基本面，standard 覆盖市场/基本面/新闻/情绪，deep/full 保持四分析师并增加多空与风险辩论轮次。输入可以是股票代码（如 600519）或名称（如 贵州茅台）；date 留空表示最近交易日。',
    parameters: input({ ticker: { type: 'string', description: '股票代码（如 600519）或名称（如 贵州茅台）' }, date: { type: 'string', description: '分析日期 YYYY-MM-DD，可选，默认最近交易日' }, research_depth: { type: 'string', description: '研究深度：quick=仅市场、最低延迟；basic=市场+基本面；standard=四分析师+1 轮多空/风险辩论（默认）；deep=四分析师+2 轮；full=四分析师+3 轮并启用在线新闻，延迟依次增加', enum: ['quick', 'basic', 'standard', 'deep', 'full'] }, config_overrides: { description: '可选，会话级引擎参数覆盖（如 max_debate_rounds）' }, risk_profile: riskProfile }, ['ticker']),
    schema: output({ signal: { description: '统一决策信号（action/target_price/confidence/risk_score/reasoning）' }, reports: { description: '各分析阶段的分步 Markdown 报告' }, performance_metrics: { description: '各节点耗时统计' } }),
  },
  {
    name: 'analyze_holdings',
    description: '分析当前持仓的风险：市值/浮盈/权重/集中度 HHI/行业暴露 + 逐股年化波动率/最大回撤/β。deep 模式对每只股票并行跑引擎 standard 深度（四分析师，约 3-5 分钟），输出每股风险分与买卖信号；quick 模式仅定量风险（秒级）。holdings 传持仓列表（代码+股数+成本价）；不传则用已保存持仓。',
    parameters: input({ holdings: { description: '持仓列表 [{ticker:"600519", quantity:200, cost_price:1480}, ...]；缺省用已保存持仓' }, mode: { type: 'string', description: 'deep=逐股 standard 四分析师引擎分析(慢,约3-5分钟), quick=仅定量风险(秒级)，默认 deep', enum: ['quick', 'deep'] }, use_saved: { type: 'boolean', description: 'holdings 为空时是否回退到已保存持仓，默认 true' }, risk_profile: riskProfile }),
    schema: output({ signal: { description: '组合信号（市值/浮盈/风险/逐股明细）' }, reports: { description: 'Markdown 报告' }, performance_metrics: { description: '耗时统计' } }),
  },
  {
    name: 'market_brief',
    description: '生成 A股盘前/盘后市场简报：指数、涨跌家数、板块动向、北向资金、龙虎榜、资讯汇总，并挖掘事件驱动机会点（自选股异动/龙虎榜主力净买入/板块资金异动/资讯事件）。period 选 pre_market(盘前)/post_market(盘后)/now(盘中)。结果同时可推送至企业微信/Server酱。',
    parameters: input({ period: { type: 'string', description: 'pre_market=盘前, post_market=盘后, now=当前（默认 now）', enum: ['pre_market', 'post_market', 'now'] }, scope: { type: 'string', description: '覆盖范围: all/market/industry/concept/news/watchlist，默认 all' }, tickers: { description: '覆盖的自选股代码列表；缺省用已保存 watchlist' }, risk_profile: riskProfile }),
    schema: output({ signal: { description: '简报信号（summary 为 Markdown 简报）' }, reports: { description: 'Markdown 报告' }, performance_metrics: { description: '耗时统计' } }),
  },
  { name: 'set_watchlist', description: '整体替换自选股票列表（覆盖 600519、000858 等），供简报/持仓分析的 watchlist 维度使用。', parameters: input({ tickers: { description: '自选股票代码列表，如 ["600519","000858","300750"]' } }, ['tickers']), schema: output({ saved: { type: 'number', description: '保存条数' } }) },
  { name: 'set_holdings', description: '保存/整体替换当前持仓到本地（供 analyze_holdings 不传 holdings 时复用）。holdings 为 [{ticker:"600519", quantity:200, cost_price:1500}, ...]，股数与原币成本价。', parameters: input({ holdings: { description: '持仓列表 [{ticker, quantity, cost_price}, ...]' } }, ['holdings']), schema: output({ saved: { type: 'number', description: '保存条数' } }) },
  { name: 'get_watchlist', description: '读取当前自选股票列表。', parameters: input({}), schema: output({ tickers: { type: 'array', description: '自选股票代码列表', items: { type: 'string' } } }) },
  { name: 'set_risk_profile', description: '保存全局风险偏好画像：conservative(保守，保本控回撤)/balanced(稳健，默认)/aggressive(进取，求高收益)。后续所有个股分析/持仓分析/市场简报均按此偏好展开分析框架；单次调用仍可传 risk_profile 覆盖。', parameters: input({ risk_profile: { type: 'string', description: '风险偏好画像：conservative/balanced/aggressive', enum: ['conservative', 'balanced', 'aggressive'] } }, ['risk_profile']), schema: output({ risk_profile: { type: 'string', description: '已保存的画像键名' }, label: { type: 'string', description: '画像中文名' } }) },
  { name: 'get_risk_profile', description: '读取当前保存的风险偏好画像（conservative/balanced/aggressive）及中文名。', parameters: input({}), schema: output({ risk_profile: { type: 'string', description: '画像键名' }, label: { type: 'string', description: '画像中文名' } }) },
  { name: 'get_latest_brief', description: '读取最近一次生成的市场简报（含是否已在 dsh 对话内播报的标记）。', parameters: input({}), schema: output({ id: { type: 'string' }, period: { type: 'string' }, trade_date: { type: 'string' }, summary: { type: 'string' }, dsh_pushed: { type: 'boolean' } }) },
  {
    name: 'investment_context',
    description: '按需读取交易后端已持久化的最新投研上下文。不接受 JSON 字符串、URL 或路径，也不会读取浏览器本地状态。可读取组合、策略、影子验证、自进化、报告或产业影响上下文；报告领域可用受限报告 ID 读取对应详情。',
    parameters: input({
      domain: { type: 'string', description: '要读取的投研领域', enum: ['portfolio', 'strategy', 'shadow', 'evolution', 'reports', 'industry'] },
      reference: { type: 'string', description: '可选；仅 reports 领域接受 32 位小写十六进制报告 ID，用于读取该报告详情' },
      strategy_id: { type: 'string', description: '可选；仅 evolution 领域接受安全策略 ID，用于读取单策略进化诊断' },
    }, ['domain']),
    schema: output({ domain: { type: 'string', description: '实际读取的投研领域', enum: ['portfolio', 'strategy', 'shadow', 'evolution', 'reports', 'industry'] }, resources: { description: '按稳定资源名分组的后端无损 JSON' } }),
  },
  {
    name: 'investment_research_context',
    description: '读取当前对话在“我的投研”中已确认的策略与投资标的，并返回策略详情、推荐状态、适用性和风险提示。参数固定为空；会话 ID 只取自当前工具执行上下文，不接受模型传入。只读，不执行交易，也不改变策略状态。',
    parameters: input({}),
    schema: output({
      status: { type: 'string', description: '上下文读取状态', enum: ['ready', 'empty', 'invalid', 'unavailable'] },
      context_revision: { type: 'number', description: '会话选择的服务端修订号' },
      context_updated_at: { type: 'string', description: '会话选择的最近更新时间' },
      strategy: { description: '策略池中的最新策略详情；未选择或已失效时为空' },
      instrument: { description: '用户在输入框下方确认的投资标的；未选择时为空' },
      recommended: { type: 'boolean', description: '仅 active 且 passed 时为 true' },
      compatibility: { type: 'string', description: '策略与标的的适用关系', enum: ['not_applicable', 'direct', 'method_only'] },
      warnings: {
        type: 'array', description: '需要模型向用户明确披露的风险提示',
        items: output({
          code: { type: 'string', enum: ['STRATEGY_NOT_RECOMMENDED', 'STRATEGY_NOT_FOUND', 'METHOD_TRANSFER', 'CONTEXT_UNAVAILABLE'] },
          message: { type: 'string' },
        }),
      },
    }),
  },
] as const

afterEach(() => vi.unstubAllGlobals())

async function install(config: Plugin.Config = {
  backendMode: 'external', backendBaseUrl: 'http://adapter.test', streamTimeoutMs: 1_000,
  enableInChatPush: false, pushPollMs: 30_000, pushSessions: [],
}): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = []
  let baseUrl = config.backendBaseUrl ?? 'http://127.0.0.1:8000'
  await Plugin.apply({
    async effect(callback: () => Promise<() => void>) { return callback() },
    investmentPythonRuntime: {
      register(definition: { baseUrl: string }) { baseUrl = definition.baseUrl; return () => {} },
      async acquire() { return { id: 'trading-core', baseUrl, ownership: 'external', async release() {} } },
      registerCapability() { return () => {} },
      assertCapability() {},
    },
    tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} } },
    agents: { roots: () => [] },
    systemPrompt: { section() { return () => {} } },
  } as never, config)
  return tools
}

async function installWithPreflight(assertCapability: (backendId: string, use: string) => void): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = []
  await Plugin.apply({
    async effect(callback: () => Promise<() => void>) { return callback() },
    investmentPythonRuntime: {
      register() { return () => {} },
      async acquire() { return { id: 'trading-core', baseUrl: 'http://adapter.test', ownership: 'external', async release() {} } },
      registerCapability() { return () => {} },
      assertCapability,
    },
    tools: { register(tool: RegisteredTool) { tools.push(tool); return () => {} } },
    agents: { roots: () => [] },
    systemPrompt: { section() { return () => {} } },
  } as never, { backendMode: 'external', backendBaseUrl: 'http://adapter.test', enableInChatPush: false })
  return tools
}

describe('stock-analysis function plugin', () => {
  it('has only the preserved named function-plugin API', () => {
    const config: Plugin.Config = {}
    expect(Plugin.name).toBe('investment-stock-analysis')
    expect(Plugin.inject).toEqual(['tools', 'agents', 'investmentPythonRuntime', 'systemPrompt'])
    expect(Plugin.apply).toBeTypeOf('function')
    expect(config).toEqual({})
  })

  it('reads the confirmed strategy and target from the exact executing session', async () => {
    const requests: string[] = []
    const strategy = {
      id: 'strategy-1', name: '稳健趋势', status: 'active', verification_status: 'passed',
      symbols: ['600519'],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url)
      if (url.endsWith('/research-chat/contexts/session%3A1')) {
        return new Response(JSON.stringify({
          exists: true,
          context: {
            schema_version: 1,
            session_id: 'session:1',
            strategy_id: 'strategy-1',
            instrument: { code: '600519', name: '贵州茅台', market: '沪市', type: 'stock' },
            revision: 2,
            updated_at: '2026-09-01T02:00:00Z',
          },
        }))
      }
      if (url.endsWith('/strategies/strategy-1')) return new Response(JSON.stringify(strategy))
      return new Response('not found', { status: 404 })
    }))
    const tool = (await install()).find(candidate => candidate.name === 'investment_research_context')

    expect(tool).toBeDefined()
    await expect(tool!.execute({}, {
      signal: new AbortController().signal,
      agent: { inject() {}, session: { header: { id: 'session:1' } } },
    })).resolves.toEqual({
      status: 'ready',
      context_revision: 2,
      context_updated_at: '2026-09-01T02:00:00Z',
      strategy,
      instrument: { code: '600519', name: '贵州茅台', market: '沪市', type: 'stock' },
      recommended: true,
      compatibility: 'direct',
      warnings: [],
    })
    expect(requests).toEqual([
      'http://adapter.test/research-chat/contexts/session%3A1',
      'http://adapter.test/strategies/strategy-1',
    ])
  })

  it('keeps schema names and maps every tool argument to the existing adapter endpoint', async () => {
    const requests: Array<[string, string, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push([url, init?.method ?? 'GET', init?.body as string | undefined])
      if (url.endsWith('/stream')) {
        return new Response('event: result\ndata: {"signal":{},"reports":{},"performance_metrics":{}}\n\nevent: done\ndata: {}\n\n')
      }
      if (init?.method === 'POST' && (url.endsWith('/analyze') || url.endsWith('/holdings/analyze') || url.endsWith('/brief'))) {
        return new Response('{"task_id":"t1"}')
      }
      return new Response('{"saved":1,"tickers":[],"risk_profile":"balanced","label":"稳健","id":"b1"}')
    }))
    const tools = await install()
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    expect(
      tools.map(({ name, description, parameters, output: { schema } }) => ({ name, description, parameters, schema })),
    ).toEqual(STOCK_CONTRACTS)
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
      investment_context: { domain: 'reports' },
      investment_research_context: {},
    }
    const callViews = {
      analyze_stock: { card: 'generic', title: '📈 分析 600519', kind: 'other', rawInput: presentationArgs.analyze_stock },
      analyze_holdings: { card: 'generic', title: '🧺 分析持仓（deep）', kind: 'other', rawInput: presentationArgs.analyze_holdings },
      market_brief: { card: 'generic', title: '📊 now 简报', kind: 'other', rawInput: presentationArgs.market_brief },
      set_watchlist: { card: 'generic', title: '⭐ 设置自选列表', kind: 'other' },
      set_holdings: { card: 'generic', title: '💼 保存持仓', kind: 'other' },
      get_watchlist: { card: 'generic', title: '⭐ 读取自选列表', kind: 'other' },
      set_risk_profile: { card: 'generic', title: '🎯 设置风险偏好', kind: 'other' },
      get_risk_profile: { card: 'generic', title: '🎯 读取风险偏好', kind: 'other' },
      get_latest_brief: { card: 'generic', title: '📥 读取最近简报', kind: 'other' },
      investment_context: { card: 'generic', title: '🧭 读取报告上下文', kind: 'other', rawInput: presentationArgs.investment_context },
      investment_research_context: { card: 'generic', title: '🧭 读取当前会话投研上下文', kind: 'other' },
    }
    const resultTitles = {
      analyze_stock: 'AI 多智能体分析完成', analyze_holdings: '持仓风险分析完成', market_brief: '市场简报已生成',
      set_watchlist: '自选列表已更新', set_holdings: '持仓已保存', get_watchlist: '自选列表',
      set_risk_profile: '风险偏好已更新', get_risk_profile: '风险偏好', get_latest_brief: '最近简报',
      investment_context: '投研上下文已读取',
      investment_research_context: '当前会话投研上下文已读取',
    }
    const resultText = {
      analyze_stock: '分析完成。查看模型回复中的完整决策与分步报告。', analyze_holdings: '组合市值/浮盈/集中度/逐股风险已生成。',
      market_brief: '查看模型回复中的完整简报与机会点。', set_watchlist: '已保存 0 只自选股。', set_holdings: '已保存 0 条持仓。',
      get_watchlist: '[]', set_risk_profile: '', get_risk_profile: '', get_latest_brief: '暂无简报',
      investment_context: '已按需读取报告上下文。',
      investment_research_context: '已读取输入框下方确认的策略与标的。',
    }
    for (const tool of tools) {
      const args = presentationArgs[tool.name]!
      const toolName = tool.name as keyof typeof callViews
      expect(tool.presentCall?.(args)).toEqual(callViews[toolName])
      expect(tool.presentResult?.(args, { meta: '完成' })).toEqual({
        card: 'generic', title: resultTitles[toolName], content: [{ type: 'text', text: toolName === 'analyze_stock' ? '完成' : resultText[toolName] }],
      })
      expect(tool.presentResult?.(args, {})).toEqual({
        card: 'generic',
        title: resultTitles[toolName],
        content: [{ type: 'text', text: resultText[toolName] }],
      })
      expect(tool.output.render?.(args, {
        signal: {}, reports: {}, performance_metrics: {}, saved: 1, tickers: [], holdings: [],
        risk_profile: 'balanced', label: '稳健', id: 'b1', period: 'pre_market', trade_date: '2026-08-20', dsh_pushed: false,
      })?.[0]).toMatchObject({ type: 'text' })
    }
    const outputValues: Record<string, unknown> = {
      analyze_stock: { signal: { ticker: '600519' }, reports: {} },
      analyze_holdings: { signal: {}, reports: { portfolio: '适配器持仓报告' } },
      market_brief: { signal: { summary: '适配器市场简报' }, reports: {} },
      set_watchlist: {},
      set_holdings: {},
      get_watchlist: {},
      set_risk_profile: {},
      get_risk_profile: {},
      get_latest_brief: { id: 'b1', period: 'post_market', dsh_pushed: true },
      investment_context: { domain: 'reports', resources: { reports: { count: 1 } } },
      investment_research_context: {
        status: 'ready', strategy: { name: '稳健趋势' },
        instrument: { code: '600519', name: '贵州茅台', market: '沪市', type: 'stock' },
        recommended: true, compatibility: 'direct', warnings: [],
      },
    }
    const renderedText = {
      analyze_stock: '## — · 600519\n\n| 目标价 | 置信度 | 风险分 |\n|---|---|---|\n| ¥— | — | — |',
      analyze_holdings: '适配器持仓报告', market_brief: '适配器市场简报', set_watchlist: '已保存 0 只自选股。',
      set_holdings: '已保存 0 条持仓。', get_watchlist: '自选股：（空）', set_risk_profile: '已切换风险偏好：—（）',
      get_risk_profile: '当前风险偏好：未知（）', get_latest_brief: '最近简报：盘后 · （dsh 已播报：是）',
      investment_context: '已读取报告上下文：\n{\n  "reports": {\n    "count": 1\n  }\n}',
      investment_research_context: '当前会话：稳健趋势 · 贵州茅台（600519）；适用性：direct。',
    }
    for (const [toolName, value] of Object.entries(outputValues)) {
      const tool = byName.get(toolName)!
      const args = presentationArgs[toolName]!
      expect(tool.output.render?.(args, value)).toEqual([{ type: 'text', text: renderedText[toolName as keyof typeof renderedText] }])
      const presentationMeta = {
        analyze_stock: '## — · 600519\n\n| 目标价 | 置信度 | 风险分 |\n|---|---|---|\n| ¥— | — | — |',
        analyze_holdings: '## 🧺 持仓组合概览（快速定量 · 0 只）\n\n| 总市值 | 总成本 | 浮动盈亏 | 加权风险 | 组合波动 | 集中度 HHI |\n|---|---|---|---|---|---|\n| ¥— | ¥— | ¥—（—） | — | — | — |',
        market_brief: '## 📊 A股盘中简报 · （0 个机会点）',
      }
      if (toolName in presentationMeta) {
        expect(tool.output.presentationMeta?.(args, value)).toEqual(presentationMeta[toolName as keyof typeof presentationMeta])
      } else expect(tool.output.presentationMeta).toBeUndefined()
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
    await byName.get('investment_context')!.execute({ domain: 'reports' }, exec)
    await byName.get('investment_research_context')!.execute({}, exec)

    const defaults = new Map((await install({})).map(tool => [tool.name, tool]))
    await defaults.get('analyze_stock')!.execute({ ticker: '600519' }, exec)
    await defaults.get('analyze_holdings')!.execute({}, exec)
    await defaults.get('market_brief')!.execute({}, exec)
    await defaults.get('set_holdings')!.execute({ holdings: [] }, exec)

    expect(requests).toEqual([
      ['http://adapter.test/analyze', 'POST', '{"ticker":"600519","date":"2026-08-20","research_depth":"deep","config_overrides":{"rounds":2},"risk_profile":"balanced"}'],
      ['http://adapter.test/analyze/t1/stream', 'GET', undefined],
      ['http://adapter.test/holdings/analyze', 'POST', '{"mode":"quick","holdings":[{"ticker":"600519","quantity":1,"cost_price":10}],"use_saved":false,"risk_profile":"conservative"}'],
      ['http://adapter.test/analyze/t1/stream', 'GET', undefined],
      ['http://adapter.test/brief', 'POST', '{"period":"post_market","scope":"watchlist","tickers":["600519"],"risk_profile":"aggressive"}'],
      ['http://adapter.test/analyze/t1/stream', 'GET', undefined],
      ['http://adapter.test/watchlist', 'POST', '{"tickers":["600519"]}'],
      ['http://adapter.test/holdings/save', 'POST', '{"holdings":[{"ticker":"600519","quantity":1,"cost_price":10}]}'],
      ['http://adapter.test/watchlist', 'GET', undefined],
      ['http://adapter.test/risk_profile', 'POST', '{"risk_profile":"aggressive"}'],
      ['http://adapter.test/risk_profile', 'GET', undefined],
      ['http://adapter.test/brief/latest', 'GET', undefined],
      ['http://adapter.test/reports?limit=20', 'GET', undefined],
      ['http://127.0.0.1:8000/analyze', 'POST', '{"ticker":"600519"}'],
      ['http://127.0.0.1:8000/analyze/t1/stream', 'GET', undefined],
      ['http://127.0.0.1:8000/holdings/analyze', 'POST', '{"mode":"deep"}'],
      ['http://127.0.0.1:8000/analyze/t1/stream', 'GET', undefined],
      ['http://127.0.0.1:8000/brief', 'POST', '{"period":"now"}'],
      ['http://127.0.0.1:8000/analyze/t1/stream', 'GET', undefined],
      ['http://127.0.0.1:8000/holdings/save', 'POST', '{"holdings":[]}'],
    ])
  })

  it('renders successful and empty adapter values without exposing transport errors as schemas', async () => {
    const byName = new Map((await install()).map(tool => [tool.name, tool]))
    expect(byName.get('set_watchlist')!.output.render?.({}, { saved: 2 })).toEqual([{ type: 'text', text: '已保存 2 只自选股。' }])
    expect(byName.get('get_watchlist')!.output.render?.({}, { tickers: [] })[0]!.text).toContain('（空）')
    expect(byName.get('get_latest_brief')!.output.render?.({}, {})[0]!.text).toBe('暂无简报')
  })

  it('labels global and scoped evolution context calls separately', async () => {
    const byName = new Map((await install()).map(tool => [tool.name, tool]))
    const tool = byName.get('investment_context')!
    expect(tool.presentCall?.({ domain: 'evolution' })).toMatchObject({
      title: '🧭 自进化全局看板',
    })
    expect(tool.presentCall?.({ domain: 'evolution', strategy_id: 'strategy-1' })).toMatchObject({
      title: '🧭 策略进化诊断',
    })
  })

  it('preflights every operation before its adapter HTTP or SSE side effect', async () => {
    const assertCapability = vi.fn()
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/stream')) return new Response('event: result\ndata: {"signal":{},"reports":{},"performance_metrics":{}}\n\nevent: done\ndata: {}\n\n')
      if (init?.method === 'POST' && (url.endsWith('/analyze') || url.endsWith('/holdings/analyze') || url.endsWith('/brief'))) return new Response('{"task_id":"t1"}')
      return new Response('{"saved":1,"tickers":[],"risk_profile":"balanced","label":"稳健"}')
    })
    vi.stubGlobal('fetch', fetch)
    const byName = new Map((await installWithPreflight(assertCapability)).map(tool => [tool.name, tool]))
    const exec = { signal: new AbortController().signal }
    await byName.get('analyze_stock')!.execute({ ticker: '600519' }, exec)
    await byName.get('analyze_holdings')!.execute({}, exec)
    await byName.get('market_brief')!.execute({}, exec)
    await byName.get('set_watchlist')!.execute({ tickers: [] }, exec)
    await byName.get('set_holdings')!.execute({ holdings: [] }, exec)
    await byName.get('get_watchlist')!.execute({}, exec)
    await byName.get('set_risk_profile')!.execute({ risk_profile: 'balanced' }, exec)
    await byName.get('get_risk_profile')!.execute({}, exec)
    await byName.get('get_latest_brief')!.execute({}, exec)
    await byName.get('investment_context')!.execute({ domain: 'reports' }, exec)
    await byName.get('investment_research_context')!.execute({}, exec)
    expect(assertCapability.mock.calls).toEqual([
      ['trading-core', 'llm-required'], ['trading-core', 'llm-required'], ['trading-core', 'llm-required'],
      ['trading-core', 'non-llm'], ['trading-core', 'non-llm'], ['trading-core', 'non-llm'],
      ['trading-core', 'non-llm'],
      ['trading-core', 'non-llm'],
      ['trading-core', 'non-llm'], ['trading-core', 'non-llm'], ['trading-core', 'non-llm'],
    ])

    const blocked = vi.fn(() => { throw new Error('credential missing') })
    const blockedTools = new Map((await installWithPreflight(blocked)).map(tool => [tool.name, tool]))
    const agent = { inject: vi.fn() }
    for (const [name, args] of [
      ['analyze_stock', { ticker: '600519' }],
      ['analyze_holdings', {}],
      ['market_brief', {}],
    ] as const) {
      fetch.mockClear()
      agent.inject.mockClear()
      await expect(blockedTools.get(name)!.execute(args, { signal: new AbortController().signal, agent })).rejects.toThrow('credential missing')
      expect(fetch).not.toHaveBeenCalled()
      expect(agent.inject).not.toHaveBeenCalled()
    }
  })

  it('retains presenter and saved-holdings fallbacks behind the validated public tool wrapper', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-tools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-tools')>()
      return { ...actual, defineTool: <T>(definition: T) => definition }
    })
    const rawPlugin = await import('../src/index.ts')
    const rawTools: Array<Record<string, unknown>> = []
    const requests: Array<[string, string, string | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push([url, init?.method ?? 'GET', init?.body as string | undefined])
      return new Response('{"saved":0}')
    }))
    await rawPlugin.apply({
      async effect(callback: () => Promise<() => void>) { return callback() },
      investmentPythonRuntime: {
        register() { return () => {} },
        async acquire() { return { id: 'trading-core', baseUrl: 'http://127.0.0.1:8000', ownership: 'external', async release() {} } },
        registerCapability() { return () => {} },
        assertCapability() {},
      },
      tools: { register(tool: Record<string, unknown>) { rawTools.push(tool); return () => {} } },
      agents: { roots: () => [] },
      systemPrompt: { section() { return () => {} } },
    } as never, {})

    const byName = new Map(rawTools.map(tool => [tool.name as string, tool]))
    const analyze = byName.get('analyze_stock')!
    const setHoldings = byName.get('set_holdings')!
    expect((analyze.presentCall as (args: unknown) => { title: string })({}).title).toBe('📈 分析 ')
    await expect((setHoldings.execute as (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>)(
      { holdings: undefined },
      { signal: new AbortController().signal },
    )).resolves.toEqual({ saved: 0 })
    expect(requests).toEqual([['http://127.0.0.1:8000/holdings/save', 'POST', '{"holdings":[]}']])
  })
})
