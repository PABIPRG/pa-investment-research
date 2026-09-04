// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrategyResearchPage } from '../src/client/ProductPages.tsx'
import css from '../src/client/InvestmentShell.module.css'

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
  it('旧策略只有最近回测快照时明确提示历史未留存', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') return {
        items: [{
          id: 'legacy-strategy', name: '旧策略', status: 'active',
          verification_status: 'passed', backtest: { ran_at: '2026-08-20 15:00:00' },
        }],
      }
      if (request.operation === 'trading-core.strategy-backtests') return { tasks: [] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    const view = renderStrategyPage(requestData)
    expect(view.container.firstElementChild?.classList.contains(css.primaryRouteSurface)).toBe(true)
    const card = (await screen.findByText('旧策略')).closest('article')
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '回测管理' }))
    expect(await screen.findByText(/历史未留存：该策略仅保留最近一次回测证据/)).toBeTruthy()
  })

  it('生命周期默认收起，帮助弹层按所选策略证据高亮并提供可操作入口', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [{
            id: 'strategy-with-backtest', name: '已回测候选', status: 'candidate',
            verification_status: 'pending', backtest: { out_of_sample: { n_evaluated: 6 } },
          }],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })
    const props = {
      requestData: requestData as never,
      selectedStrategyId: 'strategy-with-backtest',
      onSelectStrategy: () => {},
      onOpenShadow: () => {},
      onOpenReports: () => {},
      onAnalyze: () => {},
    }

    const view = render(<StrategyResearchPage {...props} />)
    await screen.findByText('已回测候选')
    expect(screen.queryByRole('heading', { name: '策略生命周期' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '了解策略生命周期' }))
    const helpDialog = screen.getByRole('dialog', { name: '策略生命周期' })

    const lifecycle = within(helpDialog).getByRole('navigation', { name: '策略生命周期步骤' })
    const formation = within(lifecycle).getByRole('button', { name: /1.*事件形成假设/u })
    const backtest = within(lifecycle).getByRole('button', { name: /2.*样本外回测/u })
    expect(within(lifecycle).getByRole('button', { name: /3.*影子验证/u })).toBeTruthy()
    expect(within(lifecycle).getByRole('button', { name: /4.*进化诊断/u })).toBeTruthy()
    expect(formation.hasAttribute('aria-current')).toBe(false)
    expect(backtest.getAttribute('aria-current')).toBe('step')

    const lifecycleHelp = [
      [formation, '从真实市场事件形成候选；点击查看全部候选。'],
      [backtest, '候选产生回测证据后进入；点击筛选待验证策略。'],
      [within(lifecycle).getByRole('button', { name: /3.*影子验证/u }), '首次回测任务完成后自动进入；验证结果不作为人工生效开关。'],
      [within(lifecycle).getByRole('button', { name: /4.*进化诊断/u }), '影子验证积累证据后查看判定；进入前需先选择策略。'],
    ] as const
    for (const [button, help] of lifecycleHelp) {
      fireEvent.mouseEnter(button)
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip.textContent).toBe(help)
      expect(tooltip.style.position).toBe('absolute')
      expect(button.getAttribute('aria-describedby')).toBe(tooltip.id)
      fireEvent.mouseLeave(button)
      expect(screen.queryByRole('tooltip')).toBeNull()
    }

    fireEvent.focus(backtest)
    expect(screen.getByRole('tooltip').textContent).toContain('候选产生回测证据后进入')
    fireEvent.blur(backtest)

    fireEvent.click(backtest)
    expect(screen.getByRole('button', { name: '未验证 1' }).getAttribute('aria-pressed')).toBe('true')

    view.rerender(<StrategyResearchPage {...props} selectedStrategyId="" />)
    fireEvent.click(screen.getByRole('button', { name: '了解策略生命周期' }))
    expect(screen.getByRole('navigation', { name: '策略生命周期步骤' }).querySelector('[aria-current="step"]')).toBeNull()
    expect(screen.queryByRole('button', { name: '人工确认生效' })).toBeNull()
  })

  it('回测历史展示新状态与来源，并提供取消、重跑和报告入口', async () => {
    const onOpenReports = vi.fn()
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 's-1', name: '任务化策略', status: 'active', verification_status: 'not_passed' }] }
      }
      if (request.operation === 'trading-core.strategy-backtests') {
        return { tasks: [
          { task_id: 't-pending', status: 'pending', source: 'initial_auto', created_at: '2026-09-03 09:00:00' },
          { task_id: 't-cancelled', status: 'cancelled', source: 'periodic_retest', created_at: '2026-09-02 09:00:00' },
          { task_id: 't-completed', status: 'completed', source: 'manual', verification_status: 'not_passed', thresholds_pass: false, report_id: 'a'.repeat(32), created_at: '2026-09-01 09:00:00' },
        ] }
      }
      if (request.operation === 'trading-core.strategy-backtest-cancel') return { status: 'cancelled' }
      if (request.operation === 'trading-core.strategy-backtest-retry') return { task_id: 't-retry' }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<StrategyResearchPage
      requestData={requestData as never}
      selectedStrategyId=""
      onSelectStrategy={() => {}}
      onOpenShadow={() => {}}
      onOpenReports={onOpenReports}
      onAnalyze={() => {}}
    />)
    const card = (await screen.findByText('任务化策略')).closest('article')
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '回测管理' }))
    const dialog = await screen.findByRole('dialog', { name: '任务化策略' })
    expect(within(dialog).getByRole('list', { name: '回测任务历史' })).toBeTruthy()
    expect(within(dialog).getAllByText('首次自动').length).toBeGreaterThan(0)
    const taskList = within(dialog).getByRole('list', { name: '回测任务历史' })
    expect(within(taskList).getByRole('listitem', { name: '周期复测 · 已取消' })).toBeTruthy()
    expect(within(dialog).getByText('已取消')).toBeTruthy()
    expect(within(dialog).getAllByText('未通过').length).toBeGreaterThan(0)

    const cancelButton = within(dialog).getByRole('button', { name: '取消任务' })
    fireEvent.click(cancelButton)
    fireEvent.click(cancelButton)
    await waitFor(() => expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.strategy-backtest-cancel',
      input: { strategy_id: 's-1', task_id: 't-pending' },
    }))
    expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.strategy-backtest-cancel')).toHaveLength(1)
    const cancelledRow = within(taskList).getByRole('listitem', { name: '周期复测 · 已取消' })
    fireEvent.click(within(cancelledRow as HTMLElement).getByRole('button', { name: '重新运行' }))
    await waitFor(() => expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.strategy-backtest-retry',
      input: { strategy_id: 's-1', task_id: 't-cancelled' },
    }))
    fireEvent.click(within(dialog).getByRole('button', { name: '查看报告' }))
    expect(onOpenReports).toHaveBeenCalledWith('a'.repeat(32))
  })

  it('策略归档需要二次确认，确认后以 retire 迁移并进入已归档分类', async () => {
    let archived = false
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [{
            id: 'strategy-to-archive', name: '待归档策略',
            status: archived ? 'retired' : 'active',
            verification_status: archived ? 'archived' : 'passed',
          }],
        }
      }
      if (request.operation === 'trading-core.strategy-transition') {
        archived = true
        return { id: 'strategy-to-archive', status: 'retired', verification_status: 'archived' }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    const card = (await screen.findByText('待归档策略')).closest('article')
    expect(card).not.toBeNull()
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '归档' }))

    const dialog = await screen.findByRole('dialog', { name: '归档策略' })
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.strategy-transition')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }))

    await screen.findByText('策略已归档，历史证据仍可在“已归档”中查看。')
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.strategy-transition',
      input: { strategy_id: 'strategy-to-archive', action: 'retire' },
    })
    expect(screen.getByRole('button', { name: '已归档 1' })).toBeTruthy()
  })

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

  it('进化诊断标题使用证券名称、代码和中文策略类型', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') return { items: [{
        id: 'legacy-rsi', name: '利空·rsi_reversal·601398', kind: 'rsi_reversal', status: 'active', symbols: ['601398'],
      }] }
      if (request.operation === 'market-watch.security-search') return { items: [{ code: request.input?.query, name: '工商银行' }] }
      if (request.operation === 'trading-core.evolution-status') return {
        lifecycle: { active: [{ strategy_id: 'legacy-rsi', symbols: ['601398'] }] },
        per_strategy: [{ strategy_id: 'legacy-rsi', decision: 'none' }], recent_applied: [],
      }
      if (request.operation === 'trading-core.evolution-attribution') return { strategies: [{ strategy_id: 'legacy-rsi' }] }
      if (request.operation === 'trading-core.strategy-detail') return { id: 'legacy-rsi', kind: 'rsi_reversal', symbols: ['601398'] }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    render(<StrategyResearchPage
      requestData={requestData as never}
      selectedStrategyId="legacy-rsi"
      onSelectStrategy={() => {}}
      onOpenShadow={() => {}}
      onOpenReports={() => {}}
      onAnalyze={() => {}}
      initialStage="evolution"
    />)

    expect(await screen.findByRole('heading', { name: '工商银行(601398) · 超跌反弹 · 进化诊断' })).toBeTruthy()
    expect(screen.queryByText(/rsi_reversal/u)).toBeNull()
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

  it('后端新增的通道突破/布林超跌/放量突破类型有可解释的触发与退出规则', async () => {
    const requestData = vi.fn(async (request: { operation: string }) => {
      if (request.operation === 'trading-core.strategies') {
        return {
          items: [
            { id: 's-breakout', name: '通道突破候选', kind: 'breakout', status: 'active', params: { n: 20 }, backtest: null },
            { id: 's-bollinger', name: '布林超跌候选', kind: 'bollinger', status: 'active', params: { n: 20, k: 2 }, backtest: null },
            { id: 's-volume', name: '放量突破候选', kind: 'volume_breakout', status: 'active', params: { n: 20, vol_mult: 1.5 }, backtest: null },
          ],
        }
      }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    const breakoutCard = (await screen.findByText('通道突破候选')).closest('article')
    expect(breakoutCard).not.toBeNull()
    fireEvent.click(within(breakoutCard as HTMLElement).getByRole('button', { name: '查看详情' }))
    let dialog = await screen.findByRole('dialog', { name: '通道突破候选' })
    expect(dialog.textContent).toContain('收盘价突破前 20 日最高价后，按下一交易日开盘价进入纸面持仓。')
    expect(dialog.textContent).toContain('收盘价跌破前 20 日最低价后，按下一交易日开盘价退出。')
    expect(dialog.textContent).toContain('突破窗口 20 日')
    expect(dialog.textContent).not.toContain('暂不支持解释')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

    const bollingerCard = screen.getByText('布林超跌候选').closest('article')
    expect(bollingerCard).not.toBeNull()
    fireEvent.click(within(bollingerCard as HTMLElement).getByRole('button', { name: '查看详情' }))
    dialog = await screen.findByRole('dialog', { name: '布林超跌候选' })
    expect(dialog.textContent).toContain('收盘价跌破 20 日布林带下轨（中轨 − 2 倍标准差）后')
    expect(dialog.textContent).toContain('收盘价回升至 20 日中轨上方后')
    expect(dialog.textContent).toContain('带宽系数 2')
    expect(dialog.textContent).not.toContain('暂不支持解释')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

    const volumeCard = screen.getByText('放量突破候选').closest('article')
    expect(volumeCard).not.toBeNull()
    fireEvent.click(within(volumeCard as HTMLElement).getByRole('button', { name: '查看详情' }))
    dialog = await screen.findByRole('dialog', { name: '放量突破候选' })
    expect(dialog.textContent).toContain('收盘价突破前 20 日最高价，且成交量达到前 20 日均量 1.5 倍以上后')
    expect(dialog.textContent).toContain('收盘价跌破前 20 日最低价后')
    expect(dialog.textContent).toContain('放量倍数 1.5 倍')
    expect(dialog.textContent).not.toContain('暂不支持解释')
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
    expect(await screen.findByRole('button', { name: '了解策略生命周期' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '策略生命周期' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '从事件新建策略' }))

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
    expect(screen.getByRole('button', { name: '已归档 2' })).toBeTruthy()
    const unverified = screen.getByRole('button', { name: '未验证 1' })
    fireEvent.click(unverified)
    expect(screen.getByText('仅生命周期生效')).toBeTruthy()
    expect(screen.queryByText('仅生命周期退役')).toBeNull()
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
    fireEvent.click(await screen.findByRole('button', { name: '从事件新建策略' }))
    const dialog = await screen.findByRole('dialog', { name: '候选假设预览' })
    expect(within(dialog).getByText('事件源暂无可用事件')).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '确认加入候选池' }).disabled).toBe(true)
    expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.strategies-hypothesize' && request.input?.dry_run === false)).toBe(false)
  })

  it('回测窗口可选：新建任务向导把用户选择的年份传给后端，默认 2 年', async () => {
    const requestData = vi.fn(async (request: { operation: string; input?: Record<string, unknown> }) => {
      if (request.operation === 'trading-core.strategies') {
        return { items: [{ id: 's-1', name: '可回测策略', status: 'active', kind: 'ma_cross', backtest: null }] }
      }
      if (request.operation === 'trading-core.strategy-backtests') return { strategy_id: 's-1', count: 0, tasks: [] }
      if (request.operation === 'trading-core.strategy-run') return { task_id: 'task-1' }
      if (request.operation === 'trading-core.task-status') return { status: 'done' }
      if (request.operation === 'trading-core.task-result') return { reports: { 'r-1': {} } }
      throw new Error(`unexpected operation ${request.operation}`)
    })

    renderStrategyPage(requestData)
    const card = (await screen.findByText('可回测策略')).closest('article')
    expect(card).not.toBeNull()
    expect(screen.queryByLabelText('回测窗口')).toBeNull()
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy()

    const runInputs = () => requestData.mock.calls
      .filter(([request]) => request.operation === 'trading-core.strategy-run')
      .map(([request]) => request.input)
    // 打开回测管理（详情弹窗）→ 新建回测任务向导
    const openWizard = async () => {
      fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '回测管理' }))
      await screen.findByRole('dialog', { name: '可回测策略' })
      fireEvent.click(within(screen.getByRole('dialog', { name: '可回测策略' })).getByRole('button', { name: '新建回测任务' }))
      await screen.findByRole('dialog', { name: '新建回测任务' })
    }
    const awaitWizardClosed = () => waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建回测任务' })).toBeNull()
    })

    // 默认 2 年
    await openWizard()
    fireEvent.click(screen.getByRole('button', { name: '开始回测' }))
    await waitFor(() => {
      expect(runInputs()).toEqual([{ strategy_id: 's-1', lookback_years: 2, oos_frac: 0.3, min_oos_trades: 4 }])
    })
    await awaitWizardClosed()

    // 再次新建，切到 3 年再回测
    fireEvent.click(within(screen.getByRole('dialog', { name: '可回测策略' })).getByRole('button', { name: '新建回测任务' }))
    const wizard = await screen.findByRole('dialog', { name: '新建回测任务' })
    fireEvent.change(within(wizard).getByLabelText('回测时间窗口'), { target: { value: '3' } })
    fireEvent.click(within(wizard).getByRole('button', { name: '开始回测' }))
    await waitFor(() => {
      expect(runInputs()).toEqual([
        { strategy_id: 's-1', lookback_years: 2, oos_frac: 0.3, min_oos_trades: 4 },
        { strategy_id: 's-1', lookback_years: 3, oos_frac: 0.3, min_oos_trades: 4 },
      ])
    })
  })
})
