// 插件加载冒烟测试（等价 dsh 启动时加载插件的代码路径）：
//   import index.ts（main: src/index.ts）→ apply(ctx, config) → ctx.tools.register ×5
// 用 mock ctx 收集注册的工具定义，断言 5 个工具名与必填字段齐全。
// 用法：npx tsx test/plugin-load.smoke.ts
import * as plugin from '../src/index.ts'

const registered = new Map<string, { parameters?: unknown; output?: unknown; execute?: unknown }>()

const fakeCtx = {
  tools: {
    register(def: { name: string; parameters?: unknown; output?: unknown; execute?: unknown }) {
      registered.set(def.name, def)
    },
  },
} as never

// 模拟 dsh：注入 'tools' 服务后调用 apply
plugin.apply(fakeCtx as never, {
  adapterBaseUrl: 'http://127.0.0.1:8000',
  streamTimeoutMs: 600_000,
})

const expected = [
  'analyze_stock',
  'analyze_holdings',
  'market_brief',
  'set_watchlist',
  'get_watchlist',
  'set_holdings',
  'get_latest_brief',
  'set_risk_profile',
  'get_risk_profile',
]
const names = [...registered.keys()].sort()
console.log('注册的工具:', names.join(', '))

const failures: string[] = []
for (const want of expected) {
  const def = registered.get(want)
  if (!def) {
    failures.push(`缺工具 ${want}`)
    continue
  }
  if (!def.parameters) failures.push(`${want} 缺 parameters`)
  if (!def.output) failures.push(`${want} 缺 output`)
  if (!def.execute) failures.push(`${want} 缺 execute`)
}
// 流式工具必须有 render；轻量工具必须能同步执行签名
for (const want of ['analyze_holdings', 'market_brief']) {
  if (!registered.get(want)?.output?.render) failures.push(`${want} 缺 output.render`)
}

if (failures.length) {
  console.error('❌ 加载验证失败:', failures.join('; '))
  process.exit(1)
}
console.log(`✅ 插件加载验证通过（${expected.length} 个工具全部注册，字段齐全）`)
