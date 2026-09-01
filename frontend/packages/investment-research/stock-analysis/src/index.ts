// TradingAgents-CN × DeepSeek Harness 插件
// 注册 analyze_stock 工具：对话式触发 → Python 适配器(SSE) → 引擎 → Signal。
//
// 依赖适配器服务（adapter/，S1-S2 已在 8000 端口跑通）：
//   POST /analyze                      启动任务 → { task_id }
//   GET  /analyze/{id}/stream          SSE 进度流（stage/result/error/done）
//   GET  /analyze/{id}/result          最终 Signal + 分步报告
//
// 流式进度映射（dsh 工具是请求/响应模型，没有 stream.write）：
//   execute 内消费适配器 SSE，每个 stage 事件 → exec.agent.inject() 追加到
//   模型上下文，对话轨迹实时可见分析阶段；最终结果走 canonical value。
//   参考：docs/cookbook/adding-a-tool.md · docs/cookbook/extension-cookbook.md

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { PythonBackendDefinition, PythonBackendLease } from '@deepseek-ai/dsh-investment-python-runtime'
import {
  consumeSse,
  getLatestBrief,
  getInvestmentContext,
  getRiskProfile,
  getWatchlist,
  saveHoldings,
  setRiskProfile,
  setWatchlist,
  startAnalysis,
  startTask,
  type HoldingInput,
  type InvestmentContextDomain,
} from './client.ts'
import { createBriefPusher } from './brief-pusher.ts'
import {
  INVESTMENT_RESEARCH_CONTEXT_PROMPT,
  renderInvestmentResearchContext,
  resolveInvestmentResearchContext,
  type InvestmentResearchContextResult,
} from './research-context.ts'
import {
  renderBrief,
  renderBriefCard,
  renderFullReport,
  renderHoldingsCard,
  renderHoldingsReport,
  renderSignalCard,
  type AnalyzeResult,
  type BriefSignal,
  type HoldingsSignal,
} from './render.ts'

export const name = 'investment-stock-analysis'

/** Stock-analysis adapter, streaming, and optional in-chat brief settings. */
export interface Config {
  /** Runtime ownership mode. Defaults to managed. */
  backendMode?: 'managed' | 'external'
  /** Backend origin verified by the runtime. Defaults to `http://127.0.0.1:8000`. */
  backendBaseUrl?: string
  /** Explicit absolute trading-core checkout when repository discovery is unavailable. */
  backendProjectDir?: string
  /** Trading backend implementation selected explicitly for managed startup. Defaults to engine. */
  backendRunner?: 'engine' | 'fake'
  /** Maximum SSE task duration in milliseconds. Defaults to 600000. */
  streamTimeoutMs?: number
  /** Enable periodic brief delivery to root agent sessions. Defaults to false. */
  enableInChatPush?: boolean
  /** Requested brief polling interval in milliseconds. Defaults to 120000 and is clamped to at least 30000. */
  pushPollMs?: number
  /** Root agent session ids eligible for brief delivery; an empty list selects all active roots. */
  pushSessions?: string[]
}

interface ResolvedConfig {
  adapterBaseUrl: string
  streamTimeoutMs: number
  enableInChatPush: boolean
  pushPollMs: number
  pushSessions: string[]
}

function optionalText(value: string | undefined): string {
  return value ?? ''
}

function stringValue(value: unknown): string {
  return String(value)
}

export const Config: Schema<Config> = Schema.object({
  backendMode: Schema.union(['managed', 'external']).default('managed'),
  backendBaseUrl: Schema.string().default('http://127.0.0.1:8000'),
  backendProjectDir: Schema.string(),
  backendRunner: Schema.union(['engine', 'fake']).default('engine'),
  streamTimeoutMs: Schema.number().default(600_000),
  enableInChatPush: Schema.boolean().description('dsh 对话内定时播报简报（外部推送由适配器 scheduler 负责）').default(false),
  pushPollMs: Schema.number().description('对话内播报轮询周期 ms').default(120_000),
  pushSessions: Schema.array(Schema.string()).description('播报目标会话 id；空 = 所有活跃会话').default([]),
})

export const inject = ['tools', 'agents', 'investmentPythonRuntime', 'systemPrompt']

