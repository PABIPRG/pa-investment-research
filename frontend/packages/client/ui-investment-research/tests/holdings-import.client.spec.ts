import { describe, expect, it } from 'vitest'
import { parseHoldingsImport } from '../src/client/holdings-import.ts'

describe('holdings import parser', () => {
  it('parses Chinese CSV headers and normalizes A-share codes', () => {
    expect(parseHoldingsImport([
      '股票代码,数量,成本价',
      '600519.SH,100,1500.5',
      '858,200,135',
    ].join('\n'))).toEqual({
      items: [
        { ticker: '600519', quantity: 100, cost_price: 1500.5 },
        { ticker: '000858', quantity: 200, cost_price: 135 },
      ],
      errors: [],
    })
  })

  it('accepts copied table rows with a stock name column', () => {
    expect(parseHoldingsImport([
      '600519\t贵州茅台\t100\t1500',
      '000858\t五粮液\t200\t135',
    ].join('\n')).items).toEqual([
      { ticker: '600519', quantity: 100, cost_price: 1500 },
      { ticker: '000858', quantity: 200, cost_price: 135 },
    ])
  })

  it('reports invalid values and duplicate codes without silently importing them', () => {
    const result = parseHoldingsImport([
      'ticker,quantity,cost_price',
      '600519,100,1500',
      '600519,20,1600',
      '000858,0,135',
    ].join('\n'))

    expect(result.items).toEqual([{ ticker: '600519', quantity: 100, cost_price: 1500 }])
    expect(result.errors).toEqual([
      '第 3 行：股票代码 600519 重复。',
      '第 4 行：数量必须大于 0。',
    ])
  })

  it('rejects embedded or overlong stock codes and non-positive costs', () => {
    const result = parseHoldingsImport([
      'ticker,quantity,cost_price',
      'abc600519xyz,100,1500',
      '1234567,100,20',
      '000858,100,0',
    ].join('\n'))

    expect(result.items).toEqual([])
    expect(result.errors).toEqual([
      '第 2 行：股票代码“abc600519xyz”无效。',
      '第 3 行：股票代码“1234567”无效。',
      '第 4 行：成本价必须大于 0。',
    ])
  })
})
