// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ManualTradePanel } from '../src/client/ManualTradePanel.tsx'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { SecuritySearchField } from '../src/client/SecuritySearchField.tsx'
import { FundsPrivacyProvider } from '../src/client/funds-privacy.tsx'

afterEach(cleanup)

function SearchFieldFixture(props: Omit<Parameters<typeof SecuritySearchField>[0], 'open' | 'onOpenChange'>) {
  const [open, setOpen] = useState(false)
  return <SecuritySearchField {...props} open={open} onOpenChange={setOpen} />
}

it('previews before committing and blocks duplicate saves', async () => {
  let finish: (value: unknown) => void = () => {}
  const requestData = vi.fn().mockResolvedValueOnce({ version: 'v1', entry: { before_quantity: 100, after_quantity: 200, after_cost_price: 12 } })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const onSaved = vi.fn()
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={onSaved} onBusy={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '14' } })
  fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认保存成交' }))
  fireEvent.click(screen.getByRole('button', { name: '确认保存成交' }))
  expect(requestData).toHaveBeenCalledTimes(2)
  expect(requestData.mock.calls[1]![0].input).toMatchObject({ action: 'commit', request_id: requestData.mock.calls[0]![0].input.request_id, version: 'v1' })
  finish({ saved: true, holdings: [{ ticker: '002518', quantity: 200, cost_price: 12 }] })
  await waitFor(() => { expect(onSaved).toHaveBeenCalledWith([{ ticker: '002518', quantity: 200, cost_price: 12 }], undefined) })
})

it('shows the actual holding result in the confirmation preview when funds are hidden', async () => {
  const key = 'investment-research.hide-sensitive-funds'
  const previous = window.localStorage.getItem(key)
  window.localStorage.setItem(key, 'hidden')
  try {
    const requestData = vi.fn().mockResolvedValue({ version: 'v1', entry: {
      before_quantity: 20, after_quantity: 120, after_cost_price: 36.712,
    } })
    render(<FundsPrivacyProvider><ManualTradePanel selection={{ side: 'buy', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} /></FundsPrivacyProvider>)
    fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '36.7' } })
    fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
    fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
    const preview = await screen.findByRole('status', { name: '成交记录预览' })
    expect(within(preview).getByText('20 → 120 股')).toBeTruthy()
    expect(within(preview).getByText('¥36.712')).toBeTruthy()
    expect(within(preview).queryByText('***')).toBeNull()
  } finally {
    if (previous === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, previous)
  }
})

it('preserves input on failure and invalidates preview on edit', async () => {
  const requestData = vi.fn().mockRejectedValueOnce(new Error('无法保存')).mockResolvedValueOnce({ version: 'v1', entry: {} })
  render(<ManualTradePanel selection={{ side: 'sell', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '12' } })
  fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('成交数量（股）')).toHaveProperty('value', '10')
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await screen.findByRole('button', { name: '确认保存成交' })
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '11' } })
  expect(screen.queryByRole('button', { name: '确认保存成交' })).toBeNull()
})

it('uses one explicit local trade time format across browsers and rejects impossible dates', async () => {
  const requestData = vi.fn().mockResolvedValue({ version: 'v1', entry: {} })
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  const time = screen.getByLabelText('成交时间') as HTMLInputElement
  expect(time.type).toBe('text')
  expect(time.value).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '14' } })
  fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
  fireEvent.change(time, { target: { value: '2026/02/30 09:25:00' } })
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  expect(screen.getByRole('alert').textContent).toContain('成交时间')
  expect(time.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByLabelText('成交数量（股）').getAttribute('aria-invalid')).not.toBe('true')
  expect(requestData).not.toHaveBeenCalled()
  fireEvent.change(time, { target: { value: '2026/09/16 09:25:00' } })
  fireEvent.click(screen.getByRole('button', { name: /选日期，当前 2026\.09\.16/ }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '选日期' })).getByRole('button', { name: '15' }))
  expect(time.value).toBe('2026/09/15 09:25:00')
  fireEvent.change(time, { target: { value: '2026/09/16 09:25:00' } })
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await waitFor(() => { expect(requestData).toHaveBeenCalledOnce() })
  expect(requestData.mock.calls[0]![0].input).toMatchObject({ traded_at: new Date(2026, 8, 16, 9, 25, 0).toISOString() })
})

