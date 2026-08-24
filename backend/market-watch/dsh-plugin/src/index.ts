// market-watch 盯盘与快讯插件（dsh）
// 注册 7 个只读/轻量工具：实时快讯 / 结构化投资事件 / 事件预警 / 盯盘面板 /
// 盘中异动扫描 / 个股技术信号 / 最近简报。全部走同步 JSON（适配器 8100，无 SSE）。
//
// 依赖适配器服务（backend/market-watch，已在 8100 端口跑通）：
//   GET  /news/flash?limit=
//   GET  /news/events?limit=
//   GET  /news/event-alerts?limit=
//   GET  /overview
//   POST /scan          {kind: gainers|volume_ratio|limit|turnover|amount}
//   POST /tech-signal   {code}
//   GET  /brief/latest

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { eventAlerts, events, flash, latestBrief, overview, scan, techSignal } from './client.ts'
import { renderBrief, renderEventAlerts, renderEvents, renderFlash, renderOverview, renderScan, renderTechSignal } from './render.ts'

export const name = 'market-watch'

export interface Config {
  adapterBaseUrl: string
}

export const Config: Schema<Config> = Schema.object({
  adapterBaseUrl: Schema.string().default('http://127.0.0.1:8100'),
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

export function apply(ctx: Context, config: Config) {
  const base = config.adapterBaseUrl

  // ── 实时快讯 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'mw_flash',
      description:
        '跨源实时快讯流（新浪财经/财联社/华尔街见闻/IT之家/36氪/虎嗅）。' +
        '每条含标题/正文/来源/时间。适合回答「今天有什么快讯/市场消息」。limit 控制条数。',
      parameters: {
        limit: { type: 'number', description: '返回条数上限，默认 20，范围 1-50' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            sources: { type: 'json', description: '来源列表' },
            items: { type: 'json', description: '快讯 [{id,time,tag,title,content,source}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderFlash(value as { items?: Array<Record<string, unknown>>; sources?: string[] }) }],
      },
      ...present('实时快讯'),
      execute: (args) => flash(base, { limit: args.limit }),
    }),
  )

  // ── 结构化投资事件 ────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'mw_events',
      description:
        '结构化投资事件（LLM 抽取：类型/方向/涉及股票/行业/摘要）。' +
        '每条含 type(业绩/增持/中标…)、direction(利好/利空)、tickers、industries。' +
        '适合回答「最近有什么投资事件 / 某只股票为什么涨」。limit 控制条数。',
      parameters: {
        limit: { type: 'number', description: '返回条数上限，默认 20，范围 1-50' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            count: { type: 'number' },
            items: { type: 'json', description: '事件 [{id,type,direction,tickers[{name,code}],industries[],summary,time,source}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderEvents(value as { items?: Array<Record<string, unknown>>; count?: number }) }],
      },
      ...present('投资事件'),
      execute: (args) => events(base, { limit: args.limit }),
    }),
  )

  // ── 事件预警中心 ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'mw_event_alerts',
      description:
        '事件预警中心：命中自选/持仓的结构化事件（含未命中列表 watch/hold 对照）。' +
        '适合回答「我关注/持仓的股票今天有没有重大事件预警」。limit 控制条数。',
      parameters: {
        limit: { type: 'number', description: '返回条数上限，默认 20' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            items: { type: 'json', description: '命中预警事件列表' },
            watch: { type: 'json', description: '自选列表' },
            hold: { type: 'json', description: '持仓列表' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderEventAlerts(value as { items?: Array<Record<string, unknown>>; watch?: string[]; hold?: string[] }) }],
      },
      ...present('事件预警'),
      execute: (args) => eventAlerts(base, { limit: args.limit }),
    }),
  )

  // ── 盯盘面板 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'mw_overview',
      description:
        '盯盘面板：自选股实时行情 + 规则命中/逼近（如大额成交、涨跌幅破位）。' +
        '适合回答「我的自选股现在怎么样 / 有什么规则被触发了」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as_of: { type: 'string' },
            trade_date: { type: 'string' },
            items: { type: 'json', description: '自选行情 [{code,name,price,pct_change,amount_yi,hit[],near[]}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderOverview(value as { items?: Array<Record<string, unknown>>; trade_date?: string }) }],
      },
      ...present('盯盘面板'),
      execute: () => overview(base),
    }),
  )

  // ── 盘中异动扫描 ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'mw_scan',
      description:
        '盘中异动扫描（全市场）。kind 必填其一：gainers=涨幅榜 / volume_ratio=量比榜 / ' +
        'limit=涨跌停 / turnover=换手榜 / amount=成交额榜。适合回答「今天谁涨得最猛 / 什么放量了」。',
      parameters: {
        kind: { type: 'string', required: true, description: 'gainers|volume_ratio|limit|turnover|amount' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string' },
            trade_date: { type: 'string' },
            as_of: { type: 'string' },
            items: { type: 'json', description: '异动股 [{code,name,price,pct_change,amount_yi,turnover}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderScan(value as { items?: Array<Record<string, unknown>>; kind?: string; trade_date?: string }) }],
      },
      ...present('盘中异动'),
      execute: (args) => scan(base, { kind: args.kind }),
    }),
  )

  // ── 个股技术信号 ──────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'mw_tech_signal',
      description:
        '单只 A 股的完整技术信号：均线趋势 / MACD / RSI / KDJ / BOLL 位置 / 支撑压力 / 综合 signals。' +
        'code 传 6 位代码（如 600519）。适合回答「这只股票技术面怎么样 / 该不该买」。',
      parameters: {
        code: { type: 'string', required: true, description: '6 位股票代码，如 600519' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            as_of: { type: 'string' },
            bars: { type: 'number' },
            last: { type: 'json', description: '最新 K 线 {date,open,close,high,low,volume,amount}' },
            indicators: { type: 'json', description: 'ma/macd/rsi/kdj/boll/support_resistance' },
            signals: { type: 'json', description: '综合信号列表' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderTechSignal(value as Record<string, unknown>) }],
      },
      ...present('技术信号'),
      execute: (args) => techSignal(base, { code: args.code }),
    }),
  )

  // ── 最近简报 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'mw_latest_brief',
      description:
        '最近一份盘前/盘后简报（Markdown 正文，含市场状态/自选股/要闻）。' +
        '适合回答「今天的简报 / 盘前关注什么」。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            period: { type: 'string' },
            generated_at: { type: 'string' },
            trade_date: { type: 'string' },
            content: { type: 'string', description: '简报 Markdown 正文' },
            llm_used: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderBrief(value as Record<string, unknown>) }],
      },
      ...present('最近简报'),
      execute: () => latestBrief(base),
    }),
  )
}
