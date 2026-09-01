import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import css from './InvestmentShell.module.css'
import { asRecord, productErrorText, records, text } from './data.ts'
import { createResearchResourceStore } from './research-resource.ts'
import type { ResearchResourceSnapshot, ResearchResourceStore } from './research-resource.ts'
import type { RequestData } from './research-types.ts'

const MARKET_NEWS_LIMIT = 12
const MARKET_NEWS_KEY = JSON.stringify({
  operation: 'market-watch.news-flash',
  limit: MARKET_NEWS_LIMIT,
  enrich: false,
  personal: false,
})

export interface MarketNewsPanelProps {
  readonly requestData: RequestData
  readonly active?: boolean
  readonly refreshNonce?: number
}

function useResourceSnapshot<T>(
  resources: ResearchResourceStore,
  key: string,
): ResearchResourceSnapshot<T> {
  const subscribe = useCallback(
    (listener: () => void) => resources.subscribe(key, listener),
    [key, resources],
  )
  const getSnapshot = useCallback(
    () => resources.getSnapshot<T>(key),
    [key, resources],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function statusOf(value: unknown): string {
  const record = asRecord(value)
  return typeof record.status === 'string'
    ? record.status
    : Object.keys(record).length === 0 ? '' : 'ready'
}

function factTime(value: unknown, fallback?: string): string {
  const candidate = asRecord(value).as_of
  return typeof candidate === 'string' && candidate.trim() !== ''
    ? candidate.trim()
    : fallback?.trim() ?? ''
}

function newsItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? records(value) : records(asRecord(value).items)
}

function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

export function MarketNewsPanel({
  requestData,
  active = true,
  refreshNonce = 0,
}: MarketNewsPanelProps) {
  const [resources] = useState(() => createResearchResourceStore())
  const snapshot = useResourceSnapshot<unknown>(resources, MARKET_NEWS_KEY)
  const load = useCallback(
    () => requestData({
      operation: 'market-watch.news-flash',
      input: { limit: MARKET_NEWS_LIMIT, enrich: false, personal: false },
    }),
    [requestData],
  )
  const activate = useCallback((): void => {
    const current = resources.getSnapshot(MARKET_NEWS_KEY)
    const flight = current.value === undefined
      ? resources.read(MARKET_NEWS_KEY, load)
      : resources.revalidate(MARKET_NEWS_KEY, load)
    void flight.catch(() => {})
  }, [load, resources])

  useEffect(() => {
    if (active) activate()
  }, [active, activate, refreshNonce])

  const status = statusOf(snapshot.value)
  const items = newsItems(snapshot.value)
  const stale = snapshot.phase === 'stale' || status === 'stale' || asRecord(snapshot.value).stale === true
  const unavailable = status === 'unavailable'
    || (snapshot.phase === 'unavailable' && snapshot.value === undefined)
  const error = status === 'unavailable'
    ? text(asRecord(snapshot.value).message, '市场资讯源暂不可用。')
    : snapshot.error
  const busy = snapshot.phase === 'preparing' || snapshot.phase === 'refreshing'

  return (
    <section
      className={css.marketNewsPanel}
      role="region"
      aria-labelledby="market-news-title"
      aria-busy={busy || undefined}
    >
      <div className={css.sectionHeading}>
        <div><strong id="market-news-title">市场资讯</strong><small>全市场快讯</small></div>
        {stale && <span>缓存 · {factTime(snapshot.value, snapshot.asOf) || '原时间未知'}</span>}
      </div>
      {unavailable && (
        <div className={css.researchContentAlert} role="alert">
          <div><strong>市场资讯暂不可用</strong><p>{productErrorText(error)}</p></div>
          <button type="button" aria-busy={busy || undefined} disabled={!active || busy} onClick={activate}>重试市场资讯</button>
        </div>
      )}
      {!unavailable && snapshot.value === undefined && <div className={css.researchContentPreparing} role="status">正在加载市场资讯</div>}
      {items.length > 0 && (
        <div className={css.researchNewsList} data-market-news-scroll>
          {items.map((item, index) => {
            const title = text(item.title, text(item.summary, '资讯'))
            const source = text(item.source, text(item.tag, '资讯源'))
            const timestamp = text(item.time, text(item.ts, ''))
            const url = safeExternalUrl(item.url)
            return (
              <article className={css.researchNewsItem} key={text(item.id, `${title}-${index}`)}>
                <div>
                  {url === undefined
                    ? <strong>{title}</strong>
                    : <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${title}（打开原文）`}><strong>{title}</strong><span aria-hidden="true">↗</span></a>}
                  <small>{source}{url === undefined ? ' · 暂无原文链接' : ' · 原文'}</small>
                </div>
                {timestamp !== '' && <time>{timestamp}</time>}
              </article>
            )
          })}
        </div>
      )}
      {!unavailable && snapshot.value !== undefined && items.length === 0 && <p className={css.researchContentEmpty}>当前暂无市场快讯</p>}
    </section>
  )
}