it('accepts a one-digit hour and normalizes the user-entered trade time', async () => {
  const requestData = vi.fn().mockResolvedValue({ version: 'v1', entry: {} })
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  const time = screen.getByLabelText('成交时间') as HTMLInputElement
  fireEvent.change(time, { target: { value: '2026/09/16 9:25:00' } })
  fireEvent.blur(time)
  expect(time.value).toBe('2026/09/16 09:25:00')
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '36.7' } })
  fireEvent.change(screen.getByLabelText('费用（元）'), { target: { value: '1.2' } })
  fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await waitFor(() => expect(requestData).toHaveBeenCalledOnce())
  expect(requestData.mock.calls[0]![0].input).toMatchObject({ traded_at: new Date(2026, 8, 16, 9, 25).toISOString(), quantity: 100, price: 36.7, fees: 1.2 })
  expect(screen.queryByText('请检查成交时间、数量、价格和费用。')).toBeNull()
})

it('points to the invalid fields without flagging the valid ones', async () => {
  const requestData = vi.fn().mockResolvedValue({ version: 'v1', entry: {} })
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('费用（元）'), { target: { value: '-1' } })
  fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  expect(screen.getByLabelText('成交时间').getAttribute('aria-invalid')).not.toBe('true')
  expect(screen.getByLabelText('成交数量（股）').getAttribute('aria-invalid')).not.toBe('true')
  expect(screen.getByLabelText('成交价格（元）').getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByLabelText('费用（元）').getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByText('请输入大于 0 的成交价格。')).toBeTruthy()
  expect(screen.getByText('费用不能小于 0。')).toBeTruthy()
  expect(requestData).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '36.7' } })
  fireEvent.change(screen.getByLabelText('费用（元）'), { target: { value: '1.2' } })
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await waitFor(() => expect(requestData).toHaveBeenCalledOnce())
})

it('requires a holding choice and previews a history-only record without changing holdings', async () => {
  const requestData = vi.fn().mockResolvedValue({ version: 'v1', backdated: true, entry: {
    before_quantity: 200, after_quantity: 200, after_cost_price: 12,
  } })
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '14' } })
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  expect(screen.getByRole('alert').textContent).toContain('是否已计入当前持仓')
  expect(requestData).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: /已计入，只补成交记录/ }))
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await screen.findByText('只保存这笔成交记录，当前持仓和已有历史快照保持不变。')
  expect(requestData.mock.calls[0]![0].input).toMatchObject({ affects_holdings: false })
  fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
  expect(screen.queryByText('只保存这笔成交记录，当前持仓和已有历史快照保持不变。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await screen.findByText(/系统会调整当前持仓，不会倒推重算已有历史快照/)
  expect(requestData.mock.calls[1]![0].input).toMatchObject({ affects_holdings: true })
})

it('reports a history-only save without claiming current holdings changed', async () => {
  const requestData = vi.fn()
    .mockResolvedValueOnce({ version: 'v1', entry: { before_quantity: 0, after_quantity: 0, after_cost_price: null } })
    .mockResolvedValueOnce({ saved: true, holdings: [] })
  const onSaved = vi.fn()
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={onSaved} onBusy={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '36.7' } })
  fireEvent.click(screen.getByRole('radio', { name: /已计入，只补成交记录/ }))
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认保存成交' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith([], '成交记录已保存，当前持仓未改变。'))
})

it('loads persisted history after a position closes', async () => {
  const requestData = vi.fn().mockResolvedValue({ entries: [
    { ticker: '002518', side: 'sell', quantity: 100, price: 12, source: 'manual', traded_at: '2026-09-17T10:00:00+08:00', affects_holdings: false },
    { ticker: '600519', side: 'buy', quantity: 10, price: 1000, source: 'broker', traded_at: '2026-09-16T09:25:00' },
  ] })
  render(<ManualTradePanel selection={{ side: 'history', ticker: '' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  await screen.findByText('002518')
  expect(screen.getByText('手工录入')).toBeTruthy()
  expect(screen.getByText('仅补记录')).toBeTruthy()
  expect(screen.getByText('随券商同步')).toBeTruthy()
  const local = new Date('2026-09-17T10:00:00+08:00')
  const expected = `${local.getFullYear()}/${String(local.getMonth() + 1).padStart(2, '0')}/${String(local.getDate()).padStart(2, '0')} ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}:${String(local.getSeconds()).padStart(2, '0')}`
  expect(screen.getByText(expected)).toBeTruthy()
  expect(screen.getByText('2026/09/16 09:25:00')).toBeTruthy()
})


it('offers a clear next step from empty history', async () => {
  const onRecordBuy = vi.fn()
  render(<ManualTradePanel selection={{ side: 'history', ticker: '' }} requestData={vi.fn().mockResolvedValue({ entries: [] })} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} onRecordBuy={onRecordBuy} />)
  await screen.findByText('还没有成交记录')
  fireEvent.click(screen.getByRole('button', { name: '记录一笔买入' }))
  expect(onRecordBuy).toHaveBeenCalledOnce()
})

it('按证券名称搜索并键盘选择，预览只提交选中代码；改字后不会沿用旧标的', async () => {
  const requestData = vi.fn(async (request: InvestmentDataRequest) => request.operation === 'market-watch.security-search'
    ? { items: [{ name: '科士达', code: '002518', market: '深市' }] }
    : { version: 'v1', entry: {} })
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  const search = screen.getByRole('combobox', { name: '证券名称或代码' })
  fireEvent.change(search, { target: { value: '科士达' } })
  await screen.findByRole('option', { name: /科士达.*002518/ })
  expect(requestData).toHaveBeenCalledWith({ operation: 'market-watch.security-search', input: { query: '科士达', limit: 8 } })
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(search).toHaveProperty('value', '科士达 002518')
  expect(requestData.mock.calls.some(([request]) => request.operation === 'trading-core.holdings-trade')).toBe(false)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '14' } })
  fireEvent.click(screen.getByRole('radio', { name: /未计入，更新当前持仓/ }))
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  await screen.findByRole('button', { name: '确认保存成交' })
  expect(requestData).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'trading-core.holdings-trade', input: expect.objectContaining({ ticker: '002518' }) }))
  fireEvent.change(search, { target: { value: '茅台' } })
  expect(screen.queryByRole('button', { name: '确认保存成交' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '预览记录结果' }))
  expect(screen.getByRole('alert').textContent).toContain('选择证券')
  expect(requestData.mock.calls.filter(([request]) => request.operation === 'trading-core.holdings-trade')).toHaveLength(1)
})

