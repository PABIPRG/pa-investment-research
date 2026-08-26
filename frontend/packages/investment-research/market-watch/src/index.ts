// market-watch 盘中盯盘插件（dsh）
// 注册 11 个工具：自选管理 / 盯盘规则 / 异动扫描 / 盯盘面板 / 技术信号 / 新闻速递 / LLM 简报。
// 全部走同步 JSON（适配器 8100，无 SSE）；外部推送由适配器 scheduler 负责。
//
// 依赖适配器服务（backend/market-watch，已在 8100 端口跑通）：
//   POST /watchlist/add · /watchlist/remove · /alerts · /scan · /tech-signal
//   POST /news/express · /brief/generate
//   GET  /watchlist · /alerts · /overview

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PythonBackendDefinition, PythonBackendLease } from '@deepseek-ai/dsh-investment-python-runtime'
import {
  addAlert,
  dailyBrief,
  listAlerts,
  newsExpress,
  removeAlert,
  scanMovers,
  techSignal,
  watchAdd,
  watchList,
  watchOverview,
  watchRemove,
  type AlertConditionInput,
} from './client.ts'
import {
  renderAlerts,
  renderBrief,
  renderNews,
  renderOverview,
  renderScan,
  renderTechSignal,
  renderWatchlist,
} from './render.ts'

export const name = 'investment-market-watch'

/** Market-watch adapter connection settings. */
export interface Config {
  /** Runtime ownership mode. Defaults to managed. */
  backendMode?: 'managed' | 'external'
  /** Backend origin verified by the runtime. Defaults to `http://127.0.0.1:8100`. */
  backendBaseUrl?: string
  /** Explicit absolute market-watch checkout when repository discovery is unavailable. */
  backendProjectDir?: string
}

export const Config: Schema<Config> = Schema.object({
  backendMode: Schema.union(['managed', 'external']).default('managed'),
  backendBaseUrl: Schema.string().default('http://127.0.0.1:8100'),
  backendProjectDir: Schema.string(),
})

export const inject = ['tools', 'investmentPythonRuntime']

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

