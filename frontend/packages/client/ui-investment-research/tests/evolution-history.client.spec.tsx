// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolutionHistory } from '../src/client/EvolutionHistory.tsx'

afterEach(cleanup)
const row = (id: string, type = 'promote') => ({ action_id: id, round_id: 'round', applied_at: '2026-09-09 15:36:00', action: { sid: id, type, parent: type === 'mutate' ? 'parent' : undefined, from: 'tier1', to: 'tier2', params: { n: 10 }, reason: '当时的依据' } })
const strategies = [{ id: 'one', name: '策略甲', kind: 'bollinger' }, { id: 'parent', name: '原策略', kind: 'bollinger' }]

describe('历史动作分页与详情', () => {
  it('合并跨页轮次，保留历史变化，并能从原策略返回动作', async () => {
    const requestData = vi.fn(async ({ operation, input }) => {
      if (operation === 'trading-core.strategy-detail') return { id: input.strategy_id, name: '策略', status: 'watch', params: { n: 99 } }
      return input.cursor ? { items: [row('two', 'mutate')], next_cursor: null, total: 2 } : { items: [row('one')], next_cursor: 'next', total: 2 }
    })
    render(<EvolutionHistory requestData={requestData} strategies={strategies} securityNames={{}} refreshKey={1} onOpenStrategy={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '继续加载较早动作' }))
    fireEvent.click(await screen.findByRole('button', { name: /新方案待验证/ }))
    const dialog = screen.getByRole('dialog', { name: '进化动作详情' })
    expect(within(dialog).getByText('未记录')).toBeTruthy()
    expect(within(dialog).queryByText('99')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: /原策略.*↗/ }))
    expect(await screen.findByText('99')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '← 返回本次动作' }))
    expect(await screen.findByText('当时的依据')).toBeTruthy()
    expect(screen.getAllByText('2026-09-09 15:36:00（服务本地时间）')).toHaveLength(1)
  })
  it('查看策略详情关闭侧栏并跳转到对应完整策略', async () => {
    const onOpenStrategy = vi.fn()
    const requestData = vi.fn(async ({ operation }) => operation === 'trading-core.strategy-detail' ? strategies[0] : { items: [row('one')], next_cursor: null, total: 1 })
    render(<EvolutionHistory requestData={requestData} strategies={strategies} securityNames={{}} refreshKey={1} onOpenStrategy={onOpenStrategy} />)
    fireEvent.click(await screen.findByRole('button', { name: /模拟表现达标.*策略甲/ }))
    fireEvent.click(screen.getByRole('button', { name: '查看策略详情' }))
    expect(onOpenStrategy).toHaveBeenCalledWith('one')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('分页冲突保留旧记录，刷新使用首屏请求', async () => {
    const requestData = vi.fn(async ({ input }) => {
      if (input.cursor) throw new Error('HTTP 409')
      return { items: [row('one')], next_cursor: 'next', total: 2 }
    })
    render(<EvolutionHistory requestData={requestData} strategies={strategies} securityNames={{}} refreshKey={1} onOpenStrategy={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '继续加载较早动作' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: /模拟表现达标.*策略甲/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新历史' }))
    await screen.findByRole('button', { name: '继续加载较早动作' })
    expect(requestData.mock.calls.at(-1)?.[0].input).toEqual({ limit: 20 })
  })
})
