import { describe, expect, it } from 'vitest'
import {
  renderAlerts,
  renderBrief,
  renderNews,
  renderOverview,
  renderScan,
  renderTechSignal,
  renderWatchlist,
} from '../src/render.ts'

describe('market-watch renderers', () => {
  it('renders Chinese watchlists and alerts, including empty states and guards', () => {
    expect(renderWatchlist({})).toContain('自选列表为空')
    expect(renderWatchlist({ items: [{ code: '600519', name: '贵州茅台' }] })).toContain('1. 贵州茅台（600519）')
    expect(renderAlerts({})).toContain('暂无盯盘规则')
    expect(renderAlerts({ items: [{ id: 'a1', name: '突破', ticker: '600519', combine: 'and', conditions: [{ field: '涨幅', operator: '>', value: 3 }], enabled: false, cooldown_min: 5, daily_cap: 2 }] }))
      .toContain('涨幅 > 3 ⏸ （冷却5min，日限2次）')
  })

  it('renders market scans for limit, ranked, and empty data paths', () => {
    expect(renderScan({ kind: 'limit', trade_date: '2026-08-20', limit_up: [{ name: '茅台', code: '600519', price: 10, pct_change: 1 }], limit_down: [] }))
      .toContain('📈 涨停 1 只')
    expect(renderScan({ kind: 'gainers', items: [{ name: '宁德', code: '300750', price: 20, pct_change: 2, volume_ratio: 3, turnover: 4, amount_yi: 5 }], as_of: '10:00' }))
      .toContain('量比 3')
    expect(renderScan({ kind: 'limit', limit_up: [], limit_down: [] })).toContain('今日无涨跌停')
  })

  it('renders overview and technical success plus Chinese empty fallbacks', () => {
    expect(renderOverview({})).toContain('盯盘面板为空')
    expect(renderOverview({ trade_date: '2026-08-20', items: [{ name: '茅台', code: '600519', price: 10, pct_change: -1, volume_ratio: 2, turnover: 3, amount_yi: 4, fund_flow_yi: 5, hit: [{ name: '止损' }], near: [{ name: '目标' }] }] }))
      .toContain('🔥命中:止损')
    expect(renderTechSignal({ name: '茅台', code: '600519', bars: 60, signals: ['金叉'], indicators: { support_resistance: { support: 10, resistance: 12 }, pattern: { pattern: '突破' } } }))
      .toContain('支撑/压力 10/12')
    expect(renderTechSignal({})).toContain('数据不足，无可用信号')
    expect(renderOverview({ items: [{ name: '只有命中', code: '2', hit: [{ name: '突破' }] }] })).toContain('🔥命中:突破')
  })

  it('renders news and brief success, empty fields, and template errors', () => {
    expect(renderNews({ trade_date: '2026-08-20', items: { global: ['政策利好'], stocks: { '600519': ['业绩预增'] } }, digest: '谨慎乐观' }))
      .toContain('## 600519')
    expect(renderNews({})).toContain('本次无新闻返回（数据源暂不可用）')
    expect(renderBrief({ period: 'post', trade_date: '2026-08-20', llm_used: true, content: '复盘' }))
      .toBe('**盘后复盘** · 2026-08-20（LLM 生成）\n\n复盘')
    expect(renderBrief({})).toContain('盘前关注')
  })

  it('keeps null and omitted fields readable across every optional renderer branch', () => {
    expect(renderAlerts({ items: [{ id: 'x', name: '全局', conditions: [], ticker: '', enabled: true }] })).toContain('全部自选')
    expect(renderAlerts({ items: [{ id: 'bad', name: '异常', conditions: 'unknown' }] })).toContain('：-')
    expect(renderScan({ kind: 'gainers', items: [{ name: '空值', code: '0', price: null, pct_change: null, volume_ratio: null, turnover: null, amount_yi: null }] })).toContain('-')
    expect(renderScan({ kind: 'limit', limit_up: [], limit_down: [{ name: '跌停', code: '1', price: null, pct_change: null }] })).toContain('📉 跌停')
    expect(renderScan({ kind: 'limit' })).toContain('今日无涨跌停')
    expect(renderOverview({ items: [{ name: '空值', code: '0', price: null, pct_change: null, volume_ratio: null, turnover: null, amount_yi: null, fund_flow_yi: null, hit: [], near: [] }] })).toContain('量比-')
    expect(renderTechSignal({ indicators: { support_resistance: { support: null, resistance: null }, pattern: {} }, signals: [] })).toContain('数据不足')
    expect(renderNews({ items: { global: [], stocks: { '000001': [] } } })).toContain('## 000001')
    expect(renderNews({ items: { stocks: { '000002': undefined } } })).toContain('## 000002')
    expect(renderOverview({ items: [{ name: '只有逼近', code: '3', near: [{ name: '止损' }] }] })).toContain('⚠️逼近:止损')
  })
})
