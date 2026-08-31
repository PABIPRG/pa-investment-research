// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useCallback, useRef, useState } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { useQuotePolling } from '../src/client/quote-polling.ts'

// 缩小轮询/重试间隔便于真实计时器快速断言；上限保持 2 次。
const timing = vi.hoisted(() => ({
  QUOTE_REFRESH_MS: 1000,
  QUOTE_RETRY_MS: 30,
  QUOTE_RETRY_MAX: 2,
}))
vi.mock('../src/client/data.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/data.ts')>()),
  QUOTE_REFRESH_MS: timing.QUOTE_REFRESH_MS,
  QUOTE_RETRY_MS: timing.QUOTE_RETRY_MS,
  QUOTE_RETRY_MAX: timing.QUOTE_RETRY_MAX,
}))

afterEach(() => {
  cleanup()
})

/** 模拟 resource：run 先置 loading，再按 mode 稍后（独立 macrotask）settle。
 * 延迟必须跨 macrotask，否则 'loading' 与 settle 被 React 批合成同一渲染，
 * phase 无 'loading'→'error' 过渡，重试 effect 依赖不变而不再触发。 */
function Harness(props: {
  holdings: unknown
  tick: number
  mode: () => 'success' | 'error'
  onRun: (request: InvestmentDataRequest) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const modeRef = useRef(props.mode)
  modeRef.current = props.mode
  const run = useCallback((request: InvestmentDataRequest) => {
    props.onRun(request)
    setPhase('loading')
    void new Promise<void>(resolve => setTimeout(resolve, 5)).then(() => {
      setPhase(modeRef.current() === 'success' ? 'success' : 'error')
    })
  }, [props.onRun])
  useQuotePolling({ run, state: { phase } }, props.holdings, props.tick)
  return null
}

describe('useQuotePolling', () => {
  it('空持仓不发起行情请求', async () => {
    const onRun = vi.fn()
    render(<Harness holdings={{ items: [] }} tick={0} mode={() => 'success'} onRun={onRun} />)

    await new Promise(resolve => setTimeout(resolve, timing.QUOTE_REFRESH_MS + 50))
    expect(onRun).not.toHaveBeenCalled()
  })

  it('挂载即拉取、排序去重代码集、并按周期轮询', async () => {
    const onRun = vi.fn()
    render(<Harness
      holdings={{ items: [
        { ticker: '600519' }, { ticker: '000001' },
        { ticker: '600519' }, { ticker: 'not-a-code' },
      ] }}
      tick={0}
      mode={() => 'success'}
      onRun={onRun}
    />)

    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1))
    expect(onRun).toHaveBeenCalledWith({
      operation: 'market-watch.quotes-batch',
      input: { codes: ['000001', '600519'] },
    })

    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(2), { timeout: timing.QUOTE_REFRESH_MS * 2 })
  })

  it('失败后短间隔快速重试，达上限后回落周期轮询；成功后下一轮故障恢复快速重试', async () => {
    const onRun = vi.fn()
    const mode = { fn: (): 'success' | 'error' => 'error' }
    render(<Harness holdings={{ items: [{ ticker: '600519' }] }} tick={0} mode={() => mode.fn()} onRun={onRun} />)

    await waitFor(() => expect(onRun.mock.calls.length).toBe(1))              // 挂载拉取（失败）
    await waitFor(() => expect(onRun.mock.calls.length).toBe(2), { timeout: 500 }) // 快速重试 1
    await waitFor(() => expect(onRun.mock.calls.length).toBe(3), { timeout: 500 }) // 快速重试 2
    // 达上限：再多等重试窗口，不再有快速重试
    await new Promise(resolve => setTimeout(resolve, timing.QUOTE_RETRY_MS * 4))
    expect(onRun.mock.calls.length).toBe(3)

    // 提前切回成功，让下一轮轮询成功 → 计数清零，成功后无快速重试
    mode.fn = () => 'success'
    await waitFor(() => expect(onRun.mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: timing.QUOTE_REFRESH_MS * 2 })
    await waitFor(() => expect(onRun.mock.calls.length).toBe(4), { timeout: 50 })

    // 又失败：下一轮轮询失败后，快速重试恢复
    mode.fn = () => 'error'
    await waitFor(() => expect(onRun.mock.calls.length).toBeGreaterThanOrEqual(5), { timeout: timing.QUOTE_REFRESH_MS * 2 })
    await waitFor(() => expect(onRun.mock.calls.length).toBeGreaterThanOrEqual(6), { timeout: 500 })
  })
})