/** 风险偏好参数（三个流式工具共用）。缺省用适配器已保存偏好。 */
const RISK_PROFILE_PARAM = {
  type: 'string',
  description: '风险偏好：conservative(保守)/balanced(稳健)/aggressive(进取)；缺省用已保存偏好',
  enum: ['conservative', 'balanced', 'aggressive'] as const,
} as const

const INVESTMENT_CONTEXT_LABELS: Readonly<Record<InvestmentContextDomain, string>> = {
  portfolio: '组合与风险',
  strategy: '策略研究',
  shadow: '影子验证',
  evolution: '自进化',
  reports: '报告',
  industry: '产业影响',
}

/** 通用流式任务：POST 启动 → SSE 消费 → 返回 lossless 结果。 */
async function runStreamingTask(
  config: ResolvedConfig,
  exec: ToolRunContext,
  path: string,
  body: Record<string, unknown>,
): Promise<{ signal: JsonValue; reports: JsonValue; performance_metrics: JsonValue }> {
  const taskId = await startTask(config.adapterBaseUrl, path, body, exec.signal)
  const result = await consumeSse(
    `${config.adapterBaseUrl}/analyze/${taskId}/stream`,
    exec,
    config.streamTimeoutMs,
  )
  return result as { signal: JsonValue; reports: JsonValue; performance_metrics: JsonValue }
}

