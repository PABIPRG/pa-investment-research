// trading-core 组合与策略 Agent 插件（dsh）
// 注册 20 个工具，分三类：
//   任务型（POST → task_id → 轮询 GET /analyze/{tid} → done 后取 result，超时返回 running 信封）：
//     tc_analyze_stock / tc_analyze_holdings / tc_market_brief / tc_backtest /
//     tc_strategy_run / tc_shadow_run
//   同步只读：tc_task_status / tc_get_watchlist / tc_get_holdings / tc_list_strategies /
//     tc_shadow_status / tc_risk_alerts / tc_news_cards / tc_personalized_profile /
//     tc_evolution_status / tc_evolution_attribution / tc_latest_brief / tc_risk_profile
//   同步写：tc_set_watchlist / tc_set_holdings
//
// 依赖适配器服务（backend/dsh-trading-core，已在 8000 端口跑通）：
//   POST /analyze · /holdings/analyze · /brief · /backtest/run · /strategies/run · /shadow/run
//   GET  /analyze/{tid} · /analyze/{tid}/result · /watchlist · /holdings · /strategies ·
//        /shadow/status · /risk/alerts · /personalized/cards · /personalized/profile ·
//        /evolution/status · /evolution/attribution · /brief/latest · /risk_profile
//   POST /watchlist · /holdings/save

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  evolutionAttribution,
  evolutionStatus,
  getHoldings,
  getWatchlist,
  latestBrief,
  listStrategies,
  newsCards,
  personalizedProfile,
  pollTask,
  riskAlerts,
  riskProfile,
  saveHoldings,
  setWatchlist,
  shadowStatus,
  startAnalyze,
  startBacktest,
  startBrief,
  startHoldingsAnalyze,
  startShadowRun,
  startStrategyRun,
  taskStatus,
  type TaskEnvelope,
} from './client.ts'
import {
  renderAnalyzeHoldings,
  renderAnalyzeStock,
  renderBacktest,
  renderEvolutionAttribution,
  renderEvolutionStatus,
  renderHoldings,
  renderLatestBrief,
  renderMarketBrief,
  renderNewsCards,
  renderPersonalizedProfile,
  renderRiskAlerts,
  renderRiskProfile,
  renderSaved,
  renderShadowRun,
  renderShadowStatus,
  renderStrategies,
  renderStrategyRun,
  renderTaskStatus,
  renderWatchlist,
} from './render.ts'

export const name = 'trading-core'

export interface Config {
  adapterBaseUrl: string
}

export const Config: Schema<Config> = Schema.object({
  adapterBaseUrl: Schema.string().default('http://127.0.0.1:8000'),
})

export const inject = ['tools']

// 轻量工具通用卡片（无 LLM 流式阶段，一个文本卡即可）
function present(title: string) {
  return {
    presentCall: (args: unknown) => ({ card: 'generic' as const, title, kind: 'other' as const, rawInput: args }),
    presentResult: (_args: unknown, result: { meta?: unknown }) => ({
      card: 'generic' as const,
      title,
      content: [
        {
          type: 'text' as const,
          text: typeof result.meta === 'string' ? result.meta : title,
        },
      ],
    }),
  }
}

// 任务型工具统一输出信封（start → poll → 状态 + 结果）
// as const：schema 属性 type 需保持字面量，否则 ValueSchemaSpec 推导失败
const taskOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      task_id: { type: 'string' as const },
      status: { type: 'string' as const, description: 'pending/running/done/failed' },
      result: { type: 'json' as const, description: '最终结果（task 类型相关，done 时存在）' },
      error: { type: 'string' as const },
      note: { type: 'string' as const },
    },
  },
} as const

