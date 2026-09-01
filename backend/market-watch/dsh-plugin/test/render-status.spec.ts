import assert from 'node:assert/strict'

import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { renderTechSignal } from '../src/render.ts'

type ToolDef = {
  name: string
  output?: {
    schema?: JsonSchemaNode
    render?: (_args: unknown, value: unknown) => Array<{ type: string; text: string }>
  }
}

let passed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

const registered = new Map<string, ToolDef>()
const fakeCtx = {
  tools: {
    register(def: ToolDef) {
      registered.set(def.name, def)
    },
  },
}

plugin.apply(fakeCtx as never, { adapterBaseUrl: 'http://127.0.0.1:8100' })

function validateRegisteredOutput(name: string, value: unknown): string[] {
  const schema = registered.get(name)?.output?.schema
  assert.ok(schema, `${name} 缺 output schema`)
  return validateJsonSchemaValue(schema, value, 'value')
}

test('preparing 只提示技术信号正在准备，不输出买卖判断', () => {
  const rendered = renderTechSignal({
    status: 'preparing',
    code: '920223',
    as_of: '2026-09-01T09:30:00+08:00',
    retry_after_ms: 1500,
    message: '920223 K 线正在后台准备，请稍后重试',
  })

  assert.match(rendered, /技术信号正在准备/)
  assert.match(rendered, /稍后重试/)
  assert.doesNotMatch(rendered, /信号：|买入|卖出|该不该买/)
})

test('unavailable 展示服务端安全消息和可重试提示', () => {
  const rendered = renderTechSignal({
    status: 'unavailable',
    code: '920223',
    as_of: '2026-09-01T09:30:00+08:00',
    reason_code: 'provider_error',
    message: '行情源暂时不可用，请稍后重试',
    retryable: true,
  })

  assert.match(rendered, /技术信号暂不可用/)
  assert.match(rendered, /行情源暂时不可用，请稍后重试/)
  assert.match(rendered, /可以重试/)
  assert.doesNotMatch(rendered, /信号：|买入|卖出|该不该买/)
})