async function setupFeatures(ctx: Context, resolvedConfig: ResolvedConfig): Promise<() => Promise<void>> {
  const toolDisposers: Array<() => void> = []
  const disposeResearchPrompt = ctx.systemPrompt.section({
    name: 'tool:investment-research-context',
    order: 111,
    text: INVESTMENT_RESEARCH_CONTEXT_PROMPT,
  })
  const disposePusher = createBriefPusher(ctx, {
    adapterBaseUrl: resolvedConfig.adapterBaseUrl,
    enableInChatPush: resolvedConfig.enableInChatPush,
    pushPollMs: resolvedConfig.pushPollMs,
    pushSessions: resolvedConfig.pushSessions,
  })

  const register = (tool: Parameters<Context['tools']['register']>[0]): void => {
    toolDisposers.push(ctx.tools.register(tool))
  }

  const disposeFeatures = async (): Promise<void> => {
    const disposers = toolDisposers.reverse()
    const disposeFrom = async (index: number): Promise<void> => {
      if (index === disposers.length) return
      const dispose = disposers[index]
      if (dispose === undefined) return
      try {
        dispose()
      } finally {
        await disposeFrom(index + 1)
      }
    }
    try {
      await disposeFrom(0)
    } finally {
      try {
        await disposePusher?.()
      } finally {
        disposeResearchPrompt()
      }
    }
  }

  try {
    register(
      defineTool({
        name: 'analyze_stock',
        description:
        '对 A 股股票进行多智能体 AI 分析，返回买入/持有/卖出决策、目标价、置信度与分步报告。' +
        '研究档位按延迟从低到高扩展分析覆盖：quick 仅市场，basic 增加基本面，standard 覆盖市场/基本面/新闻/情绪，' +
        'deep/full 保持四分析师并增加多空与风险辩论轮次。' +
        '输入可以是股票代码（如 600519）或名称（如 贵州茅台）；date 留空表示最近交易日。',
        parameters: {
          ticker: {
            type: 'string',
            required: true,
            description: '股票代码（如 600519）或名称（如 贵州茅台）',
          },
          date: {
            type: 'string',
            description: '分析日期 YYYY-MM-DD，可选，默认最近交易日',
          },
          research_depth: {
            type: 'string',
            description:
            '研究深度：quick=仅市场、最低延迟；basic=市场+基本面；standard=四分析师+1 轮多空/风险辩论（默认）；' +
            'deep=四分析师+2 轮；full=四分析师+3 轮并启用在线新闻，延迟依次增加',
            enum: ['quick', 'basic', 'standard', 'deep', 'full'] as const,
          },
          config_overrides: {
            type: 'json',
            description: '可选，会话级引擎参数覆盖（如 max_debate_rounds）',
          },
          risk_profile: RISK_PROFILE_PARAM,
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              signal: { type: 'json', description: '统一决策信号（action/target_price/confidence/risk_score/reasoning）' },
              reports: { type: 'json', description: '各分析阶段的分步 Markdown 报告' },
              performance_metrics: { type: 'json', description: '各节点耗时统计' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: renderFullReport(value as AnalyzeResult) },
          ],
          // 结果卡依赖的唯一事实源；纯函数，replay 可用
          presentationMeta: (_args, value) =>
            renderSignalCard((value as AnalyzeResult).signal),
        },
        presentCall: args => ({
          card: 'generic',
          title: `📈 分析 ${stringValue(optionalText(args.ticker))}`,
          kind: 'other',
          rawInput: args,
        }),
        presentResult: (_args, result) => ({
          card: 'generic',
          title: 'AI 多智能体分析完成',
          content: [
            {
              type: 'text',
              text:
              typeof result.meta === 'string'
                ? result.meta
                : '分析完成。查看模型回复中的完整决策与分步报告。',
            },
          ],
        }),
        async execute(args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'llm-required')
          // 1) 启动分析任务
          const body: Record<string, unknown> = {
            ticker: args.ticker,
          }
          if (args.date !== undefined) body.date = args.date
          if (args.research_depth !== undefined) body.research_depth = args.research_depth
          if (args.config_overrides !== undefined) body.config_overrides = args.config_overrides
          if (args.risk_profile !== undefined) body.risk_profile = args.risk_profile

          const taskId = await startAnalysis(resolvedConfig.adapterBaseUrl, body, exec.signal)

          // 2) 消费 SSE 进度流，逐阶段注入模型上下文
          // consumeSse 内部会逐阶段 injectProgress 到模型上下文
          const result = await consumeSse(
            `${resolvedConfig.adapterBaseUrl}/analyze/${taskId}/stream`,
            exec,
            resolvedConfig.streamTimeoutMs,
          )
          // 适配器返回体是 lossless JSON；render/presentationMeta 内再按 AnalyzeResult 读取
          return result as { signal: JsonValue; reports: JsonValue; performance_metrics: JsonValue }
        },
      }),
    )

    // ── 功能3：持仓风险分析（analyze_holdings）────────────────────────────
    register(
      defineTool({
        name: 'analyze_holdings',
        description:
        '分析当前持仓的风险：市值/浮盈/权重/集中度 HHI/行业暴露 + 逐股年化波动率/最大回撤/β。' +
        'deep 模式对每只股票并行跑引擎 standard 深度（四分析师，约 3-5 分钟），输出每股风险分与买卖信号；' +
        'quick 模式仅定量风险（秒级）。holdings 传持仓列表（代码+股数+成本价）；不传则用已保存持仓。',
        parameters: {
          holdings: {
            type: 'json',
            description: '持仓列表 [{ticker:"600519", quantity:200, cost_price:1480}, ...]；缺省用已保存持仓',
          },
          mode: {
            type: 'string',
            enum: ['quick', 'deep'],
            description: 'deep=逐股 standard 四分析师引擎分析(慢,约3-5分钟), quick=仅定量风险(秒级)，默认 deep',
          },
          use_saved: {
            type: 'boolean',
            description: 'holdings 为空时是否回退到已保存持仓，默认 true',
          },
          risk_profile: RISK_PROFILE_PARAM,
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              signal: { type: 'json', description: '组合信号（市值/浮盈/风险/逐股明细）' },
              reports: { type: 'json', description: 'Markdown 报告' },
              performance_metrics: { type: 'json', description: '耗时统计' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: renderHoldingsReport(value as { signal: HoldingsSignal; reports?: Record<string, string> }) },
          ],
          presentationMeta: (_args, value) => renderHoldingsCard((value as { signal: HoldingsSignal }).signal),
        },
        presentCall: args => ({
          card: 'generic',
          title: `🧺 分析持仓（${stringValue(args.mode ?? 'deep')}）`,
          kind: 'other',
          rawInput: args,
        }),
        presentResult: () => ({
          card: 'generic',
          title: '持仓风险分析完成',
          content: [{ type: 'text', text: '组合市值/浮盈/集中度/逐股风险已生成。' }],
        }),
        async execute(args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'llm-required')
          const body: Record<string, unknown> = { mode: args.mode ?? 'deep' }
          if (args.holdings !== undefined) body.holdings = args.holdings
          if (args.use_saved !== undefined) body.use_saved = args.use_saved
          if (args.risk_profile !== undefined) body.risk_profile = args.risk_profile
          return runStreamingTask(resolvedConfig, exec, '/holdings/analyze', body)
        },
      }),
    )

    // ── 功能4：市场简报（market_brief）──────────────────────────────────
    register(
      defineTool({
        name: 'market_brief',
        description:
        '生成 A股盘前/盘后市场简报：指数、涨跌家数、板块动向、北向资金、龙虎榜、资讯汇总，' +
        '并挖掘事件驱动机会点（自选股异动/龙虎榜主力净买入/板块资金异动/资讯事件）。' +
        'period 选 pre_market(盘前)/post_market(盘后)/now(盘中)。结果同时可推送至企业微信/Server酱。',
        parameters: {
          period: {
            type: 'string',
            enum: ['pre_market', 'post_market', 'now'],
            description: 'pre_market=盘前, post_market=盘后, now=当前（默认 now）',
          },
          scope: {
            type: 'string',
            description: '覆盖范围: all/market/industry/concept/news/watchlist，默认 all',
          },
          tickers: {
            type: 'json',
            description: '覆盖的自选股代码列表；缺省用已保存 watchlist',
          },
          risk_profile: RISK_PROFILE_PARAM,
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              signal: { type: 'json', description: '简报信号（summary 为 Markdown 简报）' },
              reports: { type: 'json', description: 'Markdown 报告' },
              performance_metrics: { type: 'json', description: '耗时统计' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: renderBrief(value as { signal: BriefSignal }) },
          ],
          presentationMeta: (_args, value) => renderBriefCard((value as { signal: BriefSignal }).signal),
        },
        presentCall: args => ({
          card: 'generic',
          title: `📊 ${stringValue(args.period ?? 'now')} 简报`,
          kind: 'other',
          rawInput: args,
        }),
        presentResult: () => ({
          card: 'generic',
          title: '市场简报已生成',
          content: [{ type: 'text', text: '查看模型回复中的完整简报与机会点。' }],
        }),
        async execute(args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'llm-required')
          const body: Record<string, unknown> = { period: args.period ?? 'now' }
          if (args.scope !== undefined) body.scope = args.scope
          if (args.tickers !== undefined) body.tickers = args.tickers
          if (args.risk_profile !== undefined) body.risk_profile = args.risk_profile
          return runStreamingTask(resolvedConfig, exec, '/brief', body)
        },
      }),
    )

    // ── 自选列表（set_watchlist / get_watchlist）────────────────────────
    register(
      defineTool({
        name: 'set_watchlist',
        description: '整体替换自选股票列表（覆盖 600519、000858 等），供简报/持仓分析的 watchlist 维度使用。',
        parameters: {
          tickers: {
            type: 'json',
            required: true,
            description: '自选股票代码列表，如 ["600519","000858","300750"]',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { saved: { type: 'number', description: '保存条数' } },
          },
          render: (_args, value) => [
            { type: 'text', text: `已保存 ${String((value).saved ?? 0)} 只自选股。` },
          ],
        },
        presentCall: () => ({ card: 'generic', title: '⭐ 设置自选列表', kind: 'other' }),
        presentResult: (_args, result) => ({
          card: 'generic',
          title: '自选列表已更新',
          content: [{ type: 'text', text: `已保存 ${String((result as { saved?: number }).saved ?? 0)} 只自选股。` }],
        }),
        async execute(args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          const tickers = (args as { tickers: string[] }).tickers
          return (await setWatchlist(resolvedConfig.adapterBaseUrl, tickers, exec.signal)) as { saved?: number }
        },
      }),
    )

    // ── 持仓保存（set_holdings，供 analyze_holdings 的 use_saved 复用）──
    register(
      defineTool({
        name: 'set_holdings',
        description:
        '保存/整体替换当前持仓到本地（供 analyze_holdings 不传 holdings 时复用）。' +
        'holdings 为 [{ticker:"600519", quantity:200, cost_price:1500}, ...]，股数与原币成本价。',
        parameters: {
          holdings: {
            type: 'json',
            required: true,
            description: '持仓列表 [{ticker, quantity, cost_price}, ...]',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { saved: { type: 'number', description: '保存条数' } },
          },
          render: (_args, value) => [
            { type: 'text', text: `已保存 ${String((value).saved ?? 0)} 条持仓。` },
          ],
        },
        presentCall: () => ({ card: 'generic', title: '💼 保存持仓', kind: 'other' }),
        presentResult: (_args, result) => ({
          card: 'generic',
          title: '持仓已保存',
          content: [{ type: 'text', text: `已保存 ${String((result as { saved?: number }).saved ?? 0)} 条持仓。` }],
        }),
        async execute(args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          const holdings = ((args as { holdings: unknown }).holdings ?? []) as HoldingInput[]
          return (await saveHoldings(resolvedConfig.adapterBaseUrl, holdings, exec.signal)) as { saved?: number }
        },
      }),
    )

    register(
      defineTool({
        name: 'get_watchlist',
        description: '读取当前自选股票列表。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { tickers: { type: 'array', items: { type: 'string' }, description: '自选股票代码列表' } },
          },
          render: (_args, value) => [
            { type: 'text', text: `自选股：${((value).tickers ?? []).join('、') || '（空）'}` },
          ],
        },
        presentCall: () => ({ card: 'generic', title: '⭐ 读取自选列表', kind: 'other' }),
        presentResult: (_args, result) => ({
          card: 'generic',
          title: '自选列表',
          content: [{ type: 'text', text: JSON.stringify((result as { tickers?: string[] }).tickers ?? []) }],
        }),
        async execute(_args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          return (await getWatchlist(resolvedConfig.adapterBaseUrl, exec.signal)) as { tickers?: string[] }
        },
      }),
    )

    // ── 风险偏好画像（set_risk_profile / get_risk_profile）────────────────
    register(
      defineTool({
        name: 'set_risk_profile',
        description:
        '保存全局风险偏好画像：conservative(保守，保本控回撤)/balanced(稳健，默认)/aggressive(进取，求高收益)。' +
        '后续所有个股分析/持仓分析/市场简报均按此偏好展开分析框架；单次调用仍可传 risk_profile 覆盖。',
        parameters: {
          risk_profile: {
            type: 'string',
            required: true,
            description: '风险偏好画像：conservative/balanced/aggressive',
            enum: ['conservative', 'balanced', 'aggressive'] as const,
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              risk_profile: { type: 'string', description: '已保存的画像键名' },
              label: { type: 'string', description: '画像中文名' },
            },
          },
          render: (_args, value) => {
            const v = value
            return [
              {
                type: 'text' as const,
                text: `已切换风险偏好：${v.label ?? v.risk_profile ?? '—'}（${v.risk_profile ?? ''}）`,
              },
            ]
          },
        },
        presentCall: () => ({ card: 'generic', title: '🎯 设置风险偏好', kind: 'other' }),
        presentResult: (_args, result) => ({
          card: 'generic',
          title: '风险偏好已更新',
          content: [{ type: 'text', text: stringValue((result as { label?: string }).label ?? '') }],
        }),
        async execute(args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          const riskProfile = stringValue(args.risk_profile)
          return (await setRiskProfile(resolvedConfig.adapterBaseUrl, riskProfile, exec.signal)) as {
            risk_profile?: string
            label?: string
          }
        },
      }),
    )

    register(
      defineTool({
        name: 'get_risk_profile',
        description: '读取当前保存的风险偏好画像（conservative/balanced/aggressive）及中文名。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              risk_profile: { type: 'string', description: '画像键名' },
              label: { type: 'string', description: '画像中文名' },
            },
          },
          render: (_args, value) => {
            const v = value
            return [
              {
                type: 'text' as const,
                text: `当前风险偏好：${v.label ?? v.risk_profile ?? '未知'}（${v.risk_profile ?? ''}）`,
              },
            ]
          },
        },
        presentCall: () => ({ card: 'generic', title: '🎯 读取风险偏好', kind: 'other' }),
        presentResult: (_args, result) => ({
          card: 'generic',
          title: '风险偏好',
          content: [{ type: 'text', text: stringValue((result as { label?: string }).label ?? '') }],
        }),
        async execute(_args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          return (await getRiskProfile(resolvedConfig.adapterBaseUrl, exec.signal)) as {
            risk_profile?: string
            label?: string
          }
        },
      }),
    )

    // ── 简报读取（get_latest_brief，供对话内推送/主动查询）────────────────
    register(
      defineTool({
        name: 'get_latest_brief',
        description: '读取最近一次生成的市场简报（含是否已在 dsh 对话内播报的标记）。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              period: { type: 'string' },
              trade_date: { type: 'string' },
              summary: { type: 'string' },
              dsh_pushed: { type: 'boolean' },
            },
          },
          render: (_args, value) => {
            const v = value as { id?: string; period?: string; trade_date?: string; dsh_pushed?: boolean }
            const label = v.period === 'pre_market' ? '盘前' : v.period === 'post_market' ? '盘后' : '盘中'
            return [
              {
                type: 'text' as const,
                text: v.id
                  ? `最近简报：${label} · ${v.trade_date ?? ''}（dsh 已播报：${v.dsh_pushed ? '是' : '否'}）`
                  : '暂无简报',
              },
            ]
          },
        },
        presentCall: () => ({ card: 'generic', title: '📥 读取最近简报', kind: 'other' }),
        presentResult: (_args, result) => ({
          card: 'generic',
          title: '最近简报',
          content: [{ type: 'text', text: stringValue((result as { id?: string }).id ?? '暂无简报') }],
        }),
        async execute(_args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          return (await getLatestBrief(resolvedConfig.adapterBaseUrl, exec.signal)) as {
            id?: string
            period?: string
            trade_date?: string
            summary?: string
            dsh_pushed?: boolean
          }
        },
      }),
    )

    register(
      defineTool({
        name: 'investment_context',
        description:
          '按需读取交易后端已持久化的最新投研上下文。不接受 JSON 字符串、URL 或路径，' +
          '也不会读取浏览器本地状态。可读取组合、策略、影子验证、自进化、报告或产业影响上下文；' +
          '报告领域可用受限报告 ID 读取对应详情。',
        parameters: {
          domain: {
            type: 'string',
            required: true,
            description: '要读取的投研领域',
            enum: ['portfolio', 'strategy', 'shadow', 'evolution', 'reports', 'industry'] as const,
          },
          reference: {
            type: 'string',
            description: '可选；仅 reports 领域接受 32 位小写十六进制报告 ID，用于读取该报告详情',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              domain: {
                type: 'string',
                description: '实际读取的投研领域',
                enum: ['portfolio', 'strategy', 'shadow', 'evolution', 'reports', 'industry'] as const,
              },
              resources: { type: 'json', description: '按稳定资源名分组的后端无损 JSON' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: `已读取${INVESTMENT_CONTEXT_LABELS[value.domain as InvestmentContextDomain]}上下文：\n${JSON.stringify(value.resources ?? {}, null, 2)}`,
          }],
        },
        presentCall: args => ({
          card: 'generic',
          title: `🧭 读取${INVESTMENT_CONTEXT_LABELS[args.domain as InvestmentContextDomain]}上下文`,
          kind: 'other',
          rawInput: args,
        }),
        presentResult: args => ({
          card: 'generic',
          title: '投研上下文已读取',
          content: [{
            type: 'text',
            text: `已按需读取${INVESTMENT_CONTEXT_LABELS[args.domain as InvestmentContextDomain]}上下文。`,
          }],
        }),
        async execute(args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          return getInvestmentContext(
            resolvedConfig.adapterBaseUrl,
            stringValue(args.domain) as InvestmentContextDomain,
            exec.signal,
            typeof args.reference === 'string' ? args.reference : undefined,
          )
        },
      }),
    )

    register(
      defineTool({
        name: 'investment_research_context',
        description: '读取当前对话在“我的投研”中已确认的策略与投资标的，并返回策略详情、推荐状态、适用性和风险提示。参数固定为空；会话 ID 只取自当前工具执行上下文，不接受模型传入。只读，不执行交易，也不改变策略状态。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', description: '上下文读取状态', enum: ['ready', 'empty', 'invalid', 'unavailable'] as const },
              context_revision: { type: 'number', description: '会话选择的服务端修订号' },
              context_updated_at: { type: 'string', description: '会话选择的最近更新时间' },
              strategy: { type: 'json', description: '策略池中的最新策略详情；未选择或已失效时为空' },
              instrument: { type: 'json', description: '用户在输入框下方确认的投资标的；未选择时为空' },
              recommended: { type: 'boolean', description: '仅 active 且 passed 时为 true' },
              compatibility: { type: 'string', description: '策略与标的的适用关系', enum: ['not_applicable', 'direct', 'method_only'] as const },
              warnings: {
                type: 'array',
                description: '需要模型向用户明确披露的风险提示',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    code: { type: 'string', enum: ['STRATEGY_NOT_RECOMMENDED', 'STRATEGY_NOT_FOUND', 'METHOD_TRANSFER', 'CONTEXT_UNAVAILABLE'] as const },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: renderInvestmentResearchContext(value as unknown as InvestmentResearchContextResult),
          }],
        },
        presentCall: () => ({ card: 'generic', title: '🧭 读取当前会话投研上下文', kind: 'other' }),
        presentResult: (_args, result) => {
          const value = result as unknown as Partial<InvestmentResearchContextResult>
          if (!['ready', 'empty', 'invalid', 'unavailable'].includes(value.status ?? '')) {
            return {
              card: 'generic',
              title: '当前会话投研上下文已读取',
              content: [{ type: 'text', text: '已读取输入框下方确认的策略与标的。' }],
            }
          }
          const title = value.status === 'ready'
            ? ((value.warnings?.length ?? 0) > 0 ? '当前投研上下文含风险提示' : '当前投研上下文已读取')
            : value.status === 'empty'
              ? '当前会话尚未选择投研上下文'
              : value.status === 'invalid'
                ? '当前会话策略已失效'
                : '当前投研上下文读取失败'
          return {
            card: 'generic',
            title,
            content: [{ type: 'text', text: renderInvestmentResearchContext(value as InvestmentResearchContextResult) }],
          }
        },
        async execute(_args, exec) {
          ctx.investmentPythonRuntime.assertCapability('trading-core', 'non-llm')
          return resolveInvestmentResearchContext(
            resolvedConfig.adapterBaseUrl,
            exec.agent?.session.header.id,
            exec.signal,
          )
        },
      }),
    )
    return disposeFeatures
  } catch (error) {
    await disposeFeatures()
    throw error
  }
}

