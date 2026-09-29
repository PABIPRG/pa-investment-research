import { expect, it } from 'vitest'
import { marketStatus } from '../src/marketStatus.ts'

const shanghaiTime = (time: string) => new Date(`2026-09-29T${time}:00+08:00`)

it('shows a neutral closed state after the trading session ends', () => {
  expect(marketStatus(shanghaiTime('15:00'), 'trading', true)).toEqual({ label: '已收盘', active: false })
  expect(marketStatus(shanghaiTime('18:30'), 'trading', true)).toEqual({ label: '已收盘', active: false })
})

it('only marks confirmed active trading periods green', () => {
  expect(marketStatus(shanghaiTime('10:00'), 'trading', true)).toEqual({ label: '交易中', active: true })
  expect(marketStatus(shanghaiTime('12:00'), 'trading', true)).toEqual({ label: '午间休市', active: false })
  expect(marketStatus(shanghaiTime('10:00'), 'closed', true)).toEqual({ label: '休市', active: false })
  expect(marketStatus(shanghaiTime('10:00'), 'unknown', true)).toEqual({ label: '交易状态待确认', active: false })
  expect(marketStatus(shanghaiTime('18:30'), undefined, true)).toEqual({ label: '非交易时段', active: false })
  expect(marketStatus(shanghaiTime('10:00'), 'trading', false)).toEqual({ label: '历史日期', active: false })
})
