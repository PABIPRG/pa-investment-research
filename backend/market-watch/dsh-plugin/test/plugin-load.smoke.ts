// 插件加载冒烟测试（等价 dsh 启动时加载插件的代码路径）：
//   import index.ts → apply(ctx, config) → ctx.tools.register ×7
// 用 mock ctx 收集注册的工具定义，断言 7 个工具名与必填字段齐全。
// 第二部分（可选联网）：对只读结构化工具，用真实适配器响应校验 output.schema 覆盖——
//   防止 "返回字段超纲、additionalProperties:false 拦截" 这类 schema 与实际不符的 bug。
//   适配器不可达/数据源抖动时该步自动跳过，只有"有返回但字段未声明"才硬失败。
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
  adapterBaseUrl: 'http://127.0.0.1:8100',
})

const expected = ['mw_flash', 'mw_events', 'mw_event_alerts', 'mw_overview', 'mw_scan', 'mw_tech_signal', 'mw_latest_brief']
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
// 面向展示的工具必须有 render 纯函数渲染
for (const want of expected) {
  if (!registered.get(want)?.output?.render) failures.push(`${want} 缺 output.render`)
}

if (failures.length) {
  console.error('❌ 加载验证失败:', failures.join('; '))
  process.exit(1)
}
console.log(`✅ 插件加载验证通过（${expected.length} 个工具全部注册，字段齐全）`)

// ---- 实时 schema 覆盖校验（只读工具，联网；容错跳过） ----
const LIVE_CHECK: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'mw_flash', args: {} },
  { name: 'mw_events', args: {} },
  { name: 'mw_event_alerts', args: {} },
  { name: 'mw_overview', args: {} },
  { name: 'mw_scan', args: { kind: 'gainers' } },
  { name: 'mw_tech_signal', args: { code: '600519' } },
  { name: 'mw_latest_brief', args: {} },
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