test('ready 保持原有证券、价格、指标和综合信号渲染', () => {
  const rendered = renderTechSignal({
    status: 'ready',
    code: '600519',
    name: '贵州茅台',
    as_of: '2026-09-01T09:30:00+08:00',
    stale: false,
    bars: 120,
    last: { close: 1412.35 },
    indicators: {
      ma: { trend: '多头排列' },
      rsi: { rsi14: 61.2, state: '中性' },
      kdj: { k: 70.1, d: 62.3, j: 85.7, cross: '金叉' },
      boll: { upper: 1450, mid: 1390, lower: 1330, state: '中轨上方' },
    },
    signals: [{ type: 'trend', label: '趋势偏强' }],
  })

  assert.match(rendered, /贵州茅台（600519）/)
  assert.match(rendered, /现价 1412\.35/)
  assert.match(rendered, /均线：多头排列/)
  assert.match(rendered, /RSI14 61\.2（中性）/)
  assert.match(rendered, /信号：\[/)
})

test('mw_tech_signal schema 用真实框架校验器接受后端 ready 响应', () => {
  const violations = validateRegisteredOutput('mw_tech_signal', {
    status: 'ready',
    code: '600519',
    name: '贵州茅台',
    as_of: '2026-09-01 09:30:00',
    stale: false,
    bars: 120,
    last: { date: '2026-09-01', close: 1412.35 },
    indicators: { ma: { trend: '多头排列' } },
    signals: ['趋势偏强'],
  })

  assert.deepEqual(violations, [])
})

test('mw_tech_signal schema 用真实框架校验器接受 as_of 为 null 的 preparing 响应', () => {
  const violations = validateRegisteredOutput('mw_tech_signal', {
    status: 'preparing',
    code: '920223',
    as_of: null,
    retry_after_ms: 1500,
    message: '920223 K 线正在后台准备，请稍后重试',
  })

  assert.deepEqual(violations, [])
})

test('mw_tech_signal schema 用真实框架校验器接受 as_of 为 null 的 unavailable 响应', () => {
  const violations = validateRegisteredOutput('mw_tech_signal', {
    status: 'unavailable',
    code: '920223',
    as_of: null,
    reason_code: 'provider_error',
    message: '920223 技术数据暂不可用，请稍后重试',
    retryable: true,
  })

  assert.deepEqual(violations, [])
})

test('mw_tech_signal schema 拒绝未知状态和按态缺失字段', () => {
  assert.notDeepEqual(validateRegisteredOutput('mw_tech_signal', {
    status: 'waiting',
    code: '920223',
    as_of: null,
  }), [])
  assert.notDeepEqual(validateRegisteredOutput('mw_tech_signal', {
    status: 'ready',
    code: '920223',
    name: '荣亿精密',
    as_of: '2026-09-01 09:30:00',
    stale: false,
  }), [])
})

test('mw_scan schema 用真实框架校验器接受双响应形状并要求按态字段', () => {
  const common = {
    trade_date: '2026-09-01',
    as_of: '2026-09-01T09:30:00+08:00',
    source: 'sina',
    stale: false,
    complete: false,
    warnings: ['东财不可用，已使用新浪备用源'],
  }
  const item = {
    code: '920223', name: '荣亿精密', price: 15.83, pct_change: 29.97,
    volume_ratio: null, amount_yi: 2.75, turnover: 12.3,
  }

  assert.deepEqual(validateRegisteredOutput('mw_scan', {
    ...common,
    kind: 'gainers',
    items: [item],
  }), [])
  assert.deepEqual(validateRegisteredOutput('mw_scan', {
    ...common,
    kind: 'limit',
    limit_up: [item],
    limit_down: [],
  }), [])
  const { warnings: _warnings, ...withoutWarnings } = common
  assert.notDeepEqual(validateRegisteredOutput('mw_scan', {
    ...withoutWarnings,
    kind: 'gainers',
    items: [item],
  }), [])
  assert.notDeepEqual(validateRegisteredOutput('mw_scan', {
    ...common,
    kind: 'limit',
    limit_up: [item],
  }), [])
})

test('mw_scan production renderer 分区展示真实涨停和跌停列表', () => {
  const render = registered.get('mw_scan')?.output?.render
  assert.ok(render, 'mw_scan 缺 production output renderer')
  const rendered = render({}, {
    kind: 'limit',
    trade_date: '2026-09-01',
    as_of: '2026-09-01T09:30:00+08:00',
    source: 'sina',
    stale: true,
    complete: false,
    warnings: ['东财不可用，已使用新浪备用源'],
    limit_up: [{
      code: '920223', name: '荣亿精密', price: 15.83, pct_change: 29.97,
      volume_ratio: null, amount_yi: 2.75, turnover: 12.3,
    }],
    limit_down: [{
      code: '600000', name: '浦发银行', price: 9.12, pct_change: -10.0,
      volume_ratio: 1.2, amount_yi: 6.4, turnover: 2.1,
    }],
  })[0]?.text ?? ''

  assert.match(rendered, /涨停（1）/)
  assert.match(rendered, /荣亿精密（920223）/)
  assert.match(rendered, /跌停（1）/)
  assert.match(rendered, /浦发银行（600000）/)
  assert.match(rendered, /来源 sina/)
  assert.match(rendered, /缓存数据/)
  assert.match(rendered, /结果不完整/)
  assert.match(rendered, /东财不可用，已使用新浪备用源/)
  assert.doesNotMatch(rendered, /暂无数据/)
})

test('mw_scan production renderer 展示普通榜单及其来源状态', () => {
  const render = registered.get('mw_scan')?.output?.render
  assert.ok(render, 'mw_scan 缺 production output renderer')
  const rendered = render({}, {
    kind: 'gainers',
    trade_date: '2026-09-01',
    as_of: '2026-09-01T09:30:00+08:00',
    source: 'eastmoney',
    stale: false,
    complete: true,
    warnings: [],
    items: [{
      code: '920223', name: '荣亿精密', price: 15.83, pct_change: 29.97,
      volume_ratio: null, amount_yi: 2.75, turnover: 12.3,
    }],
  })[0]?.text ?? ''

  assert.match(rendered, /荣亿精密（920223）/)
  assert.match(rendered, /来源 eastmoney/)
  assert.doesNotMatch(rendered, /缓存数据|结果不完整/)
})

test('mw_flash schema 接受真实 base/full tier 并拒绝旧 enriched 值', () => {
  const common = {
    as_of: '2026-09-01 09:30:00',
    sources: ['新浪财经'],
    complete: true,
    stale: false,
    items: [],
  }

  assert.deepEqual(validateRegisteredOutput('mw_flash', { ...common, tier: 'base' }), [])
  assert.deepEqual(validateRegisteredOutput('mw_flash', { ...common, tier: 'full' }), [])
  assert.notDeepEqual(validateRegisteredOutput('mw_flash', { ...common, tier: 'enriched' }), [])
})

console.log(`render-status: ${passed}/11 passed`)