it('旧查询的晚到结果不会覆盖新查询，加载时 Enter 不选旧证券', async () => {
  let finishOld: (value: unknown) => void = () => {}
  const requestData = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValue({ items: [{ name: '贵州茅台', code: '600519', market: '沪市' }] })
  const onSelect = vi.fn()
  render(<SearchFieldFixture disabled={false} requestData={requestData} onSelect={onSelect} />)
  const search = screen.getByRole('combobox')
  fireEvent.change(search, { target: { value: '科士达' } })
  await waitFor(() => { expect(requestData).toHaveBeenCalledTimes(1) })
  fireEvent.change(search, { target: { value: '600519' } })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(onSelect).not.toHaveBeenCalledWith(expect.objectContaining({ code: '002518' }))
  await screen.findByRole('option', { name: /贵州茅台/ })
  await act(async () => { finishOld({ items: [{ name: '科士达', code: '002518' }] }) })
  expect(screen.queryByRole('option', { name: /科士达/ })).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: /贵州茅台/ }))
  expect(onSelect).toHaveBeenLastCalledWith({ name: '贵州茅台', code: '600519', market: '沪市' })
})

it('搜索出错可原位重试；无匹配时可改词，中文输入法确认不误选', async () => {
  const requestData = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [] })
    .mockResolvedValue({ items: [{ name: '科士达', code: '002518' }] })
  const onSelect = vi.fn()
  render(<SearchFieldFixture disabled={false} requestData={requestData} onSelect={onSelect} />)
  const search = screen.getByRole('combobox')
  fireEvent.change(search, { target: { value: '科士' } })
  fireEvent.click(await screen.findByRole('button', { name: '重试搜索' }))
  await screen.findByText('未找到匹配证券，请尝试其他名称或代码。')
  expect(search).toHaveProperty('value', '科士')
  fireEvent.change(search, { target: { value: '科士达' } })
  await screen.findByRole('option', { name: /科士达/ })
  fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
  expect(onSelect).not.toHaveBeenCalledWith(expect.objectContaining({ code: '002518' }))
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ code: '002518' }))
})


it('搜索浮层失焦和点击外部收起；Esc 先收起搜索，再关闭成交子窗口', async () => {
  const requestData = vi.fn().mockResolvedValue({ items: [{ name: '科士达', code: '002518' }] })
  const onClose = vi.fn()
  render(<ManualTradePanel selection={{ side: 'buy', ticker: '' }} requestData={requestData} onClose={onClose} onSaved={vi.fn()} onBusy={vi.fn()} />)
  const search = screen.getByRole('combobox', { name: '证券名称或代码' })
  fireEvent.change(search, { target: { value: '科士达' } })
  await screen.findByRole('listbox')
  fireEvent.keyDown(search, { key: 'Tab' })
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.focus(search)
  await screen.findByRole('listbox')
  fireEvent.blur(search, { relatedTarget: screen.getByLabelText('成交数量（股）') })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(search.getAttribute('aria-expanded')).toBe('false')
  fireEvent.focus(search)
  await screen.findByRole('listbox')
  fireEvent.pointerDown(screen.getByLabelText('成交价格（元）'))
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  await screen.findByRole('listbox')
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '记录买入' })).toBeTruthy()
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})