function tradingBackend(config: Config): PythonBackendDefinition {
  return {
    id: 'trading-core',
    service: 'trading-core',
    mode: config.backendMode ?? 'managed',
    baseUrl: config.backendBaseUrl ?? 'http://127.0.0.1:8000',
    ...(config.backendProjectDir === undefined ? {} : { projectDir: config.backendProjectDir }),
    repositoryPath: ['backend', 'dsh-trading-core'],
    module: 'adapter.app:app',
    healthPath: '/health',
    healthOk: { status: 'ok' },
    initCommand: { posix: './init.sh', windows: 'init.bat' },
    managedEnv: { ADAPTER_RUNNER: config.backendRunner ?? 'engine' },
    credentialEnv: [
      { ref: 'DEEPSEEK_API_KEY' as CredentialRef, env: 'DEEPSEEK_API_KEY', role: 'required' },
      { ref: 'DEEPSEEK_API_KEY' as CredentialRef, env: 'OPENAI_API_KEY', role: 'required' },
    ],
  }
}

/** Register, acquire, expose tools, and tear down the stock backend in one ordered effect. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  await ctx.effect(async () => {
    const unregister = ctx.investmentPythonRuntime.register(tradingBackend(config))
    let lease: PythonBackendLease | undefined
    let disposeFeatures: (() => Promise<void>) | undefined
    let disposeCapability: (() => void) | undefined
    const disposeResources = async (): Promise<void> => {
      try {
        await disposeFeatures?.()
      } finally {
        try {
          disposeCapability?.()
        } finally {
          try {
            await lease?.release()
          } finally {
            unregister()
          }
        }
      }
    }
    try {
      lease = await ctx.investmentPythonRuntime.acquire('trading-core')
      const resolvedConfig: ResolvedConfig = {
        adapterBaseUrl: lease.baseUrl,
        streamTimeoutMs: config.streamTimeoutMs ?? 600_000,
        enableInChatPush: config.enableInChatPush ?? false,
        pushPollMs: config.pushPollMs ?? 120_000,
        pushSessions: config.pushSessions ?? [],
      }
      disposeFeatures = await setupFeatures(ctx, resolvedConfig)
      disposeCapability = ctx.investmentPythonRuntime.registerCapability({
        backendId: 'trading-core', toolCount: 11, llm: 'required',
      })
      return disposeResources
    } catch (error) {
      await disposeResources()
      throw error
    }
  }, 'investment stock-analysis runtime lifecycle')
}

export default Object.assign(apply, { Config, inject })
