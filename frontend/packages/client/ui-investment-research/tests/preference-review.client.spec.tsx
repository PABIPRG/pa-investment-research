// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { PreferenceReviewPage } from '../src/client/PreferenceReviewPage.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function review(days: number, enabled = true, enough = true): unknown {
  return {
    window_days: days,
    rule_version: 'local-preference-v1',
    snapshot_id: `snapshot-${days}`,
    status: { enabled, retention_days: 90, event_count: 8, feedback_count: 2 },
    enough_data: enough,
    data_note: enough ? null : '数据不足，继续正常使用即可；至少需要跨 2 天的 3 个有效信号。',
    overview: {
      signal_count: enough ? 8 : 1, active_days: enough ? 3 : 1,
      opens: enough ? 5 : 1, analyses: enough ? 2 : 0,
      feedback: enough ? 1 : 0, confidence: enough ? '中' : '数据不足',
    },
    funnel: {
      impressions: enough ? 12 : 1, opens: enough ? 5 : 1,
      analyses: enough ? 2 : 0, feedback: enough ? 1 : 0,
      open_rate: enough ? 0.417 : null, analysis_rate: enough ? 0.4 : null,
    },
    insights: enough ? [{
      id: 'security:600519.SH', title: '近期更常研究证券 600519.SH', confidence: '中',
      explanation: `近 ${days} 天的打开、带入分析和显式反馈按固定规则聚合。`,
      evidence_count: 6, active_days: 3,
      safety_note: '仅表示研究兴趣，不改变风险承受能力或投资适当性。',
    }] : [],
    recent_activity: enough ? [{
      occurred_at: '2026-08-27T10:00:00Z', label: '打开证券 600519.SH',
    }] : [],
    explicit_risk_profile: {
      key: 'balanced', label: '稳健型', behavior_adjustment: 0,
      note: '风险承受能力来自显式设置，本地行为不会修改该值。',
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

describe('偏好复盘', () => {
  it('支持由研究工作台提供返回文案与动作', async () => {
    const onBack = vi.fn()
    render(
      <PreferenceReviewPage
        requestData={async () => review(7)}
        onBack={onBack}
        backLabel="← 返回研究工作台"
        trackTelemetry={async () => {}}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '← 返回研究工作台' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('展示证据、漏斗和独立显式风险，并切换 7/30 天窗口', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      const days = Number(request.input?.days ?? 7)
      return review(days)
    })
    const trackTelemetry = vi.fn(async () => {})
    render(
      <PreferenceReviewPage requestData={requestData} onBack={() => {}} trackTelemetry={trackTelemetry} />,
    )

    expect(await screen.findByText('近期更常研究证券 600519.SH')).toBeTruthy()
    expect(screen.getByText('仅表示研究兴趣，不改变风险承受能力或投资适当性。')).toBeTruthy()
    expect(screen.getByText('稳健型')).toBeTruthy()
    expect(screen.getByText('行为调整值：0')).toBeTruthy()
    expect(screen.getByText('41.7%')).toBeTruthy()
    expect(trackTelemetry).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'preference-review' }))

    fireEvent.click(screen.getByRole('button', { name: '近 30 天' }))
    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.local-learning-review', input: { days: 30 },
      })
    })
    expect(await screen.findByText('近 30 天的打开、带入分析和显式反馈按固定规则聚合。')).toBeTruthy()
  })

  it('区分小样本，隐藏误导性比例和洞察', async () => {
    const requestData = vi.fn(async () => review(7, true, false))
    render(
      <PreferenceReviewPage requestData={requestData} onBack={() => {}} trackTelemetry={async () => {}} />,
    )

    expect(await screen.findByText('数据不足，暂不下结论')).toBeTruthy()
    expect(screen.getByText(/至少需要跨 2 天/)).toBeTruthy()
    expect(screen.getAllByText('样本不足')).toHaveLength(2)
    expect(screen.queryByText(/近期更常研究证券/)).toBeNull()
  })

  it('对缺失聚合字段使用安全默认值，并容忍无效活动时间', async () => {
    const sparse = {
      window_days: 7,
      status: { enabled: false },
      enough_data: true,
      overview: {},
      funnel: {},
      insights: [{}],
      recent_activity: [
        { occurred_at: '', label: '' },
        { occurred_at: 'not-a-date' },
      ],
      explicit_risk_profile: {},
    }
    render(
      <PreferenceReviewPage requestData={async () => sparse} onBack={() => {}} trackTelemetry={async () => {}} />,
    )

    expect(await screen.findByText('研究兴趣')).toBeTruthy()
    expect(screen.getByText('恢复本地学习')).toBeTruthy()
    expect(screen.getByText('稳健型')).toBeTruthy()
    expect(screen.getByText('风险承受能力来自显式设置。')).toBeTruthy()
    expect(screen.getByText('时间未知')).toBeTruthy()
    expect(screen.getByText('not-a-date')).toBeTruthy()
    expect(screen.getAllByText('样本不足')).toHaveLength(2)
    expect(screen.getAllByText('0').length).toBeGreaterThan(1)
  })

  it('忽略时间窗切换后才返回的成功和失败响应，并支持手动刷新', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const third = deferred<unknown>()
    const fourth = deferred<unknown>()
    const queue = [first, second, third, fourth]
    const requestData = vi.fn(async () => queue.shift()!.promise)
    render(
      <PreferenceReviewPage requestData={requestData} onBack={() => {}} trackTelemetry={async () => {}} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '近 30 天' }))
    first.resolve(review(7))
    second.resolve(review(30))
    expect(await screen.findByText('近 30 天的打开、带入分析和显式反馈按固定规则聚合。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }))
    fireEvent.click(screen.getByRole('button', { name: '近 30 天' }))
    third.reject(new Error('stale failure'))
    fourth.resolve(review(30))
    await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(4) })
    expect(screen.queryByText('偏好复盘暂不可用')).toBeNull()

    const refresh = deferred<unknown>()
    queue.push(refresh)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(screen.getByRole('button', { name: '更新中…' })).toBeTruthy()
    refresh.resolve(review(30))
    expect(await screen.findByRole('button', { name: '刷新' })).toBeTruthy()
  })

  it('支持暂停、恢复和二次确认清空，并保留明确结果说明', async () => {
    let enabled = true
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.local-learning-settings') {
        enabled = request.input?.enabled === true
        return { enabled }
      }
      if (request.operation === 'trading-core.local-learning-clear') return { deleted_total: 12 }
      return review(7, enabled, false)
    })
    render(
      <PreferenceReviewPage requestData={requestData} onBack={() => {}} trackTelemetry={async () => {}} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '暂停本地学习' }))
    expect(await screen.findByText('本地学习已暂停；浏览和研究功能不受影响。')).toBeTruthy()
    expect(await screen.findByText('已暂停')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复本地学习' }))
    expect(await screen.findByText('本地学习已恢复。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '清空本地记录' }))
    const confirmation = screen.getByRole('alert')
    expect(within(confirmation).getByText(/持仓、风险资料和研究成果不会被删除/)).toBeTruthy()
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }))
    expect(screen.queryByText(/确认清空全部本地行为/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '清空本地记录' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }))
    expect(await screen.findByText('本地学习记录已清空；持仓、风险资料和研究成果均已保留。')).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.local-learning-clear', input: { confirm: true },
    })
  })

  it('清空进行中禁用控制并显示真实进度', async () => {
    const pendingClear = deferred<unknown>()
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.local-learning-clear') return pendingClear.promise
      return review(7)
    })
    render(
      <PreferenceReviewPage requestData={requestData} onBack={() => {}} trackTelemetry={async () => {}} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '清空本地记录' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }))
    expect(screen.getByRole('button', { name: '正在清空…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true)
    pendingClear.resolve({ deleted_total: 1 })
    expect(await screen.findByText(/本地学习记录已清空/)).toBeTruthy()
  })

  it('控制失败可见但不破坏复盘，并允许加载失败后重试', async () => {
    let reviewAttempts = 0
    const requestData = vi.fn(async (request: InvestmentDataRequest) => {
      if (request.operation === 'trading-core.local-learning-review') {
        reviewAttempts += 1
        if (reviewAttempts === 1) throw new Error('offline')
        return review(7)
      }
      throw new Error('write failed')
    })
    render(
      <PreferenceReviewPage requestData={requestData} onBack={() => {}} trackTelemetry={async () => {}} />,
    )

    expect(await screen.findByText('偏好复盘暂不可用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('近期更常研究证券 600519.SH')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '暂停本地学习' }))
    expect(await screen.findByText(/设置未保存/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清空本地记录' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }))
    expect(await screen.findByText(/清空失败/)).toBeTruthy()
  })

  it('可导出安全聚合摘要并返回我的投研', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:summary')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const onBack = vi.fn()
    render(
      <PreferenceReviewPage
        requestData={async () => review(7)} onBack={onBack} trackTelemetry={async () => {}}
      />,
    )
    await screen.findByText('近期更常研究证券 600519.SH')

    fireEvent.click(screen.getByRole('button', { name: '导出摘要' }))
    expect(createUrl).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledWith('blob:summary')
    expect(screen.getByText(/文件不包含搜索词/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '← 返回我的投研' }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})