export function apply(ctx: Context, config: Config) {
  const base = config.adapterBaseUrl

  // ══════════════ 任务型 ══════════════

  // ── 个股分析 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_analyze_stock',
      description:
        '对单只 A 股做完整研究分析（引擎多轮辩论：基本面/资金/技术/情绪），' +
        '产出买卖信号 + 分步报告。ticker 传代码或名称。耗时数分钟（任务轮询）。' +
        'research_depth: quick/basic/standard/deep/full。',
      parameters: {
        ticker: { type: 'string', required: true, description: '股票代码（如 600519）或名称（如 贵州茅台）' },
        date: { type: 'string', description: '分析日期 YYYY-MM-DD，缺省最近交易日' },
        market: { type: 'string', description: '市场，缺省按代码自动识别' },
        research_depth: { type: 'string', description: 'quick/basic/standard/deep/full，缺省 standard' },
        risk_profile: { type: 'string', description: 'conservative/balanced/aggressive，缺省用已保存偏好' },
      },
      output: {
        ...taskOutput,
        render: (_args, value) => [{ type: 'text' as const, text: renderAnalyzeStock(value as TaskEnvelope) }],
      },
      ...present('个股分析'),
      execute: async (args) => {
        const { task_id } = await startAnalyze(base, {
          ticker: args.ticker,
          date: args.date,
          market: args.market,
          research_depth: args.research_depth,
          risk_profile: args.risk_profile,
        })
        return pollTask(base, task_id)
      },
    }),
  )

  // ── 持仓分析 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_analyze_holdings',
      description:
        '分析当前组合（已保存持仓，或本次传 holdings）的定量风险与逐股引擎研判，' +
        '产出组合信号 + 组合风险报告。mode=deep 逐股分析较慢，quick 秒级定量。',
      parameters: {
        holdings: { type: 'json', description: '持仓列表 [{ticker,quantity,cost_price}]；空则用已保存持仓' },
        mode: { type: 'string', description: 'deep=逐股引擎分析(慢) / quick=仅定量风险(秒级)，缺省 deep' },
        use_saved: { type: 'boolean', description: 'holdings 为空时是否回退已保存持仓，缺省 true' },
        risk_profile: { type: 'string', description: 'conservative/balanced/aggressive，缺省用已保存偏好' },
      },
      output: {
        ...taskOutput,
        render: (_args, value) => [{ type: 'text' as const, text: renderAnalyzeHoldings(value as TaskEnvelope) }],
      },
      ...present('持仓分析'),
      execute: async (args) => {
        const { task_id } = await startHoldingsAnalyze(base, {
          holdings: args.holdings as Array<{ ticker: string; quantity: number; cost_price: number }> | undefined,
          mode: args.mode,
          use_saved: args.use_saved,
          risk_profile: args.risk_profile,
        })
        return pollTask(base, task_id)
      },
    }),
  )

  // ── 市场简报 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_market_brief',
      description:
        '生成盘前/盘后/实时市场简报：市场概况 + 板块行情 + 资讯机会点。' +
        'period: pre_market 盘前 / post_market 盘后 / now 当前。scope 限定范围。',
      parameters: {
        period: { type: 'string', description: 'pre_market/post_market/now，缺省 now' },
        scope: { type: 'string', description: 'market/industry/concept/news/watchlist/all，缺省 all' },
        tickers: { type: 'json', description: '覆盖的自选股；空用已保存 watchlist' },
        risk_profile: { type: 'string', description: 'conservative/balanced/aggressive，缺省用已保存偏好' },
      },
      output: {
        ...taskOutput,
        render: (_args, value) => [{ type: 'text' as const, text: renderMarketBrief(value as TaskEnvelope) }],
      },
      ...present('市场简报'),
      execute: async (args) => {
        const { task_id } = await startBrief(base, {
          period: args.period,
          scope: args.scope,
          tickers: args.tickers as string[] | undefined,
          risk_profile: args.risk_profile,
        })
        return pollTask(base, task_id)
      },
    }),
  )

  // ── 历史决策回测 ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_backtest',
      description:
        '基于历史决策记录做前瞻回测（按评估窗口/止损止盈重算命中率）。' +
        'code 只回测单票；force 强制重评估；eval_window_days 评估窗口。耗时取决于决策量。',
      parameters: {
        code: { type: 'string', description: '只回测该代码（如 600519）；空=全部' },
        force: { type: 'boolean', description: '强制重评估（忽略同版本缓存）' },
        eval_window_days: { type: 'number', description: '评估窗口天数，缺省 10，1-120' },
        min_age_days: { type: 'number', description: '决策最小年龄（自然日），缺省 14' },
        limit: { type: 'number', description: '最多评估决策条数，缺省 200，1-2000' },
        stop_loss_pct: { type: 'number', description: '止损幅度%，缺省 5' },
        take_profit_pct: { type: 'number', description: '止盈幅度%，缺省 10' },
        neutral_band_pct: { type: 'number', description: '中性带%，缺省 2' },
      },
      output: {
        ...taskOutput,
        render: (_args, value) => [{ type: 'text' as const, text: renderBacktest(value as TaskEnvelope) }],
      },
      ...present('历史回测'),
      execute: async (args) => {
        const { task_id } = await startBacktest(base, {
          code: args.code,
          force: args.force,
          eval_window_days: args.eval_window_days,
          min_age_days: args.min_age_days,
          limit: args.limit,
          stop_loss_pct: args.stop_loss_pct,
          take_profit_pct: args.take_profit_pct,
          neutral_band_pct: args.neutral_band_pct,
        })
        return pollTask(base, task_id)
      },
    }),
  )

  // ── 策略回测运行 ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_strategy_run',
      description:
        '对策略池中的候选策略做历史+样本外回测（指标是否过阈值决定激活）。' +
        'strategy_id 传 tc_list_strategies 返回的 id。oos_frac 样本外比例。',
      parameters: {
        strategy_id: { type: 'string', required: true, description: '策略 id（tc_list_strategies 返回）' },
        lookback_years: { type: 'number', description: '历史回看年数，缺省 2，0.5-10' },
        oos_frac: { type: 'number', description: '样本外比例，缺省 0.3（0-0.5）' },
        initial_capital: { type: 'number', description: '回测初始资金（0=默认）' },
        min_oos_trades: { type: 'number', description: '样本外最低成交数，缺省 4' },
      },
      output: {
        ...taskOutput,
        render: (_args, value) => [{ type: 'text' as const, text: renderStrategyRun(value as TaskEnvelope) }],
      },
      ...present('策略回测'),
      execute: async (args) => {
        const { task_id } = await startStrategyRun(base, {
          strategy_id: args.strategy_id,
          lookback_years: args.lookback_years,
          oos_frac: args.oos_frac,
          initial_capital: args.initial_capital,
          min_oos_trades: args.min_oos_trades,
        })
        return pollTask(base, task_id)
      },
    }),
  )

  // ── 影子验证 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_shadow_run',
      description:
        '实时影子验证：对全部 active 策略（或指定策略）按当日行情模拟记账，' +
        '产出逐策略净值/组合净值。幂等：同日已运行返回 skipped。force=true 可重跑。',
      parameters: {
        force: { type: 'boolean', description: 'true=强制重跑当日（忽略幂等）' },
        strategy_id: { type: 'string', description: '只验证该策略；空=全部 active 策略' },
      },
      output: {
        ...taskOutput,
        render: (_args, value) => [{ type: 'text' as const, text: renderShadowRun(value as TaskEnvelope) }],
      },
      ...present('影子验证'),
      execute: async (args) => {
        const { task_id } = await startShadowRun(base, {
          force: args.force,
          strategy_id: args.strategy_id,
        })
        return pollTask(base, task_id)
      },
    }),
  )

  // ── 任务状态续查 ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_task_status',
      description:
        '查询异步任务状态（tc_analyze_stock 等超时返回 running 信封后，用返回的 task_id 续查）。',
      parameters: {
        task_id: { type: 'string', required: true, description: '任务 id（tc_* 启动类工具返回的 task_id）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task_id: { type: 'string' },
            task_type: { type: 'string' },
            status: { type: 'string', description: 'pending/running/done/failed' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderTaskStatus(value as Record<string, unknown>) }],
      },
      ...present('任务状态'),
      execute: (args) => taskStatus(base, args.task_id),
    }),
  )

  // ══════════════ 同步只读 ══════════════

  // ── 自选列表 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_get_watchlist',
      description: '读取当前自选列表（代码数组）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { tickers: { type: 'json', description: '自选代码列表' } },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderWatchlist(value as Record<string, unknown>) }],
      },
      ...present('自选列表'),
      execute: () => getWatchlist(base),
    }),
  )

  // ── 持仓列表 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_get_holdings',
      description: '读取当前持仓（代码/数量/成本价；name 留空由消费方补）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { items: { type: 'json', description: '持仓 [{ticker,quantity,cost_price}]' } },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderHoldings(value as Record<string, unknown>) }],
      },
      ...present('持仓列表'),
      execute: () => getHoldings(base),
    }),
  )

  // ── 策略池 ────────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_list_strategies',
      description:
        '列出策略池：候选/激活/观察/退役状态，方向、假设、回测摘要与自进化生命状态。' +
        '适合回答「现在有哪些策略在跑」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number' },
            items: { type: 'json', description: '策略 [{id,name,kind,status,direction,params,symbols,backtest,evolve}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderStrategies(value as Record<string, unknown>) }],
      },
      ...present('策略池'),
      execute: () => listStrategies(base),
    }),
  )

  // ── 影子状态 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_shadow_status',
      description: '影子组合整体状态：最近运行日/组合净值/策略数。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            trade_date: { type: 'string' },
            ran_at: { type: 'string' },
            overall_nav: { type: 'number' },
            strategy_count: { type: 'number' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderShadowStatus(value as Record<string, unknown>) }],
      },
      ...present('影子状态'),
      execute: () => shadowStatus(base),
    }),
  )

  // ── 风险预警中心 ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_risk_alerts',
      description:
        '风险预警中心：组合风险（集中度/权重超预算）+ 影子亏损 + 命中持仓/自选的利空事件' +
        '+ 画像上下文，按 高/中/低 排序。适合回答「我现在有什么风险/该注意什么」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            profile: { type: 'string' },
            profile_label: { type: 'string' },
            count: { type: 'number' },
            effect: { type: 'string' },
            items: { type: 'json', description: '预警 [{id,source,severity,title,detail,codes,strategy_id,ts,feedback}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderRiskAlerts(value as Record<string, unknown>) }],
      },
      ...present('风险预警'),
      execute: () => riskAlerts(base),
    }),
  )

  // ── 个性化资讯卡片 ────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_news_cards',
      description:
        '个性化资讯卡片（按画像/行为排序的事件卡片，含推荐策略）。' +
        '适合回答「今天给我推荐什么/我该看哪些消息」。limit 控制条数。',
      parameters: {
        limit: { type: 'number', description: '返回条数上限，缺省 30' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            profile: { type: 'string' },
            profile_label: { type: 'string' },
            effective_aggression: { type: 'number' },
            behavior: { type: 'json' },
            count: { type: 'number' },
            cards: { type: 'json', description: '卡片 [{id,bucket,title,reason,codes,direction}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderNewsCards(value as Record<string, unknown>) }],
      },
      ...present('个性化卡片'),
      execute: (args) => newsCards(base, args.limit),
    }),
  )

  // ── 行为画像 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_personalized_profile',
      description:
        '行为推断画像：问卷基线 + 行为点击偏斜修正后的有效进取度 + 关注标的/策略亲和。' +
        '适合回答「系统怎么理解我的风险偏好」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            base_profile: { type: 'string' },
            profile_label: { type: 'string' },
            base_aggression: { type: 'number' },
            effective_aggression: { type: 'number' },
            behavior: { type: 'json' },
            notes: { type: 'json' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderPersonalizedProfile(value as Record<string, unknown>) }],
      },
      ...present('行为画像'),
      execute: () => personalizedProfile(base),
    }),
  )

  // ── 自进化状态 ────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_evolution_status',
      description:
        '自进化闭环状态：影子数据是否攒够、策略生命周期分布。适合回答「进化到哪一步了」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            days_of_data: { type: 'number' },
            min_days: { type: 'number' },
            ready: { type: 'boolean' },
            counts: { type: 'json' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderEvolutionStatus(value as Record<string, unknown>) }],
      },
      ...present('自进化状态'),
      execute: () => evolutionStatus(base),
    }),
  )

  // ── 自进化归因 ────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_evolution_attribution',
      description:
        '自进化归因：影子收益 → 各策略贡献（T attribution）、回撤来源。' +
        '适合回答「这轮净值涨跌是谁贡献的」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            days_of_data: { type: 'number' },
            min_days: { type: 'number' },
            data_note: { type: 'string' },
            overall: { type: 'json' },
            strategies: { type: 'json' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderEvolutionAttribution(value as Record<string, unknown>) }],
      },
      ...present('进化归因'),
      execute: () => evolutionAttribution(base),
    }),
  )

  // ── 最近简报（落盘版） ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_latest_brief',
      description:
        '最近一份已落盘的盘前/盘后简报摘要（含是否已推送 dsh）。' +
        '适合回答「系统今天发过简报吗」。',
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
        render: (_args, value) => [{ type: 'text' as const, text: renderLatestBrief(value as Record<string, unknown>) }],
      },
      ...present('最近简报'),
      execute: () => latestBrief(base),
    }),
  )

  // ── 风险偏好 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_risk_profile',
      description: '读取当前全局风险偏好画像（conservative/balanced/aggressive + 标签）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            risk_profile: { type: 'string' },
            label: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderRiskProfile(value as Record<string, unknown>) }],
      },
      ...present('风险偏好'),
      execute: () => riskProfile(base),
    }),
  )

  // ══════════════ 同步写 ══════════════

  // ── 替换自选 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_set_watchlist',
      description:
        '整体替换自选列表。tickers 传代码数组（6 位）。' +
        '适合「把我的自选改成 X/Y/Z」。',
      parameters: {
        tickers: { type: 'json', required: true, description: '自选代码数组，如 ["600519","300750"]' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { saved: { type: 'number' } },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderSaved(value as Record<string, unknown>) }],
      },
      ...present('保存自选'),
      execute: (args) => setWatchlist(base, args.tickers as string[]),
    }),
  )

  // ── 保存持仓 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tc_set_holdings',
      description:
        '整体替换持仓。holdings 传 [{ticker, quantity, cost_price}]（数量股、成本价元）。' +
        '适合「我现在持有茅台 100 股 @ 1500」。',
      parameters: {
        holdings: { type: 'json', required: true, description: '持仓数组 [{ticker,quantity,cost_price}]' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { saved: { type: 'number' } },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderSaved(value as Record<string, unknown>) }],
      },
      ...present('保存持仓'),
      execute: (args) =>
        saveHoldings(base, args.holdings as Array<{ ticker: string; quantity: number; cost_price: number }>),
    }),
  )
}
