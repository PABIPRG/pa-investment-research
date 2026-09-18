import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, records, text } from './data.ts'

export interface SecuritySearchItem {
  readonly code: string
  readonly name: string
  readonly market: string
}

/** 复用全局证券搜索的数据契约；选择后提交 code，名称只用于展示。 */
export async function searchSecurities(requestData: (request: InvestmentDataRequest) => Promise<unknown>, query: string): Promise<SecuritySearchItem[]> {
  const value = await requestData({ operation: 'market-watch.security-search', input: { query, limit: 8 } })
  return records(asRecord(value).items).flatMap(item => {
    const code = text(item.code, '')
    return code === '' ? [] : [{ code, name: text(item.name, code), market: text(item.market, '') }]
  })
}
