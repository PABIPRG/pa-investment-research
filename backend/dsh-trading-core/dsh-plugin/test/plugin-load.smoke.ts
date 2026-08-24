// 插件加载冒烟测试（等价 dsh 启动时加载插件的代码路径）：
//   import index.ts → apply(ctx, config) → ctx.tools.register ×20
// 用 mock ctx 收集注册的工具定义，断言 20 个工具名与必填字段齐全。
// 任务型工具（tc_analyze_* 等）只做结构校验（不实际启动任务，避免跑几分钟引擎）；
// 同步只读工具做实时 schema 覆盖校验（防 additionalProperties:false 拦截超纲字段），
// 适配器不可达/数据源抖动时自动跳过，只有"有返回但字段未声明"才硬失败。
// 用法：npx tsx test/plugin-load.smoke.ts
import * as plugin from '../src/index.ts'

type SchemaObj = {
  type?: string
  additionalProperties?: boolean
  properties?: Record<string, unknown>
}
type ToolDef = {
  name: string
  parameters?: unknown
  output?: { schema?: SchemaObj; render?: unknown }
  execute?: (args: Record<string, unknown>) => Promise<unknown>
}

const registered = new Map<string, ToolDef>()

const fakeCtx = {
  tools: {
    register(def: ToolDef) {
      registered.set(def.name, def)
    },
  },
} as never

plugin.apply(fakeCtx as never, {
  adapterBaseUrl: 'http://127.0.0.1:8000',
})

const expected = [
  // 任务型（结构校验）
  'tc_analyze_stock', 'tc_analyze_holdings', 'tc_market_brief',
  'tc_backtest', 'tc_strategy_run', 'tc_shadow_run',
  // 同步只读（结构 + 实时 schema 校验）
  'tc_task_status', 'tc_get_watchlist', 'tc_get_holdings', 'tc_list_strategies',
  'tc_shadow_status', 'tc_risk_alerts', 'tc_news_cards', 'tc_personalized_profile',
  'tc_evolution_status', 'tc_evolution_attribution', 'tc_latest_brief', 'tc_risk_profile',
  // 同步写
  'tc_set_watchlist', 'tc_set_holdings',
]
const names = [...registered.keys()].sort()
console.log(`注册的工具（${names.length}）: ${names.join(', ')}`)

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
// 面向展示的工具必须有 render 纯函数渲染
for (const want of expected) {
  if (!registered.get(want)?.output?.render) failures.push(`${want} 缺 output.render`)
}

if (failures.length) {
  console.error('❌ 加载验证失败:', failures.join('; '))
  process.exit(1)
}
console.log(`✅ 插件加载验证通过（${expected.length} 个工具全部注册，字段齐全）`)

// ---- 实时 schema 覆盖校验（仅同步只读工具；任务型/写工具不联网跑） ----
const LIVE_CHECK: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'tc_task_status', args: { task_id: 'noop-check' } },
  { name: 'tc_get_watchlist', args: {} },
  { name: 'tc_get_holdings', args: {} },
  { name: 'tc_list_strategies', args: {} },
  { name: 'tc_shadow_status', args: {} },
  { name: 'tc_risk_alerts', args: {} },
  { name: 'tc_news_cards', args: {} },
  { name: 'tc_personalized_profile', args: {} },
  { name: 'tc_evolution_status', args: {} },
  { name: 'tc_evolution_attribution', args: {} },
  { name: 'tc_latest_brief', args: {} },
  { name: 'tc_risk_profile', args: {} },
]

async function schemaCovers(schema: SchemaObj, value: unknown, label: string): Promise<string | null> {
  if (schema.additionalProperties !== false || !schema.properties) return null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const declared = new Set(Object.keys(schema.properties))
  const undeclared = Object.keys(value as Record<string, unknown>).filter((k) => !declared.has(k))
  return undeclared.length ? `${label} schema 未声明返回字段: ${undeclared.join(', ')}` : null
}

;(async () => {
  const liveFailures: string[] = []
  for (const { name, args } of LIVE_CHECK) {
    const def = registered.get(name)
    const schema = def?.output?.schema
    if (!def?.execute || !schema) continue
    try {
      const value = await def.execute(args)
      // 404/任务不存在这类"有 HTTP 状态但 schema 无关"的错误由 httpJson 抛错 → 走 catch 跳过
      const problem = await schemaCovers(schema, value, name)
      if (problem) liveFailures.push(problem)
      else console.log(`  live ${name} → schema 覆盖 OK`)
    } catch (e) {
      console.log(`  live ${name} → 跳过（${e instanceof Error ? e.message.split('\n')[0] : e}）`)
    }
  }
  if (liveFailures.length) {
    console.error('❌ 实时 schema 校验失败:', liveFailures.join('; '))
    process.exit(1)
  }
  console.log('✅ 实时 schema 校验通过（返回字段全部在声明 schema 内）')
})().catch((e) => {
  console.error('❌ 实时校验执行异常:', e)
  process.exit(1)
})
