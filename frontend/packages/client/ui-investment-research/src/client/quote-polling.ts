import { useEffect, useMemo, useRef } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import {
  QUOTE_REFRESH_MS, QUOTE_RETRY_MAX, QUOTE_RETRY_MS, asRecord, records, text,
} from './data.ts'

interface QuoteRunner {
  run: (request: InvestmentDataRequest) => void
  state: { readonly phase: string }
}

/**
 * 持仓实时行情批量拉取：60s 轮询 + 失败快速重试。
 * 后端报价源（东财 push2 间歇断连 → 新浪补位 → 最近成功价兜底）仍可能整批失败，
 * 这里在 60s 周期内补一次短间隔重试；连续失败有上限（QUOTE_RETRY_MAX），
 * 后端宕机时不至于把请求打爆，等待下个周期自愈。
 */
export function useQuotePolling(
  quotes: QuoteRunner,
  holdingsValue: unknown,
  refreshTick: unknown,
): void {
  const positionCodesKey = useMemo(() => {
    const items = records(asRecord(holdingsValue).items)
    return [...new Set(items
      .map(item => text(item.ticker, ''))
      .filter(code => /^\d{6}$/.test(code)))]
      .sort()
      .join(',')
  }, [holdingsValue])

  useEffect(() => {
    if (positionCodesKey === '') return
    const codes = positionCodesKey.split(',')
    const refresh = () => quotes.run({ operation: 'market-watch.quotes-batch', input: { codes } })
    refresh()
    const timer = setInterval(refresh, QUOTE_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [refreshTick, positionCodesKey, quotes.run])

  // 失败快速重试。resource run() 每次都会把 phase 先置为 loading，所以计数只在
  // success 时清零：持续故障时快速重试 QUOTE_RETRY_MAX 次后回落 60s 周期，
  // 恢复成功即重置，下一轮短暂故障可再次获得快速重试。
  const errorRetries = useRef(0)
  useEffect(() => {
    if (positionCodesKey === '') return
    if (quotes.state.phase === 'success') { errorRetries.current = 0; return }
    if (quotes.state.phase !== 'error') return
    if (errorRetries.current >= QUOTE_RETRY_MAX) return
    errorRetries.current += 1
    const retry = () => quotes.run({ operation: 'market-watch.quotes-batch', input: { codes: positionCodesKey.split(',') } })
    const timer = setTimeout(retry, QUOTE_RETRY_MS)
    return () => { clearTimeout(timer) }
  }, [quotes.state.phase, positionCodesKey, quotes.run])
}
