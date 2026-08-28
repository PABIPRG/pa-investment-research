// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrategyResearchPage } from '../src/client/ProductPages.tsx'

afterEach(cleanup)

function renderStrategyPage(
  requestData: ReturnType<typeof vi.fn>,
  onSelectStrategy: (strategyId: string) => void = () => {},
) {
  return render(<StrategyResearchPage
    requestData={requestData as never}
    selectedStrategyId=""
    onSelectStrategy={onSelectStrategy}
    onOpenShadow={() => {}}
    onOpenReports={() => {}}
    onAnalyze={() => {}}
  />)
}

describe('策略研究产品事实与确认流程', () => {
  it('查看详情只打开临时内容，后续策略动作才选择工作对象', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 'strategy-1', name: '详情浏览策略', status: 'active' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const onSelectStrategy = vi.fn()

    renderStrategyPage(requestData, onSelectStrategy)
    const card = (await screen.findByText('详情浏览策略')).closest('article')
    expect(card).not.toBeNull()
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '查看详情' }))

    const dialog = await screen.findByRole('dialog', { name: '详情浏览策略' })
    expect(onSelectStrategy).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'AI 评审' }))
    expect(onSelectStrategy).toHaveBeenCalledWith('strategy-1')
  })

  it('候选卡以股票名称和涨跌色标签展示，不暴露机器策略名', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [{
            id: 'legacy-rsi', name: '利空·rsi_reversal·600519', kind: 'rsi_reversal',
            status: 'candidate', verification_status: 'pending', direction: '利空',
            symbols: ['600519'], hypothesis: '短期超卖后观察反弹。',
          }],
        }
      }
      if (request.operation === 'market-watch.security-search') {
        return { items: [{ code: request.input?.query, name: '贵州茅台' }] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    expect(await screen.findByText('贵州茅台 · 600519')).toBeTruthy()
    expect(screen.getByText('超跌反弹')).toBeTruthy()
    const direction = screen.getByText('利空')
    expect(direction.getAttribute('data-direction')).toBe('利空')
    expect(screen.queryByText('利空·rsi_reversal·600519')).toBeNull()
  })

  it('参数缺失时不补造默认规则，未知类型也不解释成动量策略', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [
            { id: 'ma-missing', name: '均线参数缺失', kind: 'ma_cross', status: 'active', params: {}, backtest: null },
            { id: 'rsi-missing', name: 'RSI 参数缺失', kind: 'rsi_reversal', status: 'active', params: {}, backtest: null },
            { id: 'momentum-missing', name: '动量参数缺失', kind: 'momentum', status: 'active', params: {}, backtest: null },
            { id: 'unknown-kind', name: '未知事件策略', kind: 'event', status: 'active', params: { n: 10 }, backtest: null },
          ],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    const maCard = (await screen.findByText('均线参数缺失')).closest('article')
    expect(maCard).not.toBeNull()
    fireEvent.click(within(maCard as HTMLElement).getByRole('button', { name: '查看详情' }))

    let dialog = await screen.findByRole('dialog', { name: '均线参数缺失' })
    expect(within(dialog).getByText('快线 未返回')).toBeTruthy()
    expect(within(dialog).getByText('慢线 未返回')).toBeTruthy()
    expect(dialog.textContent).toContain('数据不足：后端未返回完整的快线和慢线参数')
    expect(dialog.textContent).not.toContain('5 日均线')
    expect(dialog.textContent).not.toContain('20 日均线')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

    const rsiCard = screen.getByText('RSI 参数缺失').closest('article')
    expect(rsiCard).not.toBeNull()
    fireEvent.click(within(rsiCard as HTMLElement).getByRole('button', { name: '查看详情' }))
    dialog = await screen.findByRole('dialog', { name: 'RSI 参数缺失' })
    expect(dialog.textContent).toContain('RSI 周期 未返回')
    expect(dialog.textContent).toContain('超卖阈值 未返回')
    expect(dialog.textContent).toContain('超买阈值 未返回')
    expect(dialog.textContent).not.toContain('14 日 RSI')
    expect(dialog.textContent).not.toContain('低于 30')
    expect(dialog.textContent).not.toContain('高于 70')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

    const momentumCard = screen.getByText('动量参数缺失').closest('article')
    expect(momentumCard).not.toBeNull()
    fireEvent.click(within(momentumCard as HTMLElement).getByRole('button', { name: '查看详情' }))
    dialog = await screen.findByRole('dialog', { name: '动量参数缺失' })
    expect(dialog.textContent).toContain('动量窗口 未返回')
    expect(dialog.textContent).not.toContain('10 个交易日前')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

    const unknownCard = screen.getByText('未知事件策略').closest('article')
    expect(unknownCard).not.toBeNull()
    fireEvent.click(within(unknownCard as HTMLElement).getByRole('button', { name: '查看详情' }))
    dialog = await screen.findByRole('dialog', { name: '未知事件策略' })
    expect(dialog.textContent).toContain('暂不支持解释的策略类型“event”')
    expect(dialog.textContent).toContain('策略参数 已返回，但因类型未知未作解释')
    expect(dialog.textContent).not.toContain('10 个交易日前')
    expect(dialog.textContent).not.toContain('动量条件失效')
  })

  it('先以 dry_run 预览假设，只有用户确认后才写入候选池', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') return { items: [] }
      if (request.operation === 'trading-core.strategies-hypothesize' && request.input?.dry_run === true) {
        return {
          n_events: 2,
          hypotheses: [{
            event_idx: 0,
            symbols: ['600519'],
            direction: '利好',
            kind: 'ma_cross',
            params: { fast: 8, slow: 34 },
            rationale: '渠道库存改善可能带来趋势延续。',
            holding_window_days: 15,
          }],
          candidates: [],
        }
      }
      if (request.operation === 'trading-core.strategies-hypothesize' && request.input?.dry_run === false) {
        return { n_events: 2, hypotheses: [], candidates: ['candidate-1'] }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    fireEvent.click(await screen.findByRole('button', { name: '从事件生成候选' }))

    const dialog = await screen.findByRole('dialog', { name: '候选假设预览' })
    expect(within(dialog).getByText('渠道库存改善可能带来趋势延续。')).toBeTruthy()
    expect(dialog.textContent).toContain('8 日均线高于 34 日均线')
    const hypothesisCallsBeforeConfirm = requestData.mock.calls.filter(([request]) => (
      request.operation === 'trading-core.strategies-hypothesize'
    ))
    expect(hypothesisCallsBeforeConfirm.map(([request]) => request.input)).toEqual([
      { limit: 20, dry_run: true },
    ])

    fireEvent.click(within(dialog).getByRole('button', { name: '确认加入候选池' }))
    expect(await screen.findByText('已确认加入 1 个候选策略。')).toBeTruthy()
    const hypothesisCalls = requestData.mock.calls.filter(([request]) => (
      request.operation === 'trading-core.strategies-hypothesize'
    ))
    expect(hypothesisCalls.map(([request]) => request.input)).toEqual([
      { limit: 20, dry_run: true },
      { limit: 20, dry_run: false },
    ])
  })

  it('验证分类只依据显式验证与回测证据，不以 lifecycle 状态兜底', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [
            { id: 'verified', name: '明确通过', status: 'rejected', verification_status: 'passed' },
            { id: 'failed', name: '明确失败', status: 'active', verification_status: 'failed' },
            { id: 'archived', name: '明确归档', status: 'active', archived_at: '2026-08-26' },
            { id: 'retired-only', name: '仅生命周期退役', status: 'retired' },
            { id: 'active-only', name: '仅生命周期生效', status: 'active' },
          ],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    expect(await screen.findByRole('button', { name: '已验证通过 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '验证未通过 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '已归档 1' })).toBeTruthy()
    const unverified = screen.getByRole('button', { name: '未验证 2' })
    fireEvent.click(unverified)
    expect(screen.getByText('仅生命周期退役')).toBeTruthy()
    expect(screen.getByText('仅生命周期生效')).toBeTruthy()
    expect(screen.queryByText('明确通过')).toBeNull()
  })

  it('空预览不会出现可执行的写入动作', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') return { items: [] }
      if (request.operation === 'trading-core.strategies-hypothesize') {
        return { hypotheses: [], candidates: [], note: '事件源暂无可用事件' }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    fireEvent.click(await screen.findByRole('button', { name: '从事件生成候选' }))
    const dialog = await screen.findByRole('dialog', { name: '候选假设预览' })
    expect(within(dialog).getByText('事件源暂无可用事件')).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '确认加入候选池' }).disabled).toBe(true)
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.strategies-hypothesize' && request.input?.dry_run === false)).toBe(false)
  })
})
