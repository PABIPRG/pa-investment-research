// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ManualTradePanel } from '../src/client/ManualTradePanel.tsx'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { SecuritySearchField } from '../src/client/SecuritySearchField.tsx'

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
  fireEvent.click(screen.getByRole('button', { name: '预览持仓变化' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认保存成交' }))
  fireEvent.click(screen.getByRole('button', { name: '确认保存成交' }))
  expect(requestData).toHaveBeenCalledTimes(2)
  expect(requestData.mock.calls[1]![0].input).toMatchObject({ action: 'commit', request_id: requestData.mock.calls[0]![0].input.request_id, version: 'v1' })
  finish({ saved: true, holdings: [{ ticker: '002518', quantity: 200, cost_price: 12 }] })
  await waitFor(() => { expect(onSaved).toHaveBeenCalledWith([{ ticker: '002518', quantity: 200, cost_price: 12 }], undefined) })
})

it('preserves input on failure and invalidates preview on edit', async () => {
  const requestData = vi.fn().mockRejectedValueOnce(new Error('无法保存')).mockResolvedValueOnce({ version: 'v1', entry: {} })
  render(<ManualTradePanel selection={{ side: 'sell', ticker: '002518' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('成交价格（元）'), { target: { value: '12' } })
  fireEvent.click(screen.getByRole('button', { name: '预览持仓变化' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('成交数量（股）')).toHaveProperty('value', '10')
  fireEvent.click(screen.getByRole('button', { name: '预览持仓变化' }))
  await screen.findByRole('button', { name: '确认保存成交' })
  fireEvent.change(screen.getByLabelText('成交数量（股）'), { target: { value: '11' } })
  expect(screen.queryByRole('button', { name: '确认保存成交' })).toBeNull()
})

it('loads persisted history after a position closes', async () => {
  const requestData = vi.fn().mockResolvedValue({ entries: [{ ticker: '002518', side: 'sell', quantity: 100, price: 12, source: 'manual', traded_at: '2026-09-17T10:00:00+08:00' }] })
  render(<ManualTradePanel selection={{ side: 'history', ticker: '' }} requestData={requestData} onClose={vi.fn()} onSaved={vi.fn()} onBusy={vi.fn()} />)
  await screen.findByText('002518')
  expect(screen.getByText('手工录入')).toBeTruthy()
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
  fireEvent.click(screen.getByRole('button', { name: '预览持仓变化' }))
  await screen.findByRole('button', { name: '确认保存成交' })
  expect(requestData).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'trading-core.holdings-trade', input: expect.objectContaining({ ticker: '002518' }) }))
  fireEvent.change(search, { target: { value: '茅台' } })
  expect(screen.queryByRole('button', { name: '确认保存成交' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '预览持仓变化' }))
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
