import { describe, expect, it } from 'vitest'
import { productErrorText, unitCost } from '../src/client/data.ts'

it('shows unit cost to three decimals when needed and groups large values', () => {
  expect(unitCost(36.712)).toBe('¥36.712')
  expect(unitCost(36.7)).toBe('¥36.70')
  expect(unitCost(36712)).toBe('¥36,712.00')
  expect(unitCost(undefined)).toBe('—')
})

describe('产品错误文案', () => {
  it('保留可行动的业务错误并提取安全的后端 detail', () => {
    expect(productErrorText(new Error('当前没有满足条件的策略')))
      .toBe('当前没有满足条件的策略')
    expect(productErrorText(new Error(
      'investment data: industry-chain.company failed with HTTP 404: {"detail":"未找到公司 000000"}',
    ))).toBe('未找到公司 000000')
    expect(productErrorText(new Error(
      'investment Runtime Client: request-data failed: remote-rejected: 历史行情暂不可用，请稍后重试：000001 历史行情获取失败',
    ))).toBe('历史行情暂不可用，请稍后重试：000001 历史行情获取失败')
  })

  it('隐藏地址、本地路径、运行日志和堆栈', () => {
    const fallback = '数据服务暂不可用，请稍后重试。'
    expect(productErrorText(new Error('fetch http://127.0.0.1:8200 failed'))).toBe(fallback)
    expect(productErrorText(new Error('Runtime log: /Users/example/private/runtime.log'))).toBe(fallback)
    expect(productErrorText(new Error('Traceback at handler (/private/tmp/app.py:2)'))).toBe(fallback)
    expect(productErrorText(new Error(
      'investment Runtime Client: request-data failed: internal: Remote operation failed',
    ))).toBe(fallback)
  })
})