function setupTools(ctx: Context, base: string): () => void {
  const toolDisposers: Array<() => void> = []
  const register = (tool: Parameters<Context['tools']['register']>[0]): void => {
    toolDisposers.push(ctx.tools.register(tool))
  }
  const disposeTools = (): void => {
    const disposers = toolDisposers.reverse()
    const disposeFrom = (index: number): void => {
      if (index === disposers.length) return
      const dispose = disposers[index]
      if (dispose === undefined) return
      try {
        dispose()
      } finally {
        disposeFrom(index + 1)
      }
    }
    disposeFrom(0)
  }

  try {
  // ── 自选 ──────────────────────────────────────────────────────────────
    register(
      defineTool({
        name: 'watch_add',
        description:
        '添加一只 A 股到盯盘自选列表（模块独立自选，不与 trading-core 的持仓/自选耦合）。' +
        'code 传 6 位代码（如 600519）；name 可省，缺省从行情快照自动补。',
        parameters: {
          code: { type: 'string', required: true, description: '6 位股票代码，如 600519' },
          name: { type: 'string', description: '股票名称，可选，缺省自动补' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              duplicate: { type: 'boolean' },
              code: { type: 'string' },
              name: { type: 'string' },
            },
          },
          render: (_args, value) => [
            { type: 'text' as const, text: `✅ 已加入自选 ${(value as { name: string }).name}（${(value as { code: string }).code}）` },
          ],
        },
        ...present('加入自选'),
        execute: (args) => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return watchAdd(base, { code: args.code, ...(args.name === undefined ? {} : { name: args.name }) })
        },
      }),
    )

    register(
      defineTool({
        name: 'watch_remove',
        description: '从盯盘自选列表移除一只股票。',
        parameters: {
          code: { type: 'string', required: true, description: '6 位股票代码' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, removed: { type: 'boolean' }, code: { type: 'string' } },
          },
          render: (_args, value) => [
            { type: 'text' as const, text: (value as { removed: boolean }).removed ? `🗑 已移除 ${(value as { code: string }).code}` : `${(value as { code: string }).code} 不在自选` },
          ],
        },
        ...present('移除自选'),
        execute: (args) => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return watchRemove(base, { code: args.code })
        },
      }),
    )

    register(
      defineTool({
        name: 'watch_list',
        description: '列出当前盯盘自选列表。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: { type: 'json', description: '自选 [{code, name, added_at}]' },
              count: { type: 'number' },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: renderWatchlist(value as { items?: Array<{ code: string; name: string }>; count?: number }) }],
        },
        ...present('自选列表'),
        execute: () => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return watchList(base)
        },
      }),
    )

    // ── 盯盘规则 ──────────────────────────────────────────────────────────
    register(
      defineTool({
        name: 'add_alert',
        description:
        '创建一条盯盘触发规则。conditions 字段可选 price(现价) / pct_change(涨跌幅%) / volume_ratio(量比) / amount(成交额·亿) / turnover(换手率%)；' +
        'operator 用 > >= < <=；combine=and 需全部满足、or 任一满足。ticker 留空则对全部自选生效，也可指定单只（不在自选也行）。' +
        '触发后由适配器调度器推送（可配 LLM 解读）。',
        parameters: {
          name: { type: 'string', required: true, description: '规则名，如「放量大涨」' },
          ticker: { type: 'string', description: '可空=全部自选；或指定 6 位代码盯单只' },
          combine: { type: 'string', enum: ['and', 'or'], description: 'and=全部满足 / or=任一满足，默认 or' },
          conditions: {
            type: 'json',
            required: true,
            description: '条件数组 [{field, operator, value}]，如 [{field:"pct_change", operator:">=", value:5}]',
          },
          cooldown_min: { type: 'number', description: '两次触发最小间隔(分钟)，0=不限' },
          daily_cap: { type: 'number', description: '每日最多触发次数，0=不限' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, id: { type: 'string' }, rule: { type: 'json' } },
          },
          render: (_args, value) => [{ type: 'text' as const, text: `✅ 规则已创建：${(value as { id: string }).id}` }],
        },
        ...present('新建盯盘规则'),
        execute: (args) => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return addAlert(base, {
            name: args.name,
            ...(args.ticker === undefined ? {} : { ticker: args.ticker }),
            ...(args.combine === undefined ? {} : { combine: args.combine }),
            conditions: args.conditions as unknown as AlertConditionInput[],
            ...(args.cooldown_min === undefined ? {} : { cooldown_min: args.cooldown_min }),
            ...(args.daily_cap === undefined ? {} : { daily_cap: args.daily_cap }),
          })
        },
      }),
    )

    register(
      defineTool({
        name: 'list_alerts',
        description: '列出全部盯盘规则（含启用状态 / 冷却 / 每日上限）。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { items: { type: 'json' }, count: { type: 'number' } },
          },
          render: (_args, value) => [{ type: 'text' as const, text: renderAlerts(value as { items?: Array<Record<string, unknown>>; count?: number }) }],
        },
        ...present('规则列表'),
        execute: () => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return listAlerts(base)
        },
      }),
    )

    register(
      defineTool({
        name: 'remove_alert',
        description: '删除一条盯盘规则（id 来自 list_alerts）。',
        parameters: {
          id: { type: 'string', required: true, description: '规则 id' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, removed: { type: 'boolean' }, id: { type: 'string' } },
          },
          render: (_args, value) => [
            { type: 'text' as const, text: (value as { removed: boolean }).removed ? `🗑 已删除规则 ${(value as { id: string }).id}` : `规则 ${(value as { id: string }).id} 不存在` },
          ],
        },
        ...present('删除规则'),
        execute: (args) => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return removeAlert(base, args.id)
        },
      }),
    )

    // ── 扫描 / 面板 / 技术信号 ─────────────────────────────────────────────
    register(
      defineTool({
        name: 'scan_movers',
        description:
        '盘中异动扫描（实时快照，秒级）。kind 可选 gainers 涨幅榜 / volume_ratio 量比异动 / limit 涨跌停 / turnover 换手异动 / amount 成交额榜。' +
        '默认只扫沪深。top_n 控制返回条数；amount 榜可用 min_amount_yi 过滤最小成交额(亿)。',
        parameters: {
          kind: { type: 'string', enum: ['gainers', 'volume_ratio', 'limit', 'turnover', 'amount'], description: '扫描类型，默认 gainers' },
          top_n: { type: 'number', description: '返回条数，默认 10' },
          min_amount_yi: { type: 'number', description: '仅 amount：最小成交额(亿元)' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string' }, trade_date: { type: 'string' }, as_of: { type: 'string' },
              items: { type: 'json', description: '非 limit 类返回：异动榜' },
              limit_up: { type: 'json', description: 'limit 类：涨停股榜' },
              limit_down: { type: 'json', description: 'limit 类：跌停股榜' },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: renderScan(value as Record<string, unknown>) }],
        },
        ...present('异动扫描'),
        execute: (args) => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return scanMovers(base, {
            kind: args.kind ?? 'gainers',
            top_n: args.top_n ?? 10,
            ...(args.min_amount_yi === undefined ? {} : { min_amount_yi: args.min_amount_yi }),
          })
        },
      }),
    )

    register(
      defineTool({
        name: 'watch_overview',
        description:
        '盯盘面板：自选实时行情（现价/涨跌幅/量比/换手/成交额/主力净流入）+ 每条规则命中(hit)与逼近(near)状态。' +
        '适合用户问「今天盯得怎么样」时给出一张实时状态卡。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              as_of: { type: 'string' },
              trade_date: { type: 'string' },
              items: { type: 'json', description: '逐自选状态 + hit/near 规则' },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: renderOverview(value as { items?: Array<Record<string, unknown>>; trade_date?: string }) }],
        },
        ...present('盯盘面板'),
        execute: () => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return watchOverview(base)
        },
      }),
    )

    register(
      defineTool({
        name: 'tech_signal',
        description:
        '单只股票技术信号（前复权日线）：MA(5/10/20/60 多头/空头/缠绕)、MACD(金叉/死叉)、RSI(超买/超卖)、' +
        'KDJ(金叉/死叉)、BOLL(上/中/下轨与突破状态)、近60根支撑压力、量价形态(放量突破/缩量回调)。秒级返回。',
        parameters: {
          code: { type: 'string', required: true, description: '6 位股票代码' },
          lookback: { type: 'number', description: 'K线根数，默认 120，范围 30-500' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string' }, name: { type: 'string' },
              as_of: { type: 'string' }, bars: { type: 'number' },
              last: { type: 'json', description: '最新一根 K 线 OHLCV' },
              indicators: { type: 'json' }, signals: { type: 'json' },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: renderTechSignal(value as Record<string, unknown>) }],
        },
        ...present('技术信号'),
        execute: (args) => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return techSignal(base, {
            code: args.code,
            ...(args.lookback === undefined ? {} : { lookback: args.lookback }),
          })
        },
      }),
    )

    // ── 新闻 / 简报 ────────────────────────────────────────────────────────
    register(
      defineTool({
        name: 'news_express',
        description:
        '新闻速递：财联社市场要闻 + 每只自选股东财新闻（各 top 3），LLM 生成中文摘要 digest。' +
        '适合用户问「今天有什么要闻 / 我的自选有什么消息」。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' }, generated_at: { type: 'string' },
              trade_date: { type: 'string' }, digest: { type: 'string' },
              items: { type: 'json' }, global_count: { type: 'number' }, stock_count: { type: 'number' },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: renderNews(value as Record<string, unknown>) }],
        },
        ...present('新闻速递'),
        execute: () => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'non-llm')
          return newsExpress(base)
        },
      }),
    )

    register(
      defineTool({
        name: 'daily_brief',
        description:
        '生成盘前/盘后 LLM 简报。period=pre：指数状态 + 自选涨跌 + 要闻 → 「今日关注点」；period=post：自选当日表现 + 当日触发 + 资金流 + 要闻 → 「复盘 + 明日关注」。' +
        'LLM 不可用时降级为数据模板。',
        parameters: {
          period: { type: 'string', enum: ['pre', 'post'], description: 'pre=盘前 / post=盘后，默认 pre' },
          manual: { type: 'boolean', description: 'true 绕过交易日守卫（测试用），默认 false' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' }, period: { type: 'string' },
              generated_at: { type: 'string' }, trade_date: { type: 'string' },
              content: { type: 'string' }, llm_used: { type: 'boolean' },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: renderBrief(value as Record<string, unknown>) }],
        },
        ...present('简报'),
        execute: (args) => {
          ctx.investmentPythonRuntime.assertCapability('market-watch', 'llm-enhancement')
          return dailyBrief(base, { period: args.period ?? 'pre', manual: args.manual ?? false })
        },
      }),
    )
    return disposeTools
  } catch (error) {
    disposeTools()
    throw error
  }
}

