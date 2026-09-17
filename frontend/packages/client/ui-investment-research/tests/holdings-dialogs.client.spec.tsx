// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { WorkbenchOverviewDialog } from '../src/client/WorkbenchOverviewDialog.tsx'

afterEach(cleanup)

function renderHoldings(initialHoldingsFlow: 'view' | 'sync' = 'view', missing = false, onSaveHoldings = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn()
  const requestData = vi.fn(async () => ({ provider: 'mac_ths', available: !missing, blocking_reason: missing ? 'client_missing' : '', entries: [] }))
  render(<WorkbenchOverviewDialog kind="holdings" initialHoldingsFlow={initialHoldingsFlow}
    positions={[{ code: '002518', name: '科士达', quantity: 100, costPrice: 30, currentPrice: 32 }]}
    risk={{}} alerts={[]} riskAsOf={undefined} alertsAsOf={undefined} alertsDegraded={undefined} alertsDegradedReason={undefined}
    holdingsState={{ loaded: true, busy: false, error: '' }} riskState={{ loaded: true, busy: false, error: '' }} alertsState={{ loaded: true, busy: false, error: '' }}
    onOpenAlert={vi.fn()} onSaveHoldings={onSaveHoldings} onSyncHoldings={vi.fn()} requestData={requestData} onClose={onClose} />)
  return { onClose }
}

it.each([
  ['记录买入', '记录买入'], ['卖出', '记录卖出'], ['全部成交记录', '成交记录'],
  ['导入持仓', '导入持仓'], ['从券商同步持仓', '同步同花顺持仓'],
])('%s 在独立子框打开，底部关闭保留父持仓并还原焦点', async (triggerName, title) => {
  const { onClose } = renderHoldings()
  const parent = screen.getByRole('dialog', { name: '持仓明细' })
  const trigger = within(parent).getAllByRole('button', { name: triggerName, exact: true })[0]!
  trigger.focus()
  fireEvent.click(trigger)
  const child = await screen.findByRole('dialog', { name: title, exact: true })
  expect(child).not.toBe(parent)
  expect(parent.isConnected).toBe(true)
  expect(within(child).queryByRole('button', { name: /返回持仓/ })).toBeNull()
  const close = within(child).getByRole('button', { name: '关闭', exact: true })
  expect(close.closest('footer')).not.toBeNull()
  fireEvent.click(close)
  await waitFor(() => { expect(child.isConnected).toBe(false) })
  expect(screen.getByRole('dialog', { name: '持仓明细' })).toBe(parent)
  expect(onClose).not.toHaveBeenCalled()
  await waitFor(() => { expect(document.activeElement).toBe(trigger) })
})

it('在原行编辑数量和成本，取消不写入持仓', () => {
  const save = vi.fn().mockResolvedValue(undefined)
  renderHoldings('view', false, save)
  const row = screen.getByRole('rowheader', { name: /科士达/ }).closest('tr')!
  expect(within(row).getAllByRole('button').map(button => button.textContent)).toEqual(['设置', '买入', '卖出', '历史', '编辑', '删除'])
  fireEvent.click(within(row).getByRole('button', { name: '编辑 科士达 002518' }))
  const amount = within(row).getByRole('spinbutton', { name: '持仓数量' })
  expect(document.activeElement).toBe(amount)
  expect(amount).toHaveProperty('value', '100')
  fireEvent.change(amount, { target: { value: '120' } })
  fireEvent.change(within(row).getByRole('spinbutton', { name: '成本价' }), { target: { value: '29' } })
  fireEvent.click(within(row).getByRole('button', { name: '取消编辑' }))
  expect(document.activeElement).toBe(within(row).getByRole('button', { name: '编辑 科士达 002518' }))
  expect(within(row).queryByRole('spinbutton')).toBeNull()
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(within(row).getByRole('button', { name: '编辑 科士达 002518' }))
  expect(within(row).getByRole('spinbutton', { name: '持仓数量' })).toHaveProperty('value', '100')
})

it('行内保存失败保留草稿，重试成功后恢复当前行', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('保存失败，请重试')).mockResolvedValue(undefined)
  renderHoldings('view', false, save)
  const row = screen.getByRole('rowheader', { name: /科士达/ }).closest('tr')!
  fireEvent.click(within(row).getByRole('button', { name: '编辑 科士达 002518' }))
  fireEvent.change(within(row).getByRole('spinbutton', { name: '持仓数量' }), { target: { value: '120' } })
  fireEvent.click(within(row).getByRole('button', { name: '保存持仓' }))
  await screen.findByText('保存失败，请重试')
  expect(within(row).getByRole('spinbutton', { name: '持仓数量' })).toHaveProperty('value', '120')
  fireEvent.click(within(row).getByRole('button', { name: '保存持仓' }))
  await waitFor(() => { expect(within(row).queryByRole('spinbutton')).toBeNull() })
  expect(save).toHaveBeenLastCalledWith([{ ticker: '002518', quantity: 120, cost_price: 30 }], 'manual')
  expect(screen.getByRole('dialog', { name: '持仓明细' })).toBeTruthy()
})

it('Esc 只关闭最上层，第二次才关闭持仓父框', async () => {
  const { onClose } = renderHoldings()
  fireEvent.click(screen.getByRole('button', { name: '全部成交记录' }))
  await screen.findByRole('dialog', { name: '成交记录' })
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: '成交记录' })).toBeNull() })
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '持仓明细' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

it('通知初次直达同步时，Esc 也只关闭同步子框', async () => {
  const { onClose } = renderHoldings('sync')
  await screen.findByRole('dialog', { name: '同步同花顺持仓' })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: '持仓明细' })).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: '同步同花顺持仓' })).toBeNull()
  expect(onClose).not.toHaveBeenCalled()
})

it('从空历史切换买入后关闭，焦点回到原持仓入口', async () => {
  renderHoldings()
  const trigger = screen.getByRole('button', { name: '全部成交记录' })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('button', { name: '记录一笔买入' }))
  const buy = screen.getByRole('dialog', { name: '记录买入' })
  fireEvent.click(within(buy).getByRole('button', { name: '关闭', exact: true }))
  await waitFor(() => { expect(document.activeElement).toBe(trigger) })
})

it('同步改用导入后关闭，焦点回到原同步入口', async () => {
  renderHoldings('view', true)
  const trigger = screen.getByRole('button', { name: '从券商同步持仓' })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('button', { name: '暂不安装，改用手动录入' }))
  const child = screen.getByRole('dialog', { name: '导入持仓' })
  fireEvent.click(within(child).getByRole('button', { name: '关闭', exact: true }))
  await waitFor(() => { expect(document.activeElement).toBe(trigger) })
})
