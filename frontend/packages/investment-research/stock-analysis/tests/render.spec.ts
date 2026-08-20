import { describe, expect, it } from 'vitest'
import {
  profileLabel,
  renderBrief,
  renderBriefCard,
  renderFullReport,
  renderHoldingsCard,
  renderHoldingsReport,
  renderResultCard,
  renderSignalCard,
} from '../src/render.ts'

describe('stock-analysis renderers', () => {
  it('renders Chinese signal success with optional risk and calibration details', () => {
    const card = renderSignalCard({
      action: '买入', company_name: '贵州茅台', target_price: 1800, confidence: 0.82, risk_score: 0.2,
      reasoning: '现金流稳定', risk_profile: 'balanced', calibration: true, calibration_note: '降低仓位', model_info: 'deepseek',
    })
    expect(card).toContain('## 🟢 买入 · 贵州茅台')
    expect(card).toContain('¥1800.00 | 82% | 20%')
    expect(card).toContain('风险画像：稳健型')
    expect(card).toContain('风险偏好护栏已校准：降低仓位')
    expect(renderResultCard({ signal: { ticker: '600519' } })).toContain('600519')
    expect(profileLabel('unknown')).toBe('unknown')
  })

  it('renders empty signal fields and ordered non-empty reports without changing their Chinese content', () => {
    const report = renderFullReport({
      signal: {},
      reports: { market: ' 市场数据 ', news: '新闻', risk: '   ', ignored: '不显示' },
    })
    expect(report).toContain('## — · ')
    expect(report).toContain('¥— | — | —')
    expect(report).toContain('## 📊 市场分析\n\n市场数据')
    expect(report).toContain('## 📰 新闻分析\n\n新闻')
    expect(report).not.toContain('不显示')
  })

  it('renders holdings fallbacks, risks and preserved adapter portfolio markdown', () => {
    const card = renderHoldingsCard({
      mode: 'deep', n_positions: 1, total_market_value: 100, total_cost: 120, floating_pnl: -20,
      floating_pnl_pct: -0.2, weighted_risk_score: 0.7, portfolio_annualized_vol: 0.3, concentration_hhi: 0.8,
      risk_profile: 'aggressive', risk_breaches: [{ indicator: 'single_stock_weight', label: '茅台', value: 0.8, limit: 0.5 }],
      rebalance_suggestions: ['降低集中度'], sector_exposure: [{ industry: '白酒', weight: 0.8 }],
    })
    expect(card).toContain('深度逐股分析')
    expect(card).toContain('单股权重（茅台） 80% 超预算 50%')
    expect(card).toContain('降低集中度')
    expect(card).toContain('白酒 80.0%')
    expect(renderHoldingsReport({ signal: { per_stock: { '600519': { name: '贵州茅台', beta: null } } } })).toContain('贵州茅台')
    expect(renderHoldingsReport({ signal: {}, reports: { portfolio: ' 已生成报告 ' } })).toBe('已生成报告')
  })

  it('renders brief summary or an empty Chinese opportunity fallback', () => {
    expect(renderBriefCard({ period: 'post_market', trade_date: '2026-08-20', opportunities: [{}] }))
      .toContain('A股盘后简报')
    expect(renderBrief({ signal: { summary: '  **盘后**  ' } })).toBe('**盘后**')
    expect(renderBrief({ signal: { opportunities: [{ risk_level: '高', title: '关注政策' }] } }))
      .toContain('- [高] 关注政策')
  })

  it('keeps null stock, breach, holdings and brief fields readable', () => {
    expect(profileLabel()).toBe('')
    expect(renderSignalCard({ action: '未知', confidence: null, risk_score: null, target_price: null })).toContain('¥— | — | —')
    expect(renderFullReport({ signal: { ticker: '600519' }, reports: { market: '' } })).not.toContain('市场分析')
    expect(renderFullReport({ signal: { ticker: '600519' } })).toContain('600519')
    const breachCard = renderHoldingsCard({
      risk_breaches: [
        { indicator: 'beta', value: null, limit: null },
        { indicator: 'hhi', value: 0.2, limit: 0.3 },
        { indicator: 'unknown', value: 0.1 },
      ],
    } as never)
    expect(breachCard).toContain('组合 β')
    expect(breachCard).toContain('unknown 10% 超预算 0%')
    expect(renderHoldingsCard({ risk_breaches: [{ value: 0, limit: 0 }] })).toContain('0% 超预算 0%')
    expect(renderHoldingsCard({})).not.toContain('调仓建议')
    let suggestionReads = 0
    const changingSuggestions = {
      get rebalance_suggestions() {
        suggestionReads++
        return suggestionReads === 1 ? ['先读取'] : undefined
      },
    }
    expect(renderHoldingsCard(changingSuggestions as never)).toContain('调仓建议')
    expect(renderHoldingsReport({ signal: { per_stock: { '1': { beta: 1, risk_score: 0, action: null, reasoning: null } } } })).toContain('| 1 |')
    expect(renderBriefCard({ period: 'pre_market', risk_profile: 'unknown' })).toContain('unknown')
    expect(renderBrief({ signal: { period: 'now', opportunities: [{}, { title: '无评级' }] } })).toContain('无评级')
  })
})