function marketWatchBackend(config: Config): PythonBackendDefinition {
  return {
    id: 'market-watch',
    service: 'market-watch',
    mode: config.backendMode ?? 'managed',
    baseUrl: config.backendBaseUrl ?? 'http://127.0.0.1:8100',
    ...(config.backendProjectDir === undefined ? {} : { projectDir: config.backendProjectDir }),
    repositoryPath: ['backend', 'market-watch'],
    module: 'market_watch.app:app',
    healthPath: '/health',
    healthOk: { ok: true },
    initCommand: { posix: './init.sh', windows: 'init.bat' },
    managedEnv: { MW_LLM_ENABLED: 'true' },
    credentialEnv: [{ ref: 'DEEPSEEK_API_KEY' as CredentialRef, env: 'DEEPSEEK_API_KEY', role: 'enhancement' }],
  }
}

/** Register, acquire, expose tools, and tear down the market backend in one ordered effect. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  await ctx.effect(async () => {
    const unregister = ctx.investmentPythonRuntime.register(marketWatchBackend(config))
    let lease: PythonBackendLease | undefined
    let disposeTools: (() => void) | undefined
    let disposeCapability: (() => void) | undefined
    const disposeResources = async (): Promise<void> => {
      try {
        disposeTools?.()
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
      lease = await ctx.investmentPythonRuntime.acquire('market-watch')
      disposeTools = setupTools(ctx, lease.baseUrl)
      disposeCapability = ctx.investmentPythonRuntime.registerCapability({
        backendId: 'market-watch', toolCount: 11, llm: 'enhancement',
      })
      return disposeResources
    } catch (error) {
      await disposeResources()
      throw error
    }
  }, 'investment market-watch runtime lifecycle')
}
