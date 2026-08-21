// industry-chain 产业链图谱插件（dsh）
// 注册 4 个只读工具：公司搜索 / 公司档案 / 单公司产业链 / 产业链多层展开。
// 全部走同步 JSON（适配器 8200，无 SSE，无调度/推送）。
//
// 依赖适配器服务（backend/industry-chain，已在 8200 端口跑通）：
//   GET /companies?keyword=&limit=
//   GET /companies/{code}
//   GET /graph/single/{code}
//   GET /graph/chain/{code}?depth_up=&depth_down=&top_up=&top_down=

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { chainExpand, chainGraph, chainProfile, chainSearch, type ChainExpandInput } from './client.ts'
import { renderExpand, renderGraph, renderProfile, renderSearch } from './render.ts'

export const name = 'industry-chain'

export interface Config {
  adapterBaseUrl: string
}

export const Config: Schema<Config> = Schema.object({
  adapterBaseUrl: Schema.string().default('http://127.0.0.1:8200'),
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

  // ── 公司搜索 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'chain_search',
      description:
        '在产业链图谱中搜索公司（名称/代码/行业模糊匹配，iducsite 研报图谱覆盖 1297 家核心公司）。' +
        'keyword 传名称（如「上海家化」）或 6 位代码（如 600315）或行业。limit 控制返回条数。',
      parameters: {
        keyword: { type: 'string', description: '名称/代码/行业关键词，空则返回前 limit 家' },
        limit: { type: 'number', description: '返回条数上限，默认 20，范围 1-100' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            items: { type: 'json', description: '公司列表 [{code,name,industry,exchange,is_subject}]' },
            count: { type: 'number' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderSearch(value as { items?: Array<Record<string, unknown>>; count?: number }) }],
      },
      ...present('公司搜索'),
      execute: (args) => chainSearch(base, { keyword: args.keyword, limit: args.limit }),
    }),
  )

  // ── 公司档案 ──────────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'chain_profile',
      description:
        '单家公司档案：行业 / 市值 / 股价 / 研报覆盖标记 / 上下游与原材料产品计数 / 简介。' +
        'code 传 6 位代码，且必须是图谱内核心公司（chain_search 返回的 code 均可）。',
      parameters: {
        code: { type: 'string', required: true, description: '6 位公司代码，如 600315' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' },
            industry: { type: 'string' }, desc: { type: 'string' }, is_subject: { type: 'boolean' },
            market_cap_cny: { type: 'number' }, market_cap_display: { type: 'string' },
            stock_price: { type: 'number' }, material_count: { type: 'number' },
            product_count: { type: 'number' }, supplier_count: { type: 'number' },
            customer_count: { type: 'number' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderProfile(value as Record<string, unknown>) }],
      },
      ...present('公司档案'),
      execute: (args) => chainProfile(base, args.code),
    }),
  )

  // ── 单公司 5 列产业链 ─────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'chain_graph',
      description:
        '单公司 5 列产业链：供应商 → 原材料 → 核心公司 → 主营产品 → 下游客户。' +
        'suppliers/customers 已按实体去重并聚合 via 原材料/产品。适合回答「这家公司的上下游是谁」。',
      parameters: {
        code: { type: 'string', required: true, description: '6 位公司代码，如 600315' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            company: { type: 'json', description: '核心公司档案（同 chain_profile）' },
            materials: { type: 'json', description: '原材料 [{id,name,share,confidence}]' },
            suppliers: { type: 'json', description: '供应商 [{id,name,type,share,note,vias}]' },
            products: { type: 'json', description: '主营产品 [{id,name,share,confidence}]' },
            customers: { type: 'json', description: '下游客户 [{id,name,type,share,note,vias}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderGraph(value as Record<string, unknown>) }],
      },
      ...present('单公司产业链'),
      execute: (args) => chainGraph(base, args.code),
    }),
  )

  // ── 产业链多层展开 ────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'chain_expand',
      description:
        '以某公司为中心，向上/向下按层展开产业链（BFS，环回去重）。' +
        'depth_up/depth_down 每方向层数 1-3，top_up/top_down 每层 TOP-N。' +
        '适合回答「这家公司的上游上游是谁 / 整条产业链长什么样」。',
      parameters: {
        code: { type: 'string', required: true, description: '6 位中心公司代码，如 600315' },
        depth_up: { type: 'number', description: '向上展开层数，默认 2，范围 1-3' },
        depth_down: { type: 'number', description: '向下展开层数，默认 2，范围 1-3' },
        top_up: { type: 'number', description: '上游每层 TOP-N，默认 3，范围 1-5' },
        top_down: { type: 'number', description: '下游每层 TOP-N，默认 2，范围 1-5' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            center: { type: 'json', description: '中心公司档案' },
            up_levels: { type: 'json', description: '上游各层 [{level,nodes:[{id,name,share,type,via,note,parent_id,depth}]}]' },
            down_levels: { type: 'json', description: '下游各层 [{level,nodes:[...]}]' },
          },
        },
        render: (_args, value) => [{ type: 'text' as const, text: renderExpand(value as Record<string, unknown>) }],
      },
      ...present('产业链展开'),
      execute: (args) =>
        chainExpand(base, {
          code: args.code,
          depth_up: args.depth_up,
          depth_down: args.depth_down,
          top_up: args.top_up,
          top_down: args.top_down,
        } as ChainExpandInput),
    }),
  )
}
