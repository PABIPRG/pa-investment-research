// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { EventReportDialog, RiskDetailDialog } from '../src/client/DetailDialogs.tsx'

afterEach(cleanup)

describe('风险与事件详情回归', () => {
  it('风险详情展示后端当前值、预算上限、影响范围及降级提示', () => {
    render(<RiskDetailDialog
      item={{
        id: 'risk-concentration',
        title: '集中度超过预算',
        detail: '单一标的权重超过稳健型组合预算。',
        severity: '高',
        source: 'portfolio',
        value: '42.5%',
        limit: '30.0%',
        codes: ['600519'],
        degraded: true,
        degraded_reason: '关联事件暂未更新，组合风险事实仍可用。',
      }}
      onClose={() => {}}
    />)

    const dialog = screen.getByRole('dialog', { name: '集中度超过预算' })
    const reason = dialog.querySelector<HTMLElement>('[data-field="risk-reason"]')
    const impact = dialog.querySelector<HTMLElement>('[data-field="risk-impact"]')
    expect(reason?.textContent).toContain('当前值 42.5%')
    expect(reason?.textContent).toContain('预算上限 30.0%')
    expect(impact?.textContent).toContain('关联范围包含 600519')
    expect(impact?.textContent).toContain('不会据此自动调整持仓')
    expect(within(dialog).getByRole('status').textContent)
      .toContain('关联事件暂未更新，组合风险事实仍可用。')
    expect(within(dialog).getByText('部分数据降级')).toBeTruthy()
  })

  it('风险值缺失时明确显示占位值和数据不足，不伪造零值', () => {
    render(<RiskDetailDialog
      item={{
        title: '画像预算待复核',
        severity: '中',
        source: 'profile',
        indicator: 'volatility_budget',
      }}
      onClose={() => {}}
    />)

    const dialog = screen.getByRole('dialog', { name: '画像预算待复核' })
    const reason = dialog.querySelector<HTMLElement>('[data-field="risk-reason"]')
    expect(reason?.textContent).toContain('当前值 —')
    expect(reason?.textContent).toContain('预算上限 —')
    expect(reason?.textContent).toContain('数据不足')
    expect(reason?.textContent).not.toContain('当前值 0')
    expect(dialog.querySelector('[data-field="risk-impact"]')?.textContent)
      .toContain('影响当前组合风险预算判断')
  })

  it('无 report_id 的事件只渲染即时 Markdown，不请求持久报告', () => {
    const requestData = vi.fn(async (_request: InvestmentDataRequest) => ({}))
    render(<EventReportDialog
      item={{
        card_id: 'card-live-1',
        event_id: 'event-live-1',
        title: '白酒经营数据改善',
        summary: '即时卡片摘要证据',
        source: '交易所',
        time: '2026-08-26 09:20:00',
        direction: '利好',
        tickers: [{ code: '600519', name: '贵州茅台' }],
        reasons: ['命中真实持仓'],
        risk: { level: '低', note: '仍需复核估值' },
      }}
      requestData={requestData}
      onClose={() => {}}
    />)

    const dialog = screen.getByRole('dialog', { name: '白酒经营数据改善' })
    expect(within(dialog).getByText('由事件原始字段即时整理的 Markdown 研究文档')).toBeTruthy()
    const markdown = within(dialog).getByTestId('markdown-body')
    expect(markdown.textContent).toContain('即时卡片摘要证据')
    expect(markdown.textContent).toContain('命中真实持仓')
    expect(markdown.textContent).toContain('贵州茅台（600519）')
    expect(requestData).not.toHaveBeenCalled()
  })

  it('有 report_id 的事件请求持久报告并只展示 sections 正文', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation !== 'trading-core.report') throw new Error('unexpected operation')
      return {
        id: 'report-event-1',
        title: '正式事件投研报告',
        sections: [
          { key: 'conclusion', title: '核心结论', content: '持久报告正文证据：订单改善仍需样本外验证。' },
          { key: 'risk', title: '主要风险', content: '需求回落会使当前结论失效。' },
        ],
      }
    })
    render(<EventReportDialog
      item={{
        report_id: 'report-event-1',
        title: '事件卡片标题',
        summary: '卡片即时文档不得冒充持久报告',
        source: '行业协会',
      }}
      requestData={requestData}
      onClose={() => {}}
    />)

    expect(await screen.findByRole('dialog', { name: '正式事件投研报告' })).toBeTruthy()
    expect(requestData).toHaveBeenCalledOnce()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.report', input: { report_id: 'report-event-1' },
    })
    const markdown = screen.getByTestId('markdown-body')
    expect(markdown.textContent).toContain('核心结论')
    expect(markdown.textContent).toContain('持久报告正文证据：订单改善仍需样本外验证。')
    expect(markdown.textContent).toContain('主要风险')
    expect(markdown.textContent).not.toContain('卡片即时文档不得冒充持久报告')
  })

  it('持久报告读取失败显示可重试错误，失败期间不回退到卡片即时文档', async () => {
    let attempts = 0
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation !== 'trading-core.report') throw new Error('unexpected operation')
      attempts += 1
      if (attempts === 1) throw new Error('报告服务暂不可用')
      return {
        id: 'report-event-retry',
        title: '重试后的正式报告',
        sections: [{ key: 'body', title: '报告正文', content: '重试后读取到的持久正文。' }],
      }
    })
    render(<EventReportDialog
      item={{
        report_id: 'report-event-retry',
        title: '事件卡片标题',
        summary: 'CARD_ONLY_SENTINEL',
      }}
      requestData={requestData}
      onClose={() => {}}
    />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('持久投研报告暂不可用')
    expect(alert.textContent).toContain('报告服务暂不可用')
    expect(screen.queryByTestId('markdown-body')).toBeNull()
    expect(screen.queryByText('CARD_ONLY_SENTINEL')).toBeNull()

    fireEvent.click(within(alert).getByRole('button', { name: '重新读取' }))
    expect(await screen.findByText('重试后读取到的持久正文。')).toBeTruthy()
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText('CARD_ONLY_SENTINEL')).toBeNull()
  })
})
