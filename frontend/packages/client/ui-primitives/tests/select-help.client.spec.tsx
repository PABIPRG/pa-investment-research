// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { Select } from '../src/Select.tsx'
import { HelpPopover } from '../src/HelpPopover.tsx'
import { DatePicker } from '../src/DatePicker.tsx'
import { Modal } from '../src/Modal.tsx'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('可选悬停说明支持焦点、移入正文、点击固定及 Escape 关闭', () => {
  const view = render(<HelpPopover label="收益说明" openOnHover>估算收益，不含现金。</HelpPopover>)
  const trigger = view.getByRole('button', { name: '收益说明' })
  fireEvent.mouseEnter(trigger)
  expect(view.getByRole('tooltip').textContent).toContain('不含现金')
  fireEvent.click(trigger)
  fireEvent.blur(trigger, { relatedTarget: null })
  fireEvent.mouseLeave(trigger)
  expect(view.getByRole('tooltip')).toBeTruthy()
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(view.queryByRole('tooltip')).toBeNull()
  fireEvent.blur(trigger, { relatedTarget: document.body })
  fireEvent.focus(trigger)
  expect(view.getByRole('tooltip')).toBeTruthy()
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(view.queryByRole('tooltip')).toBeNull()
})

it('悬停说明允许移入正文，离开触发点和正文后延时关闭', () => {
  vi.useFakeTimers()
  const view = render(<HelpPopover label="收益说明" openOnHover>说明正文</HelpPopover>)
  const trigger = view.getByRole('button', { name: '收益说明' })
  fireEvent.mouseEnter(trigger)
  const popup = view.getByRole('tooltip')
  fireEvent.mouseLeave(trigger)
  fireEvent.mouseEnter(popup)
  act(() => { vi.advanceTimersByTime(250) })
  expect(view.getByRole('tooltip')).toBeTruthy()
  fireEvent.mouseLeave(popup)
  act(() => { vi.advanceTimersByTime(250) })
  expect(view.queryByRole('tooltip')).toBeNull()
})

it('选择器保持空值和不透明值，方向键跳过禁用项，Esc 只关闭选择器', () => {
  const close = vi.fn()
  function View() {
    const [value, setValue] = useState('')
    return <Modal open title="设置" onClose={close} onEscapeKeyDown={(event) => { event.stopPropagation() }}><Select aria-label="模型" value={value} onValueChange={setValue} options={[
      { value: '', label: '未指定' }, { value: 'disabled', label: '不可用', disabled: true }, { value: 'provider\u0000model', label: '模型甲' },
    ]} /></Modal>
  }
  const view = render(<View />)
  const trigger = view.getByRole('combobox', { name: '模型' })
  expect(trigger.textContent).toBe('未指定')
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const list = view.getByRole('listbox', { name: '模型' })
  fireEvent.keyDown(within(list).getByRole('option', { name: '未指定' }), { key: 'ArrowDown' })
  expect(document.activeElement).toBe(within(list).getByRole('option', { name: '模型甲' }))
  fireEvent.click(document.activeElement as HTMLElement)
  expect(trigger.textContent).toBe('模型甲')
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.keyDown(view.getByRole('option', { name: '模型甲' }), { key: 'Escape' })
  expect(view.queryByRole('listbox')).toBeNull()
  expect(close).not.toHaveBeenCalled()
})

it('禁用选择器不能打开，选项更新不伪造默认值', () => {
  const change = vi.fn()
  const view = render(<Select aria-label="筛选" value="missing" options={[{ value: 'a', label: '甲' }]} onValueChange={change} placeholder="待选择" disabled />)
  fireEvent.click(view.getByRole('combobox'))
  expect(view.queryByRole('listbox')).toBeNull()
  expect(view.getByRole('combobox').textContent).toBe('待选择')
  expect(change).not.toHaveBeenCalled()
})

it('说明只打开锚定提示，支持触屏点击和 Esc，不增加模态层', () => {
  const close = vi.fn()
  const view = render(<Modal open title="持仓明细" onClose={close}><HelpPopover label="收益说明">收益计算说明。</HelpPopover></Modal>)
  const trigger = view.getByRole('button', { name: '收益说明' })
  fireEvent.click(trigger)
  expect(view.getByRole('tooltip').textContent).toContain('收益计算说明。')
  expect(view.getAllByRole('dialog')).toHaveLength(1)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(view.queryByRole('tooltip')).toBeNull()
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  fireEvent.pointerDown(view.getByRole('heading', { name: '持仓明细' }))
  expect(view.queryByRole('tooltip')).toBeNull()
})

it('空列表禁用，Home/End 和搜索聚焦可见选项，更新选项后恢复有效焦点', () => {
  const change = vi.fn()
  const view = render(<Select aria-label="模型" value="a" options={[]} onValueChange={change} />)
  expect((view.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true)
  const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Charlie' }]
  view.rerender(<Select aria-label="模型" value="a" options={options} onValueChange={change} />)
  fireEvent.keyDown(view.getByRole('combobox'), { key: 'End' })
  expect(document.activeElement?.textContent).toBe('Charlie')
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'b' })
  expect(document.activeElement?.textContent).toBe('Beta')
  view.rerender(<Select aria-label="模型" value="a" options={options.slice(0, 1)} onValueChange={change} />)
  expect(document.activeElement?.textContent).toBe('Alpha')
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
  expect(view.queryByRole('listbox')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

it('说明正文保留 portal 内的焦点，Escape 返回图标而不关闭父框', () => {
  const close = vi.fn()
  const view = render(<Modal open title="持仓" onClose={close}><HelpPopover label="详情说明"><a href="#details">阅读说明</a></HelpPopover></Modal>)
  const trigger = view.getByRole('button', { name: '详情说明' })
  fireEvent.click(trigger)
  const link = view.getByRole('link', { name: '阅读说明' })
  fireEvent.blur(trigger, { relatedTarget: link })
  expect(view.getByRole('tooltip')).toBeTruthy()
  fireEvent.keyDown(link, { key: 'Escape' })
  expect(view.queryByRole('tooltip')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(close).not.toHaveBeenCalled()
})

it('日期选择器共享可用日期集合，且不改变未提供集合的调用方', () => {
  const change = vi.fn()
  const view = render(<DatePicker value="2026-09-28" availableDates={['2026-09-25', '2026-09-28']} onChange={change} />)
  fireEvent.click(view.getByRole('button', { name: /选择日期，当前/ }))
  expect((view.getByRole('button', { name: '27', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: '25', exact: true }))
  expect(change).toHaveBeenCalledWith('2026-09-25')
  view.rerender(<DatePicker value="2026-09-28" min="2026-09-20" max="2026-09-30" onChange={change} />)
  fireEvent.click(view.getByRole('button', { name: /选择日期，当前/ }))
  expect((view.getByRole('button', { name: '27', exact: true }) as HTMLButtonElement).disabled).toBe(false)
})
